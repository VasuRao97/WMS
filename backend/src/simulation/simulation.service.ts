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
// Levels/Depth are user-configurable (2026-09-06 — "add option to tell which
// level and depth" / "which kind of storage"), Aisles/Racks stay fixed —
// confirmed directly rather than making the whole layout configurable, since
// Level/Depth are what actually drive the interesting bin-suggestion
// behavior (lane depth, multi-level fill order) and a simple 3x3 grid is
// plenty to watch it work. Storage Type is restricted to the three rack
// types RACK_STORAGE_TYPES already names (SPR/Drive-in/ASRS) — the only ones
// suggestBin() has real logic for; Ground/Floor and Stillage would just
// always come back "needs bin" today (see [[wms-putaway-design]]'s open
// list), so offering them here would be actively misleading. Capped well
// under anything that would make the layout slow to render or awkward to
// look at in the Plan View.
const MAX_LEVELS = 10;
const MAX_DEPTH = 6;
const SKU_POOL_SIZE = 12;
const MAX_UNIT_COUNT = 200;

export type SandboxLayoutConfig = { storageType: string; levels: number; depth: number };

function normalizeLayoutConfig(raw: Partial<SandboxLayoutConfig> | undefined): SandboxLayoutConfig {
  const storageType = raw?.storageType && RACK_STORAGE_TYPES.includes(raw.storageType) ? raw.storageType : DEFAULT_STORAGE_TYPE;
  const levels = Math.max(1, Math.min(MAX_LEVELS, Math.floor(Number(raw?.levels)) || DEFAULT_LEVELS));
  const depth = Math.max(1, Math.min(MAX_DEPTH, Math.floor(Number(raw?.depth)) || DEFAULT_DEPTH));
  return { storageType, levels, depth };
}

export type SimStep = {
  stepIndex: number;
  skuId: string;
  skuCode: string;
  abcClass: string;
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
      select: { storageType: true, level: true, depth: true },
    });

    if (existingLocations.length === 0) {
      await this.buildLayout(warehouse.id, category.id, normalizeLayoutConfig(desiredConfig));
    } else if (desiredConfig && !this.layoutMatches(existingLocations, normalizeLayoutConfig(desiredConfig))) {
      await this.rebuildLayout(warehouse.id, category.id, normalizeLayoutConfig(desiredConfig));
    }

    return warehouse;
  }

  // Whether the sandbox's CURRENT locations already match a requested
  // config — every row the same Storage Type, and the highest Level/Depth
  // number present equal to what's requested (the sandbox only ever holds
  // one shape at a time, so "the max present" is enough to characterize it,
  // no need to check every individual row for a gap).
  private layoutMatches(locations: { storageType: string; level: string | null; depth: number | null }[], config: SandboxLayoutConfig): boolean {
    if (locations.length === 0) return false;
    if (locations.some((l) => l.storageType !== config.storageType)) return false;
    const maxLevel = Math.max(...locations.map((l) => Number(l.level) || 1));
    const maxDepth = Math.max(...locations.map((l) => l.depth ?? 1));
    return maxLevel === config.levels && maxDepth === config.depth;
  }

  // Builds the sandbox's Rack layout fresh — Aisles/Racks fixed at
  // DEFAULT_AISLES x DEFAULT_RACKS, Levels/Depth from `config`. A Depth > 1
  // generates one row per depth position per (aisle, rack, level), same
  // "one real row per real position, not text-in-one-box" convention
  // LocationsService.generate() itself uses for a multi-deep lane — this is
  // what actually lets a Drive-in configuration exercise its own
  // deepest-tier-first fill order for real.
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

    const rows: any[] = [];
    for (let aisle = 1; aisle <= DEFAULT_AISLES; aisle++) {
      for (let rack = 1; rack <= DEFAULT_RACKS; rack++) {
        for (let level = 1; level <= config.levels; level++) {
          for (let depth = 1; depth <= config.depth; depth++) {
            const aisleStr = String(aisle);
            const rackStr = String(rack).padStart(2, '0');
            const depthSuffix = config.depth > 1 ? `-D${depth}` : '';
            rows.push({
              warehouseId,
              code: `${aisleStr}-R${rackStr}-L${String(level).padStart(2, '0')}-B1${depthSuffix}`,
              zoneType: 'ACTUAL_STORAGE',
              storageType: config.storageType,
              categoryId,
              aisle: aisleStr,
              rack: rackStr,
              level: String(level),
              bin: '1',
              depth: config.depth > 1 ? depth : undefined,
              flankNumber: aisle, // one flank per aisle — a simple single-sided default layout is enough to watch the algorithm work
            });
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
  private async ensureSkuPool(user: any, categoryId: string) {
    const existing = await this.prisma.sku.findMany({
      where: { companyId: user.companyId, code: { startsWith: SIM_SKU_PREFIX } },
      select: { id: true, code: true, abcClass: true },
    });
    const classes = ['A', 'B', 'C'] as const;
    const toCreate = SKU_POOL_SIZE - existing.length;
    for (let i = 0; i < toCreate; i++) {
      const n = existing.length + i + 1;
      const cls = classes[n % 3];
      const sku = await this.prisma.sku.create({
        data: {
          companyId: user.companyId,
          code: `${SIM_SKU_PREFIX}${cls}${n}`,
          description: `Simulated SKU ${cls}${n}`,
          categoryId,
          abcClass: cls,
          baseUom: 'PIECE',
          hsnCode: '0000',
          storageUnits: { create: [{ unitType: 'EACH', qtyInBaseUom: 1, isPreferred: true }] },
        },
      });
      existing.push({ id: sku.id, code: sku.code, abcClass: sku.abcClass });
    }
    return this.prisma.sku.findMany({
      where: { companyId: user.companyId, code: { startsWith: SIM_SKU_PREFIX } },
      include: { category: { select: { name: true } } },
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
    const pool = await this.ensureSkuPool(user, category!.id);

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
