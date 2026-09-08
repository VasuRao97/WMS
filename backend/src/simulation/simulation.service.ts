import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PutawayTasksService } from '../putaway/putaway-tasks.service';
import { RACK_STORAGE_TYPES, buildRackName } from '../common/rack-name.util';

// Putaway simulation (2026-09-06 — see [[wms-putaway-design]] in memory) —
// "can we have a simulation for me to check our visuals? which uses our
// algo/logic to fill in racks." A real, first-class use of this codebase's
// own actual `PutawayTasksService.suggestBin()` (never a reimplementation)
// against a batch of synthetic, auto-generated SKUs, run in one server-side
// pass and returned as an ORDERED step list — the frontend animates through
// it client-side (speed-adjustable), it never drives the algorithm step by
// step over the network. Confirmed directly: synthetic data (not real
// historical replay), a dedicated SANDBOX warehouse (never a real one —
// same safety principle as this project's own throwaway-company testing
// habit), auto-generated SKUs (not manually configured each run), Putaway
// first, Pick Face simulation deferred to a later pass.
//
// No new schema at all — the sandbox is just an ordinary `Warehouse` row,
// found/created by a well-known per-company code (`SIM-SANDBOX`); synthetic
// SKUs are tagged by a `SIM-` code prefix. Both are plain data conventions,
// not new fields, so nothing else in the app needs to know this is a
// simulation — it's a completely normal warehouse to every other feature.
const SANDBOX_CODE = 'SIM-SANDBOX';
const SIM_SKU_PREFIX = 'SIM-';
const SIM_CATEGORY_NAME = 'Simulation';
const DEFAULT_AISLES = 3;
const DEFAULT_RACKS = 3;
const DEFAULT_LEVELS = 3;
const DEFAULT_DEPTH = 1;
const DEFAULT_STORAGE_TYPE = 'SPR';
// Levels/Depth/Racks ("Length" in the UI) are all user-configurable
// (2026-09-06 — "add option to tell which level and depth" / "which kind of
// storage", then a same-day follow-up: "add feature of length also, just 3
// is too less") — Aisles alone stays fixed, since nothing was asked about
// it and 3 aisles is already plenty to exercise the slicer/multi-aisle
// pieces of the Plan View. Storage Type is restricted to SIM_STORAGE_TYPES
// (SPR/Drive-in/ASRS/Ground-Floor) -- the only ones suggestBin() has real
// placement logic for; Stillage would still always come back "needs bin"
// today (see [[wms-putaway-design]]'s open list), so it's deliberately not
// offered here -- would be actively misleading. Capped well under anything
// that would make the layout slow to render or awkward to look at in the
// Plan View.
const MAX_LEVELS = 10;
const MAX_DEPTH = 6;
const MAX_RACKS = 30;
// Ground/Floor only (2026-09-07) — how many bins stack back-to-back in the
// depth direction on ONE side before reaching the aisle, matching the real
// generator's own Depth Tiers field. Default/unset means 1 (today's
// unchanged behavior). Capped modestly — this multiplies total row count
// by itself, same "keep the sandbox fast to render" reasoning MAX_DEPTH
// etc. already follow.
const MAX_DEPTH_TIERS = 4;
const SKU_POOL_SIZE = 12;
const MAX_UNIT_COUNT = 200;

// `racks` is the internal/schema name (matches `Location.rack`) for what the
// UI calls "Length" — how many rack positions run down one flank of an
// aisle, i.e. how long the aisle actually is. 2026-09-06 — Ground/Floor
// added as a 4th selectable storage type (see [[wms-putaway-design]] for
// the full Ground design), reusing these SAME three fields with different
// meanings rather than adding new ones — same "meaning depends on
// storageType" convention this codebase already uses everywhere else
// (Location.rack/depth/width themselves): for GROUND_FLOOR, `racks`
// ("Length" in the UI) becomes how many BINS run down one flank, `levels`
// becomes how many COLUMNS each bin has (relabeled "Width" in the UI), and
// `depth` keeps its exact same meaning — positions per column, same LIFO
// depth concept Rack already uses it for.
export type SandboxLayoutConfig = { storageType: string; levels: number; depth: number; racks: number; depthTiers: number };

const SIM_STORAGE_TYPES = [...RACK_STORAGE_TYPES, 'GROUND_FLOOR'];

function normalizeLayoutConfig(raw: Partial<SandboxLayoutConfig> | undefined): SandboxLayoutConfig {
  const storageType = raw?.storageType && SIM_STORAGE_TYPES.includes(raw.storageType) ? raw.storageType : DEFAULT_STORAGE_TYPE;
  const levels = Math.max(1, Math.min(MAX_LEVELS, Math.floor(Number(raw?.levels)) || DEFAULT_LEVELS));
  const depth = Math.max(1, Math.min(MAX_DEPTH, Math.floor(Number(raw?.depth)) || DEFAULT_DEPTH));
  const racks = Math.max(1, Math.min(MAX_RACKS, Math.floor(Number(raw?.racks)) || DEFAULT_RACKS));
  // Only meaningful for GROUND_FLOOR — always normalized to a real number
  // regardless of storageType so callers never need a null-check, but a
  // Rack/ASRS/Drive-in config just never reads it (buildRackLayout doesn't
  // accept it at all).
  const depthTiers = Math.max(1, Math.min(MAX_DEPTH_TIERS, Math.floor(Number(raw?.depthTiers)) || 1));
  return { storageType, levels, depth, racks, depthTiers };
}

export type SimStep = {
  stepIndex: number;
  skuId: string;
  skuCode: string;
  abcClass: string;
  // FMS (2026-09-08) — null when the pool SKU somehow has no
  // SkuWarehouseClass row for this warehouse (shouldn't happen once
  // ensureSkuPool's own backfill runs, but the type stays honest either
  // way, same as the real occupancy overlay's own fmsClass field).
  fmsClass: string | null;
  categoryId: string;
  categoryName: string;
  quantity: number;
  locationId: string | null;
  locationCode: string | null;
  rackName: string | null;
  needsBin: boolean;
};

@Injectable()
export class SimulationService {
  constructor(
    private prisma: PrismaService,
    private putawayTasks: PutawayTasksService,
  ) {}

  // Finds or creates this company's one sandbox warehouse and its Simulation
  // category — lazily, on first use, so "click Run" works with zero manual
  // setup. Idempotent: calling this again once everything already exists
  // just returns the existing warehouse untouched.
  //
  // `desiredConfig` is optional and drives the Layout config (Storage Type/
  // Levels/Depth, 2026-09-06 — "add option to tell which level and depth" /
  // "which kind of storage"): omitted entirely (plain page-load bootstrap),
  // this only ever BUILDS a layout if none exists yet (defaults), never
  // touches an existing one no matter its shape — so reloading the page
  // never silently wipes a layout you already ran a simulation against.
  // Passed explicitly (only ever from runPutawaySimulation, carrying
  // whatever the Run form currently has selected): if no layout exists yet,
  // builds fresh using it; if one exists but doesn't match (different
  // Storage Type, or a different Level/Depth count), wipes and rebuilds to
  // match — confirmed directly as the wanted behavior, one Run click covers
  // both "try a different shape" and "just run again," no separate rebuild
  // step. A matching layout is left completely untouched either way.
  //
  // Written to be safe under concurrent calls (React's StrictMode double-
  // invokes effects in dev, and nothing stops two browser tabs hitting this
  // at once either) — a real race was caught during verification: two
  // near-simultaneous first-ever calls both saw "no sandbox yet" and both
  // tried to create one, and the loser got a raw unique-constraint 500
  // instead of just quietly finding what the winner had already made.
  // `upsert`/`skipDuplicates` make "already exists" a normal, silent
  // outcome instead of an error to catch.
  async ensureSandbox(user: any, desiredConfig?: Partial<SandboxLayoutConfig>) {
    const companyId = user.companyId;
    const warehouse = await this.prisma.warehouse.upsert({
      where: { companyId_code: { companyId, code: SANDBOX_CODE } },
      update: {},
      create: { companyId, code: SANDBOX_CODE, name: 'Simulation Sandbox', nodeType: 'FACTORY' },
    });

    const category = await this.prisma.productCategory.upsert({
      where: { name: SIM_CATEGORY_NAME },
      update: {},
      create: { name: SIM_CATEGORY_NAME },
    });

    const existingLocations = await this.prisma.location.findMany({
      where: { warehouseId: warehouse.id },
      select: { storageType: true, level: true, depth: true, flankNumber: true, rack: true, block: true, depthTier: true },
    });

    if (existingLocations.length === 0) {
      await this.buildLayout(warehouse.id, category.id, normalizeLayoutConfig(desiredConfig));
    } else if (desiredConfig && !this.layoutMatches(existingLocations, normalizeLayoutConfig(desiredConfig))) {
      await this.rebuildLayout(warehouse.id, category.id, normalizeLayoutConfig(desiredConfig));
    }

    return warehouse;
  }

  // Whether the sandbox's CURRENT locations already match a requested
  // config — every row the same Storage Type, the highest Level/Depth/Rack
  // ("Length") number present equal to what's requested, and BOTH flanks
  // present per aisle (DEFAULT_AISLES * 2 distinct flankNumbers — see
  // buildLayout()'s comment) rather than the old single-flank shape
  // (2026-09-06 fix, see below) — so a sandbox built before that fix
  // correctly rebuilds itself the next time Run is clicked, the same
  // auto-rebuild-on-mismatch path every other config change already goes
  // through, no separate migration.
  private layoutMatches(
    locations: { storageType: string; level: string | null; depth: number | null; flankNumber: number | null; rack: string | null; block: string | null; depthTier: number | null }[],
    config: SandboxLayoutConfig,
  ): boolean {
    if (locations.length === 0) return false;
    if (locations.some((l) => l.storageType !== config.storageType)) return false;
    const flankCount = new Set(locations.map((l) => l.flankNumber)).size;
    if (flankCount !== DEFAULT_AISLES * 2) return false;
    // Deliberately separate branches, not one shared shape-check — Ground's
    // three dimensions (bins/columns/depth) don't map onto Rack's
    // (racks/levels/depth) the same way, even though both REUSE the exact
    // same three config fields underneath (see SandboxLayoutConfig's
    // comment).
    if (config.storageType === 'GROUND_FLOOR') return this.groundLayoutMatches(locations, config);
    return this.rackLayoutMatches(locations, config);
  }

  private rackLayoutMatches(locations: { level: string | null; depth: number | null; rack: string | null }[], config: SandboxLayoutConfig): boolean {
    const maxLevel = Math.max(...locations.map((l) => Number(l.level) || 1));
    const maxDepth = Math.max(...locations.map((l) => l.depth ?? 1));
    const maxRack = Math.max(...locations.map((l) => parseInt(l.rack ?? '1', 10) || 1));
    return maxLevel === config.levels && maxDepth === config.depth && maxRack === config.racks;
  }

  private groundLayoutMatches(locations: { depth: number | null; rack: string | null; block: string | null; depthTier: number | null }[], config: SandboxLayoutConfig): boolean {
    const maxColumn = Math.max(...locations.map((l) => parseInt(l.rack ?? '1', 10) || 1));
    const maxDepth = Math.max(...locations.map((l) => l.depth ?? 1));
    const maxBin = Math.max(...locations.map((l) => parseInt(l.block ?? '1', 10) || 1));
    const maxDepthTier = Math.max(...locations.map((l) => l.depthTier ?? 1));
    // config.racks ("Length" in the UI) = bins per flank, config.levels
    // (relabeled "Width" in the UI for Ground) = columns per bin — see
    // SandboxLayoutConfig's comment for the full field-reuse mapping.
    // maxDepthTier check (2026-09-07) so an existing sandbox built before
    // Depth Tiers was configurable (or with a different tier count)
    // correctly rebuilds itself the next time Run is clicked — same
    // auto-rebuild-on-mismatch path every other config dimension already
    // uses.
    return maxBin === config.racks && maxColumn === config.levels && maxDepth === config.depth && maxDepthTier === config.depthTiers;
  }

  // Builds the sandbox's Rack layout fresh — Aisles fixed at DEFAULT_AISLES,
  // Racks ("Length")/Levels/Depth all from `config`. A Depth > 1 generates
  // one row per depth position per (aisle, rack, level), same
  // "one real row per real position, not text-in-one-box" convention
  // LocationsService.generate() itself uses for a multi-deep lane — this is
  // what actually lets a Drive-in configuration exercise its own
  // deepest-tier-first fill order for real.
  //
  // BOTH flanks per aisle (2026-09-06 fix, caught live: "3 deep should be 3
  // deep from both sides of aisle... we corrected it in our layout
  // generator") — the real align-before-coding conversation behind
  // `LocationsService.resolveFlankNumber`/the "mirror same numbers on other
  // side" generator option established that a real aisle normally has racks
  // on BOTH sides, each independently as deep as the other. The sandbox's
  // very first version only ever built one flank per aisle (a deliberate
  // v1 simplification, documented as such at the time) — real enough to
  // exercise the algorithm's per-lane logic, but not a fair physical
  // picture once Depth became something worth actually looking at. Both
  // flanks here reuse the SAME rack numbers (the "mirror" convention, not
  // "continuous numbering") — simplest, and `flankNumber` already makes
  // them physically distinct lanes regardless of the shared numbers, same
  // as the real generator. `buildCode()`'s own suffix convention is
  // mirrored too: the secondary flank's code gets a `B` appended right
  // after the rack segment, so codes stay unique despite reusing numbers.
  private async buildLayout(warehouseId: string, categoryId: string, config: SandboxLayoutConfig) {
    const existingStorageType = await this.prisma.warehouseStorageType.findFirst({
      where: { warehouseId, storageType: config.storageType, categoryId },
    });
    if (!existingStorageType) {
      try {
        await this.prisma.warehouseStorageType.create({
          data: { warehouseId, storageType: config.storageType, categoryId, palletPositions: 1000 },
        });
      } catch {
        // A concurrent call already created the same row between our check
        // and this create — the row existing is all that matters here, not
        // which request made it.
      }
    }

    // Deliberately separate methods, not one shared row-building loop with
    // a storageType branch threaded through it — same discipline
    // suggestBin() itself now follows (suggestRackBin()/suggestGroundBin(),
    // see [[wms-putaway-design]]), applied here too since the sandbox's own
    // layout needs to be just as physically honest as the real generator.
    if (config.storageType === 'GROUND_FLOOR') {
      await this.buildGroundLayout(warehouseId, categoryId, config);
    } else {
      await this.buildRackLayout(warehouseId, categoryId, config);
    }
  }

  private async buildRackLayout(warehouseId: string, categoryId: string, config: SandboxLayoutConfig) {
    const rows: any[] = [];
    let nextFlankNumber = 0;
    for (let aisle = 1; aisle <= DEFAULT_AISLES; aisle++) {
      const aisleStr = String(aisle);
      const flanks: { flankNumber: number; isSecondary: boolean }[] = [
        { flankNumber: ++nextFlankNumber, isSecondary: false },
        { flankNumber: ++nextFlankNumber, isSecondary: true },
      ];
      for (const { flankNumber, isSecondary } of flanks) {
        const codeSuffix = isSecondary ? 'B' : '';
        for (let rack = 1; rack <= config.racks; rack++) {
          const rackStr = String(rack).padStart(2, '0');
          for (let level = 1; level <= config.levels; level++) {
            for (let depth = 1; depth <= config.depth; depth++) {
              const depthSuffix = config.depth > 1 ? `-D${depth}` : '';
              rows.push({
                warehouseId,
                code: `${aisleStr}-R${rackStr}${codeSuffix}-L${String(level).padStart(2, '0')}-B1${depthSuffix}`,
                zoneType: 'ACTUAL_STORAGE',
                storageType: config.storageType,
                categoryId,
                aisle: aisleStr,
                rack: rackStr,
                level: String(level),
                bin: '1',
                depth: config.depth > 1 ? depth : undefined,
                flankNumber,
              });
            }
          }
        }
      }
    }
    await this.prisma.location.createMany({ data: rows, skipDuplicates: true });
  }

  // Ground/Floor sandbox layout (2026-09-06 — see [[wms-putaway-design]]
  // for the full design) — one real row per pallet position, exactly the
  // same "one row per position" model LocationsService.generate() itself
  // uses for real Ground bins now, not the old aggregate-capacity shape.
  // config.racks ("Length" in the UI) = how many BINS run down one flank;
  // config.levels (relabeled "Width" in the UI for this storage type) =
  // how many COLUMNS each bin has; config.depth keeps its exact same
  // meaning as Rack — positions per column, front-to-back LIFO. Both
  // flanks per aisle, same mirrored convention buildRackLayout() already
  // uses (and the real generator itself uses for Ground bins).
  private async buildGroundLayout(warehouseId: string, categoryId: string, config: SandboxLayoutConfig) {
    const binsPerFlank = config.racks;
    const columnsPerBin = config.levels;
    const rows: any[] = [];
    let nextFlankNumber = 0;
    for (let aisle = 1; aisle <= DEFAULT_AISLES; aisle++) {
      const aisleStr = String(aisle);
      const flanks: { flankNumber: number; isSecondary: boolean }[] = [
        { flankNumber: ++nextFlankNumber, isSecondary: false },
        { flankNumber: ++nextFlankNumber, isSecondary: true },
      ];
      for (const { flankNumber, isSecondary } of flanks) {
        const codeSuffix = isSecondary ? 'B' : '';
        for (let bin = 1; bin <= binsPerFlank; bin++) {
          const blockStr = String(bin).padStart(2, '0');
          for (let column = 1; column <= columnsPerBin; column++) {
            // Depth Tiers (2026-09-07) — real client ask: "when we say 4
            // deep, there should be 1 more 4 deep behind the first bin
            // then the aisle." Each tier is its own separate bin, going
            // further from the aisle — depth restarts at 1 per tier
            // (matching the real generator's own Depth Tiers field
            // exactly), and the code only gets a `-T{n}` segment when
            // config.depthTiers > 1, so a plain single-tier sandbox stays
            // byte-identical to before this existed.
            for (let tier = 1; tier <= config.depthTiers; tier++) {
              const tierSuffix = config.depthTiers > 1 ? `-T${tier}` : '';
              for (let depth = 1; depth <= config.depth; depth++) {
                rows.push({
                  warehouseId,
                  code: `GF-${aisleStr}-BLK${blockStr}${codeSuffix}-C${column}${tierSuffix}-D${depth}`,
                  zoneType: 'ACTUAL_STORAGE',
                  storageType: 'GROUND_FLOOR',
                  categoryId,
                  aisle: aisleStr,
                  block: blockStr,
                  rack: String(column), // reused as column number, same as the real generator
                  depth,
                  width: columnsPerBin, // descriptive, same value on every row of this bin
                  height: 1,
                  flankNumber,
                  depthTier: config.depthTiers > 1 ? tier : undefined,
                });
              }
            }
          }
        }
      }
    }
    await this.prisma.location.createMany({ data: rows, skipDuplicates: true });
  }

  // Switching Storage Type/Levels/Depth means the EXISTING Location rows no
  // longer describe the requested shape at all (a Rack position's Level/
  // Depth is baked into the row itself, there's no in-place "resize") — so a
  // real rebuild wipes and starts over, same disposable-sandbox principle
  // Reset already uses for stock/SKUs, just extended to the layout too.
  // StockMovement rows referencing the old locations must go first (a real
  // FK, same reason resetSandbox already clears them); the WarehouseStorageType
  // row is also cleared and rebuilt fresh for the NEW storage type rather
  // than left stale (the sandbox only ever needs exactly one at a time).
  private async rebuildLayout(warehouseId: string, categoryId: string, config: SandboxLayoutConfig) {
    await this.prisma.stockMovement.deleteMany({ where: { warehouseId } });
    await this.prisma.location.deleteMany({ where: { warehouseId } });
    await this.prisma.warehouseStorageType.deleteMany({ where: { warehouseId } });
    await this.buildLayout(warehouseId, categoryId, config);
  }

  // Clears the sandbox's ledger and synthetic SKUs back to a blank slate —
  // the Location layout itself is left untouched (a user's own structural
  // customization via the normal Locations page shouldn't be wiped just to
  // rerun a scenario).
  async resetSandbox(user: any) {
    const warehouse = await this.ensureSandbox(user);
    await this.prisma.stockMovement.deleteMany({ where: { warehouseId: warehouse.id } });
    const skus = await this.prisma.sku.findMany({ where: { companyId: user.companyId, code: { startsWith: SIM_SKU_PREFIX } }, select: { id: true } });
    const skuIds = skus.map((s) => s.id);
    await this.prisma.skuBarcode.deleteMany({ where: { skuId: { in: skuIds } } });
    await this.prisma.skuStorageUnit.deleteMany({ where: { skuId: { in: skuIds } } });
    await this.prisma.sku.deleteMany({ where: { id: { in: skuIds } } });
    return { warehouseId: warehouse.id };
  }

  // Tops up this company's reusable pool of synthetic SKUs to SKU_POOL_SIZE
  // (never regenerated on every run — reusing the same pool across repeat
  // runs is deliberate, so the same SIM- codes keep meaning the same thing
  // from one run to the next while you compare results). An even spread of
  // A/B/C classes, all under the one Simulation category so every one of
  // them is eligible for the sandbox's own WarehouseStorageType row.
  private async ensureSkuPool(user: any, categoryId: string, warehouseId: string) {
    const existing = await this.prisma.sku.findMany({
      where: { companyId: user.companyId, code: { startsWith: SIM_SKU_PREFIX } },
      select: { id: true, code: true, abcClass: true },
    });
    const classes = ['A', 'B', 'C'] as const;
    const toCreate = SKU_POOL_SIZE - existing.length;
    for (let i = 0; i < toCreate; i++) {
      const n = existing.length + i + 1;
      const cls = classes[n % 3];
      const code = `${SIM_SKU_PREFIX}${cls}${n}`;
      // 2026-09-06 hardening-pass fix: same lazy-create race already found
      // and fixed once for the sandbox Warehouse/ProductCategory rows (see
      // ensureSandbox above) — two concurrent Run calls (a double-click, two
      // tabs, or React StrictMode's double-invoke in dev) could both see the
      // pool short by the same count and both try to create the same SIM-
      // code, the loser hitting a raw unique-constraint 500 instead of a
      // graceful no-op. upsert() (keyed on Sku's own companyId+code unique
      // constraint) makes "already exists" the normal outcome either way.
      const sku = await this.prisma.sku.upsert({
        where: { companyId_code: { companyId: user.companyId, code } },
        create: {
          companyId: user.companyId,
          code,
          description: `Simulated SKU ${cls}${n}`,
          categoryId,
          abcClass: cls,
          baseUom: 'PIECE',
          hsnCode: '0000',
          storageUnits: { create: [{ unitType: 'EACH', qtyInBaseUom: 1, isPreferred: true }] },
        },
        update: {},
      });
      existing.push({ id: sku.id, code: sku.code, abcClass: sku.abcClass });
    }

    // FMS (2026-09-08) — the ONLY place fmsClass can live is a
    // SkuWarehouseClass row (no manual/imported field for it the way
    // Sku.abcClass exists for ABC). Spread independently of each SKU's own
    // ABC class (offset mod-3 index) so the pool covers real combinations
    // (an A-class SKU that's also Fast, another A-class SKU that's Slow,
    // etc.) — the whole point of the FMS×ABC study was that the two axes
    // are independent, so the sandbox should actually demonstrate that, not
    // just always move in lockstep. Backfills EVERY pool SKU that's still
    // missing a row for this warehouse, not just ones created just now — a
    // sandbox that already existed before this feature (or before this
    // warehouse's current layout was built) would otherwise show blank FMS
    // colors forever, since the create-loop above only ever runs for
    // genuinely new SKUs. abcClass here matches the Sku row's own class,
    // deliberately — suggestBin() prefers a SkuWarehouseClass.abcClass when
    // present, so this keeps the sandbox's real placement behavior (which
    // class governs the aisle) unchanged; only fmsClass is new information.
    // dispatchedQty/orderCount are placeholders (0) — nothing here derives
    // from them, only abcClass/fmsClass matter to suggestBin().
    const fmsClasses = ['F', 'M', 'S'] as const;
    const currentClasses = await this.prisma.skuWarehouseClass.findMany({
      where: { warehouseId, skuId: { in: existing.map((s) => s.id) } },
      select: { skuId: true },
    });
    const alreadyHasClass = new Set(currentClasses.map((c) => c.skuId));
    for (let i = 0; i < existing.length; i++) {
      const sku = existing[i];
      if (alreadyHasClass.has(sku.id)) continue;
      // abcClass cycles every SKU (classes[n%3], n=i+1 at creation time); a
      // plain fmsClasses[(i+1)%3] would share that exact period-3 cadence
      // with a constant phase offset, which always locks onto only 3 of the
      // 9 possible ABC×FMS pairs no matter which offset is picked (two
      // period-3 sequences with a fixed relative phase can only ever trace
      // 3 distinct combinations — caught by the diagnostic script's own
      // "real ABC×FMS combinations" check, which failed the first version
      // of this formula). Changing FMS only every 3 SKUs (period 9 overall)
      // decorrelates it from ABC's own period-3 cadence, covering all 9
      // real combinations across the 12-SKU pool instead of just 3.
      const fmsCls = fmsClasses[Math.floor(i / 3) % 3];
      await this.prisma.skuWarehouseClass.upsert({
        where: { skuId_warehouseId: { skuId: sku.id, warehouseId } },
        update: {},
        create: { skuId: sku.id, warehouseId, abcClass: sku.abcClass || 'C', dispatchedQty: 0, fmsClass: fmsCls, orderCount: 0 },
      });
    }

    return this.prisma.sku.findMany({
      where: { companyId: user.companyId, code: { startsWith: SIM_SKU_PREFIX } },
      include: { category: { select: { name: true } }, warehouseClasses: { where: { warehouseId }, select: { fmsClass: true } } },
    });
  }

  // The real run: `unitCount` sequential Putaway placements against the
  // sandbox, each one a genuine call to `PutawayTasksService.suggestBin()`
  // — never a reimplementation or a canned answer — followed immediately by
  // a real StockMovement so the NEXT step's suggestion sees accurate
  // occupancy (lane-fullness preference, same-SKU top-up, class caps all
  // stay real). Deliberately skips PutawayTask/PutawayTrip and the
  // staging/claim/scan machinery entirely — those model the OPERATOR's
  // physical workflow, not the algorithm's placement decision, which is
  // the only thing this feature visualizes. One `PUTAWAY_IN` movement per
  // placed unit is enough to make occupancy real for suggestBin() to react
  // to; no matching `PUTAWAY_OUT` is written since there's no real staging
  // origin to balance against in a synthetic scenario, and the sandbox's
  // ledger is wholly disposable via Reset anyway.
  //
  // A run also has a mild same-SKU clustering bias (70% chance to repeat
  // the previous step's SKU) rather than a pure uniform-random draw each
  // step — closer to how a real truck actually unloads (several units of
  // one SKU in a row), and a better exercise of the same-SKU-top-up/
  // lane-fullness logic than fully independent random picks would be.
  async runPutawaySimulation(
    user: any,
    unitCountRaw: number,
    layoutConfig?: Partial<SandboxLayoutConfig>,
  ): Promise<{ warehouseId: string; steps: SimStep[] }> {
    const unitCount = Math.max(1, Math.min(MAX_UNIT_COUNT, Math.floor(Number(unitCountRaw) || 0) || 1));
    const warehouse = await this.ensureSandbox(user, layoutConfig);
    const category = await this.prisma.productCategory.findFirst({ where: { name: SIM_CATEGORY_NAME } });
    const pool = await this.ensureSkuPool(user, category!.id, warehouse.id);

    const steps: SimStep[] = [];
    let lastSkuIndex = -1;
    for (let i = 0; i < unitCount; i++) {
      let skuIndex: number;
      if (lastSkuIndex >= 0 && Math.random() < 0.7) {
        skuIndex = lastSkuIndex;
      } else {
        skuIndex = Math.floor(Math.random() * pool.length);
      }
      lastSkuIndex = skuIndex;
      const sku = pool[skuIndex];
      const quantity = 1 + Math.floor(Math.random() * 3);

      const locationId = await this.putawayTasks.suggestBin(this.prisma, {
        warehouseId: warehouse.id,
        skuId: sku.id,
        newStockDate: new Date(),
      });

      let locationCode: string | null = null;
      let rackName: string | null = null;
      if (locationId) {
        const location = await this.prisma.location.findUnique({ where: { id: locationId } });
        locationCode = location!.code;
        // Same formula the real Putaway task queue/Plan View use (see
        // common/rack-name.util.ts) — includes the -D{n} suffix, which
        // matters now that Depth is configurable: without it, every depth
        // position in a multi-deep lane would show an identical rackName.
        rackName = buildRackName(location) ?? locationCode;
        await this.prisma.stockMovement.create({
          data: {
            warehouseId: warehouse.id,
            skuId: sku.id,
            locationId,
            quantity,
            movementType: 'PUTAWAY_IN',
            referenceType: 'Simulation',
            referenceId: `sim-${Date.now()}-${i}`,
            createdById: user.userId,
            receivedDate: new Date(),
          },
        });
      }

      steps.push({
        stepIndex: i,
        skuId: sku.id,
        skuCode: sku.code,
        abcClass: (sku.abcClass || 'C').toUpperCase(),
        fmsClass: (sku as any).warehouseClasses?.[0]?.fmsClass ? (sku as any).warehouseClasses[0].fmsClass.toUpperCase() : null,
        categoryId: category!.id,
        categoryName: (sku as any).category?.name || SIM_CATEGORY_NAME,
        quantity,
        locationId,
        locationCode,
        rackName,
        needsBin: !locationId,
      });
    }

    return { warehouseId: warehouse.id, steps };
  }
}
