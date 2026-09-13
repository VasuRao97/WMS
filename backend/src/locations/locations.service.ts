import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { normalizeCode } from '../common/normalize.util';
import {
  type AuthUser,
  companyFilter,
  ownWarehouseIds,
  WAREHOUSE_SCOPED_ROLES,
} from '../common/tenant.util';
import { displayCode, RACK_STORAGE_TYPES } from '../common/rack-name.util';
import {
  buildOutboundProximityRanker,
  buildRowProximityRanker,
} from '../common/dock-zone.util';
import * as bwipjs from 'bwip-js';
import { ZipArchive } from 'archiver';

// Function tag (what a bin is FOR) — see schema.prisma's LocationZoneType enum
// and CLAUDE.md's Locations/Bins design-pass notes for the full reasoning.
const ZONE_TYPE_LABELS: Record<string, string> = {
  UNLOADING_STAGING: 'Unloading Staging',
  LOADING_STAGING: 'Loading Staging',
  ACTUAL_STORAGE: 'Actual Storage',
  FORWARD_PICK: 'Forward Pick Zone',
  PICK_FACE: 'Pick Face',
  PACKING_KITTING: 'Packing/Kitting',
  CROSS_DOCK: 'Cross-Dock',
  SLOB: 'SLOB',
  RETURNS: 'Returns',
  RE_PUTAWAY: 'Re-Putaway',
  QC_HOLD: 'QC Hold',
  TEMP_CONTROLLED_STORAGE: 'Temp-Controlled Storage',
  HAZMAT: 'Hazmat',
  DAMAGE_SCRAP: 'Damage & Scrap',
};
const ZONE_TYPE_VALUES = Object.keys(ZONE_TYPE_LABELS);

// How a bin is physically built. Free text (like WarehouseStorageType.storageType,
// not a Postgres enum) — deliberately excludes MIX, which only ever means
// "warehouse hasn't broken this down yet" at the capacity-planning level; a
// real physical bin is always concretely one of these five.
// ASRS removed 2026-09-13 — see common/rack-name.util.ts's own comment (the
// client's own call: real ASRS runs its own dedicated WCS/WES software).
const STORAGE_TYPE_LABELS: Record<string, string> = {
  GROUND_FLOOR: 'Ground/Floor',
  SPR: 'SPR',
  DRIVE_IN: 'Drive-in',
  STILLAGE: 'Stillage',
};
const STORAGE_TYPE_VALUES = Object.keys(STORAGE_TYPE_LABELS);
// RACK_STORAGE_TYPES itself now comes from common/rack-name.util.ts (imported
// above) — this file used to keep its own private copy of the exact same
// three values, a leftover from before that shared constant existed;
// consolidated 2026-09-06 (hardening pass) rather than left duplicated.

// Generation batches are capped so a mistyped range (e.g. "1-99999") fails
// fast with a clear message instead of hanging the request or the DB.
const MAX_GENERATE_BATCH = 2000;

// Expands one range-generator input into the list of values a field should
// take across the batch — "1-20" (or "01-20", padding preserved from
// whichever side has more digits) -> ['01', '02', ..., '20']; a bare value
// with no dash ("07") -> ['07'], a single fixed value repeated for every
// generated row; blank/undefined -> [undefined], meaning "don't set this
// field, let buildLocationFields's own default/optional handling apply."
function expandRange(input: any): (string | undefined)[] {
  if (input === undefined || input === null || String(input).trim() === '')
    return [undefined];
  const str = String(input).trim();
  const m = str.match(/^(\d+)\s*-\s*(\d+)$/);
  if (!m) return [str];
  const [, startStr, endStr] = m;
  const start = parseInt(startStr, 10);
  const end = parseInt(endStr, 10);
  const width = Math.max(startStr.length, endStr.length);
  const step = start <= end ? 1 : -1;
  const result: string[] = [];
  for (let i = start; step > 0 ? i <= end : i >= end; i += step) {
    result.push(String(i).padStart(width, '0'));
  }
  return result;
}

@Injectable()
export class LocationsService {
  constructor(private prisma: PrismaService) {}

  // Validates zoneType/storageType/warehouse-independent fields and builds
  // the cleaned identifier/dimension fields for whichever storage-type group
  // applies (rack vs ground vs stillage) — same "validate + build" shape as
  // WarehousesService.validateWarehouseData/resolveStorageTypes.
  private buildLocationFields(
    data: any,
    errors: string[],
  ): { zoneType: string; storageType: string; fields: Record<string, any> } {
    const zoneType = data.zoneType ? normalizeCode(data.zoneType) : '';
    if (!zoneType) errors.push('Zone Type is required.');
    else if (!ZONE_TYPE_VALUES.includes(zoneType)) {
      errors.push(
        `Zone Type must be one of: ${Object.values(ZONE_TYPE_LABELS).join(', ')}.`,
      );
    }

    const storageType = data.storageType ? normalizeCode(data.storageType) : '';
    if (!storageType) errors.push('Storage Type is required.');
    else if (!STORAGE_TYPE_VALUES.includes(storageType)) {
      errors.push(
        `Storage Type must be one of: ${Object.values(STORAGE_TYPE_LABELS).join(', ')} (not Mix — that value is warehouse-level planning only, never a real bin).`,
      );
    }

    const aisle = data.aisle ? String(data.aisle).trim() : '';
    if (!aisle) errors.push('Aisle is required.');
    const fields: Record<string, any> = { aisle: aisle || undefined };

    const numField = (
      key: string,
      label: string,
      required: boolean,
      fallback?: number,
    ) => {
      const v = data[key];
      if (v === undefined || v === null || v === '') {
        if (required)
          errors.push(`${label} is required for this Storage Type.`);
        else if (fallback !== undefined) fields[key] = fallback;
        return;
      }
      const n = Number(v);
      if (!Number.isInteger(n) || n <= 0)
        errors.push(`${label} must be a positive whole number.`);
      else fields[key] = n;
    };

    if (RACK_STORAGE_TYPES.includes(storageType)) {
      const rack = data.rack ? String(data.rack).trim() : '';
      const level = data.level ? String(data.level).trim() : '';
      if (!rack)
        errors.push('Rack is required for rack-based storage (SPR/Drive-in).');
      if (!level)
        errors.push('Level is required for rack-based storage (SPR/Drive-in).');
      fields.rack = rack || undefined;
      fields.level = level || undefined;
      fields.bin = data.bin ? String(data.bin).trim() : '1';
      numField('depth', 'Depth (position in a multi-deep lane)', false);
    } else if (storageType === 'GROUND_FLOOR') {
      const block = data.block ? String(data.block).trim() : '';
      if (!block) errors.push('Block is required for Ground/Floor storage.');
      fields.block = block || undefined;
      // 2026-09-06 Ground/Floor redesign (see wms-putaway-design memory) —
      // one row per pallet POSITION now, not one row per whole block. A
      // bin (`block`) subdivides into `width`-many COLUMNS, each a
      // single-file LIFO line `depth` positions deep — mechanically
      // identical to a Rack lane, just laid flat on the floor. `rack` is
      // REUSED as the column number within this bin (1..width) — same
      // "meaning depends on storageType" convention this model already
      // uses for depth/width/height; `depth` is reused with the EXACT SAME
      // meaning Rack's own multi-deep lanes already give it (this pallet's
      // position within its single-file line, 1=front/aisle-facing..N=
      // back). `width` describes the WHOLE bin (its total column count) —
      // required, but every row generated for the same block must carry
      // the same value (not enforced at the DB level, same "known
      // limitation, not a hard constraint" tier as several other cross-row
      // invariants in this model). `height` stays fixed at 1 — no vertical
      // pallet-on-pallet stacking on the ground, confirmed explicitly
      // ("all are on ground") — no longer accepted as an input at all.
      const column = data.rack ? String(data.rack).trim() : '';
      if (!column)
        errors.push(
          'Column number is required for Ground/Floor storage (which column, 1..width, within the bin).',
        );
      fields.rack = column || undefined;
      numField(
        'depth',
        "Depth (this pallet's position within its column)",
        true,
      );
      numField('width', 'Width (how many columns the whole bin has)', true);
      fields.height = 1;
      // Depth Tier (2026-09-07) — which stacked BIN, going away from the
      // aisle, this row belongs to (1 = nearest the walkway). A real client
      // ask: "when we say 4 deep, there should be 1 more 4 deep behind the
      // first bin then the aisle" — genuinely separate, independently-coded
      // bins chained in the depth direction on ONE side of one aisle, not
      // (as this model previously only offered) the mirrored flank of a
      // NEIGHBORING aisle standing in for that same "2 bins back to back"
      // appearance. Optional — omitted (undefined, not defaulted to 1
      // here) for the common single-tier case, so its own generated code
      // stays byte-identical to before this existed (see buildCode's own
      // `f.depthTier ? ... : null`).
      if (
        data.depthTier !== undefined &&
        data.depthTier !== null &&
        data.depthTier !== ''
      ) {
        const tier = Number(data.depthTier);
        if (!Number.isInteger(tier) || tier <= 0)
          errors.push('Depth Tier must be a positive whole number.');
        else fields.depthTier = tier;
      }
    } else if (storageType === 'STILLAGE') {
      const stack = data.stack ? String(data.stack).trim() : '';
      if (!stack) errors.push('Stack is required for Stillage storage.');
      fields.stack = stack || undefined;
      // 2026-09-13 redesign (see wms-putaway-design memory) — one row per
      // real stack-height POSITION now, not one row per whole bin. `rack`
      // is REUSED as the column number (1..width) — same "meaning depends
      // on storageType" convention Ground/Floor's own redesign already
      // uses; `depth` is reused with the exact same meaning Rack/Ground's
      // own multi-deep lanes already give it (this position's place within
      // its single-file column, 1=front/aisle-facing..N=back). `width`
      // describes the WHOLE bin (its total column count) — every row
      // generated for the same stack must carry the same value (not
      // enforced at the DB level, same "known limitation" tier as Ground's
      // own width invariant).
      const column = data.rack ? String(data.rack).trim() : '';
      if (!column)
        errors.push(
          'Column number is required for Stillage storage (which column, 1..width, within the stack).',
        );
      fields.rack = column || undefined;
      numField(
        'depth',
        "Depth (this position's place within its column)",
        false,
        1,
      );
      numField(
        'width',
        'Width (how many columns the whole stack has)',
        false,
        1,
      );
      numField('height', 'Height (stillages stacked at this position)', true);
    }

    return { zoneType, storageType, fields };
  }

  // `isSecondaryFlank` (computed per-row by resolveFlankNumber, see below —
  // never itself persisted, since flankNumber already conveys the same
  // information by comparison) distinguishes the two flanks of an aisle
  // when they reuse the SAME rack/block number — e.g. "mirror" both sides
  // with Rack 01-15 on each. The primary flank never gets a suffix
  // (existing codes are untouched); the secondary flank's letter is
  // appended right after the rack/block number so codes stay unique even
  // when the identifier itself is identical on both flanks.
  private buildCode(
    storageType: string,
    f: Record<string, any>,
    isSecondaryFlank: boolean,
  ): string {
    const suffix = isSecondaryFlank ? 'B' : '';
    if (RACK_STORAGE_TYPES.includes(storageType)) {
      return [
        f.aisle,
        f.rack ? `R${f.rack}${suffix}` : null,
        f.level ? `L${f.level}` : null,
        f.bin ? `B${f.bin}` : null,
        f.depth ? `D${f.depth}` : null,
      ]
        .filter(Boolean)
        .join('-');
    }
    if (storageType === 'GROUND_FLOOR') {
      // 2026-09-06 — one row per pallet position now (see buildLocationFields'
      // comment on this storageType), so the code needs to carry column
      // (`rack`, reused) and position-within-column (`depth`) to stay
      // unique per row, same reasoning Rack's own `-D{n}` suffix already
      // has for a multi-deep lane. `-T{n}` (2026-09-07) only appears when a
      // row genuinely has a depthTier set (omitted for the common
      // single-tier case) — see buildLocationFields' own comment on
      // Depth Tier for why.
      return [
        'GF',
        f.aisle,
        f.block ? `BLK${f.block}${suffix}` : null,
        f.rack ? `C${f.rack}` : null,
        f.depthTier ? `T${f.depthTier}` : null,
        f.depth ? `D${f.depth}` : null,
      ]
        .filter(Boolean)
        .join('-');
    }
    if (storageType === 'STILLAGE') {
      // 2026-09-13 — one row per real position now (see
      // buildLocationFields' comment on this storageType), so the code
      // needs to carry column (`rack`) and position-within-column
      // (`depth`) to stay unique per row, same reasoning Ground/Rack's own
      // `-C{n}`/`-D{n}` suffixes already have.
      return [
        'ST',
        f.aisle,
        f.stack,
        f.rack ? `C${f.rack}` : null,
        f.depth ? `D${f.depth}` : null,
      ]
        .filter(Boolean)
        .join('-');
    }
    return f.aisle || '';
  }

  // Same case-insensitive name resolution as WarehousesService.resolveStorageTypes
  // / CustomersService.resolveShipTos — Category stays optional here (unlike
  // Warehouse's storage-type breakdown, not every zone cares about a product
  // category, e.g. Staging/Cross-Dock), so a blank value just means "none",
  // no "Uncategorized" default forced on it.
  private async resolveCategory(
    categoryName: any,
    errors: string[],
  ): Promise<string | undefined> {
    if (!categoryName || !String(categoryName).trim()) return undefined;
    const category = await this.prisma.productCategory.findFirst({
      where: {
        name: { equals: String(categoryName).trim(), mode: 'insensitive' },
      },
    });
    if (!category) {
      errors.push(
        `Category "${categoryName}" not found — check the Product Category master list.`,
      );
      return undefined;
    }
    return category.id;
  }

  // Derived, not stored — same "always derived, never stored" philosophy as
  // on-hand stock. Rack bins, and Ground/Floor since its 2026-09-06
  // redesign, are both individually addressable (one row per real pallet
  // position) — capacity is implicitly 1, not shown. Stillage, since its
  // own 2026-09-13 redesign (see wms-putaway-design memory), is ALSO one
  // row per real position now — just a position that isn't itself fully
  // addressable further (cages stack directly on each other with no
  // per-layer access), so its capacity is `height` (how many stillages sit
  // at this exact position), not depth×width×height any more — that
  // formula was correct back when one row represented the WHOLE bin.
  private attachCapacity(loc: any) {
    const capacity =
      loc.storageType === 'STILLAGE' ? loc.height || 1 : undefined;
    return { ...loc, capacity };
  }

  private async assertWarehouseAccess(
    warehouseId: string,
    user: AuthUser,
    errors: string[],
  ) {
    const warehouse = await this.prisma.warehouse.findUnique({
      where: { id: warehouseId },
    });
    if (!warehouse) {
      errors.push('Warehouse not found.');
      return;
    }
    if (user.role !== 'SUPER_ADMIN' && warehouse.companyId !== user.companyId) {
      errors.push('You do not have access to this warehouse.');
      return;
    }
    if (WAREHOUSE_SCOPED_ROLES.includes(user.role)) {
      const ids = await ownWarehouseIds(this.prisma, user.userId);
      if (!ids.includes(warehouseId))
        errors.push(
          'You can only manage locations in your own assigned warehouse(s).',
        );
    }
  }

  // Section is a manually-typed physical section name with a hard 1:1
  // invariant against Aisle (unlike `zone`, a free label with no such rule)
  // — see schema.prisma's comment on Location.section. Enforced here, not
  // in the DB, since it's a lookup across existing rows rather than a
  // simple column constraint. Resolves to: the incoming value if this Aisle
  // has no established Section yet; the existing Section if the incoming
  // value is blank (auto-inherit, so you don't have to retype it on every
  // later batch for the same Aisle) or matches it case-insensitively; an
  // error if the incoming value genuinely conflicts with an established one.
  // `excludeId` lets update() re-check without a row matching itself.
  private async assertSectionConsistency(
    warehouseId: string,
    aisle: string,
    incomingSection: any,
    errors: string[],
    excludeId?: string,
  ): Promise<string | undefined> {
    const incoming = incomingSection ? String(incomingSection).trim() : '';
    const existing = await this.prisma.location.findFirst({
      where: {
        warehouseId,
        aisle,
        section: { not: null },
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      select: { section: true },
    });
    if (existing?.section) {
      if (
        incoming &&
        incoming.toUpperCase() !== existing.section.toUpperCase()
      ) {
        errors.push(
          `Aisle "${aisle}" is already assigned to Section "${existing.section}" — enter the same Section (or leave it blank to reuse it) rather than "${incoming}".`,
        );
        return undefined;
      }
      return existing.section;
    }
    return incoming || undefined;
  }

  // Next available flank number, warehouse-wide, never resetting and never
  // reusing/wasting a number — the max across every location already in
  // this warehouse (any aisle, any storage type), plus one, or 1 if none
  // exist yet. Deliberately simple (no dedicated counter/sequence table,
  // no row locking) — matches this codebase's existing risk tolerance for
  // uniqueness checks elsewhere (e.g. the code-collision check just below),
  // fine at this app's real usage pattern (one admin generating batches
  // sequentially through the UI, not true concurrent writers).
  private async nextFlankNumber(warehouseId: string): Promise<number> {
    const result = await this.prisma.location.aggregate({
      where: { warehouseId },
      _max: { flankNumber: true },
    });
    return (result._max.flankNumber ?? 0) + 1;
  }

  // Resolves which flank number a row belongs to, and whether it's the
  // primary or secondary flank of its Aisle (for buildCode's letter
  // suffix) — see schema.prisma's comment on Location.flankNumber for the
  // full design. Given an Aisle's existing distinct flank numbers (0, 1, or
  // 2 of them):
  // - Primary request (isSecondary false): reuse the lower existing number,
  //   or allocate a fresh one if this Aisle has none yet.
  // - Secondary request (isSecondary true): reuse the higher existing
  //   number if the Aisle already has two; otherwise allocate a fresh one
  //   (becomes the Aisle's second number, whatever the primary's turns out
  //   to be — their numbers only stay adjacent if the primary flank was
  //   fully built out before the secondary one is added, an operational
  //   convention, not something enforced here).
  //
  // Scoped to the SAME physical "flank family" as `storageType`, not the raw
  // Aisle string alone — a real bug caught 2026-09-06 via a client report
  // ("generated Ground locations, can't find them in the Plan View"): two
  // completely different physical structures (an SPR rack row and a Ground/
  // Floor block row) can legitimately both get typed under the same Aisle
  // code by mistake (or even on purpose, if a client just numbers aisles
  // sequentially without realizing the number needs to stay unique per
  // physical structure) — before this fix, the SECOND one generated silently
  // REUSED the first's flankNumber(s), so both storage types ended up
  // sharing one identity. LocationsPlanView.tsx/Locations3DView.tsx both
  // assume flankNumber uniquely identifies one physical flank (at most two
  // per Aisle) — sharing it between two unrelated storage types corrupts
  // that invariant, merging both types' rows into the same position slot and
  // garbling the render (this is what the client actually saw, not a missing
  // location — the Ground rows WERE there, just silently entangled with
  // pre-existing SPR rows at the same Aisle+position). Family, not exact
  // storageType, because RACK_STORAGE_TYPES (SPR/Drive-in/ASRS) genuinely DO
  // share one flank-numbering space today — a real aisle can mix rack
  // sub-types on the same physical row, and the Plan View already renders
  // them together via one `RACK_STORAGE_TYPES.includes()` check — only
  // Ground/Floor and Stillage need their own separate space.
  private flankFamilyFilter(storageType: string): { storageType: any } {
    if (RACK_STORAGE_TYPES.includes(storageType))
      return { storageType: { in: RACK_STORAGE_TYPES } };
    return { storageType };
  }

  // The actual guard rail the TNR8 bug above should have hit BEFORE any bad
  // data got written, not just a fix to what happens after the fact — the
  // client's own direct follow-up once that bug was explained ("should we
  // put a fix that if someone tries to superimpose 2 storage types we need
  // to say NO to it?"). Blocks writing a Location into an Aisle some OTHER,
  // conflicting flank family already occupies — same family (e.g. SPR next
  // to Drive-in) stays completely fine, only a genuine cross-family clash
  // (Rack vs Ground/Floor, or either vs Stillage) is refused. A hard block,
  // not a warning — this isn't a policy call a client might reasonably want
  // to override, it's the same class of physical impossibility as Drive-in's
  // single-SKU column rule (two unrelated structures cannot actually occupy
  // one Aisle identity in a real warehouse).
  //
  // `previousAisle` matters for `update()` specifically: TNR8's own real
  // data, once backfilled with correct non-colliding flank numbers, now
  // LEGITIMATELY has SPR and Ground/Floor coexisting under Aisle "1" side by
  // side — editing one of those pre-existing rows (its Aisle unchanged)
  // must not suddenly start failing just because a sibling row of a
  // different family already happens to live there. The check only fires
  // when the row's Aisle is actually CHANGING (including a brand-new row,
  // where `previousAisle` is undefined) — moving/creating into a genuinely
  // conflicting Aisle is exactly the mistake this exists to catch; leaving
  // an already-settled row where it already was never re-triggers it.
  private async assertNoConflictingFamily(
    warehouseId: string,
    aisle: string,
    storageType: string,
    previousAisle: string | undefined,
    errors: string[],
    excludeId?: string,
  ): Promise<void> {
    if (previousAisle === aisle) return;
    const conflict = await this.prisma.location.findFirst({
      where: {
        warehouseId,
        aisle,
        NOT: this.flankFamilyFilter(storageType),
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      select: { storageType: true },
    });
    if (conflict) {
      const existingLabel =
        STORAGE_TYPE_LABELS[conflict.storageType] ?? conflict.storageType;
      const incomingLabel = STORAGE_TYPE_LABELS[storageType] ?? storageType;
      errors.push(
        `Aisle "${aisle}" already has ${existingLabel} locations — a ${incomingLabel} location can't share the same Aisle number with a different physical storage structure. Use a different Aisle number for this batch.`,
      );
    }
  }

  private async resolveFlankNumber(
    warehouseId: string,
    aisle: string,
    storageType: string,
    isSecondary: boolean,
    excludeId?: string,
  ): Promise<{ flankNumber: number; isSecondaryFlank: boolean }> {
    const existing = await this.prisma.location.findMany({
      where: {
        warehouseId,
        aisle,
        flankNumber: { not: null },
        ...this.flankFamilyFilter(storageType),
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      select: { flankNumber: true },
      distinct: ['flankNumber'],
    });
    const nums = existing.map((e) => e.flankNumber!).sort((a, b) => a - b);
    if (!isSecondary) {
      if (nums.length > 0)
        return { flankNumber: nums[0], isSecondaryFlank: false };
      return {
        flankNumber: await this.nextFlankNumber(warehouseId),
        isSecondaryFlank: false,
      };
    }
    if (nums.length >= 2)
      return { flankNumber: nums[1], isSecondaryFlank: true };
    return {
      flankNumber: await this.nextFlankNumber(warehouseId),
      isSecondaryFlank: true,
    };
  }

  // Shared by create()/generate()/bulkImport() — validates one row's data and
  // returns everything needed to insert it (or the errors blocking it). Never
  // throws; callers decide single-record (throw) vs batch (collect) handling.
  // Same "one function, many callers" shape as SkusService.validateSkuData.
  private async prepareRow(
    data: any,
    user: AuthUser,
    excludeId?: string,
    previousAisle?: string,
  ): Promise<{
    errors: string[];
    warehouseId?: string;
    zoneType?: string;
    storageType?: string;
    categoryId?: string;
    fields?: Record<string, any>;
    code?: string;
  }> {
    const errors: string[] = [];
    const { zoneType, storageType, fields } = this.buildLocationFields(
      data,
      errors,
    );
    const categoryId = await this.resolveCategory(data.category, errors);
    const warehouseId = data.warehouseId;
    if (!warehouseId) errors.push('Warehouse is required.');
    else await this.assertWarehouseAccess(warehouseId, user, errors);
    let isSecondaryFlank = false;
    if (warehouseId && fields.aisle && errors.length === 0) {
      await this.assertNoConflictingFamily(
        warehouseId,
        fields.aisle,
        storageType,
        previousAisle,
        errors,
        excludeId,
      );
      const resolvedSection =
        errors.length === 0
          ? await this.assertSectionConsistency(
              warehouseId,
              fields.aisle,
              data.section,
              errors,
              excludeId,
            )
          : undefined;
      if (resolvedSection) fields.section = resolvedSection;
      // Only generate() ever sets data.isSecondary (true for a row from a
      // Second Range or the "mirror" checkbox) — manual create/import never
      // pass it, so every row they create resolves as the primary flank
      // (reusing the Aisle's existing one, or starting a brand-new Aisle's
      // first flank) unless that Aisle already has two flanks established,
      // in which case it's ambiguous which one a hand-typed row belongs to
      // and this defaults to the primary — a real known limitation, not an
      // oversight (manual create is the rare/secondary path; see CLAUDE.md).
      if (errors.length === 0) {
        const resolved = await this.resolveFlankNumber(
          warehouseId,
          fields.aisle,
          storageType,
          !!data.isSecondary,
          excludeId,
        );
        fields.flankNumber = resolved.flankNumber;
        isSecondaryFlank = resolved.isSecondaryFlank;
      }
    }
    if (errors.length > 0) return { errors };
    return {
      errors,
      warehouseId,
      zoneType,
      storageType,
      categoryId,
      fields,
      code: this.buildCode(storageType, fields, isSecondaryFlank),
    };
  }

  async create(data: any, user: AuthUser) {
    if (!user.companyId) {
      throw new ForbiddenException(
        'Super admin accounts cannot create locations directly — log in as a company admin instead.',
      );
    }
    const prepared = await this.prepareRow(data, user);
    if (prepared.errors.length > 0)
      throw new BadRequestException(prepared.errors);

    const existing = await this.prisma.location.findUnique({
      where: {
        warehouseId_code: {
          warehouseId: prepared.warehouseId!,
          code: prepared.code!,
        },
      },
    });
    if (existing) {
      throw new BadRequestException(
        `A location with code "${prepared.code}" already exists in this warehouse — check for a duplicate aisle/rack/level/bin (or block/stack).`,
      );
    }

    const created = await this.prisma.location.create({
      data: {
        warehouse: { connect: { id: prepared.warehouseId } },
        code: prepared.code!,
        zone: data.zone ? String(data.zone).trim() : undefined,
        zoneType: prepared.zoneType as any,
        storageType: prepared.storageType!,
        category: prepared.categoryId
          ? { connect: { id: prepared.categoryId } }
          : undefined,
        ...prepared.fields,
      },
      include: {
        warehouse: { select: { id: true, code: true, name: true } },
        category: { select: { id: true, name: true } },
      },
    });
    return this.attachCapacity(created);
  }

  // Range generator — expands a Rack range (rack x level x bin x depth), a
  // Ground Block range, or a Stillage Stack range into many individual
  // Location rows in one call, reusing prepareRow's per-row validation and
  // the same duplicate-detection create() uses. See CLAUDE.md's Locations/
  // Bins notes for the design (why depth/width/height stay FIXED per batch —
  // one footprint applies to every generated Ground/Stillage row — while
  // only the identifier field(s) vary across the range).
  async generate(data: any, user: AuthUser) {
    if (!user.companyId) {
      throw new ForbiddenException(
        'Super admin accounts cannot create locations directly — log in as a company admin instead.',
      );
    }
    const storageType = data.storageType ? normalizeCode(data.storageType) : '';
    if (!STORAGE_TYPE_VALUES.includes(storageType)) {
      throw new BadRequestException([
        `Storage Type must be one of: ${Object.values(STORAGE_TYPE_LABELS).join(', ')}.`,
      ]);
    }

    // A bare number in Depth (e.g. "5", no dash) means "this lane is 5 pallets
    // deep" — expand to every position 1..5, not just a single fixed depth=5
    // row. Real gap caught 2026-08-24: entering "2" for a 2-deep drive-in lane
    // silently created only the back slot, never the front one. An explicit
    // range ("3-5") still means exactly those positions (e.g. retrofitting
    // one missing position into an already-partly-built lane).
    const depthRangeInput = /^\d+$/.test(String(data.depthRange || '').trim())
      ? `1-${String(data.depthRange).trim()}`
      : data.depthRange;

    // "Second range" fields let one generate() call build both flanks of a
    // single aisle in one go — e.g. Rack Range 01-10 (one side) + Second Rack
    // Range 11-20 (the other side), same Aisle, same Depth for both. A row
    // from the second range is tagged `isSecondary: true` so prepareRow's
    // resolveFlankNumber (see above) can allocate/reuse the right flank
    // number and buildCode can append the right letter suffix — this also
    // lets the SAME rack/block number be reused on both sides (e.g. a
    // "mirror" generation, same numbers both flanks) without colliding on
    // code. Omit the second range and behavior is identical to a
    // single-sided generation (unchanged, isSecondary never set at all).
    let rows: Record<string, any>[];
    if (RACK_STORAGE_TYPES.includes(storageType)) {
      const rackRanges = [data.rackRange, data.rackRange2].filter(
        (r) => r !== undefined && r !== null && String(r).trim() !== '',
      );
      const levels = expandRange(data.levelRange);
      const bins = expandRange(data.binRange);
      const depths = expandRange(depthRangeInput);
      rows = [];
      rackRanges.forEach((rackRangeStr, rangeIndex) => {
        const isSecondary = rangeIndex === 1;
        for (const rack of expandRange(rackRangeStr))
          for (const level of levels)
            for (const bin of bins)
              for (const depth of depths)
                rows.push({ rack, level, bin, depth, isSecondary });
      });
      if (rackRanges.length === 0) {
        for (const rack of expandRange(undefined))
          for (const level of levels)
            for (const bin of bins)
              for (const depth of depths)
                rows.push({ rack, level, bin, depth });
      }
    } else if (storageType === 'GROUND_FLOOR') {
      // 2026-09-06 redesign (see wms-putaway-design memory) — a bin (one
      // Block) now expands into `width × depth` real rows, one per pallet
      // position, instead of the single aggregate-capacity row this used
      // to produce. The generator's own INPUT shape is unchanged (staff
      // still just type Width/Depth once per batch) — only the OUTPUT row
      // count changes. `rack` (reused as column number, 1..width) and
      // `depth` (position within that column, 1..depth) are now generated
      // per position, same nested-loop shape Rack's own generator already
      // uses for rack x level x bin x depth.
      const widthNum = Number(data.width);
      const depthNum = Number(data.depth);
      if (!Number.isInteger(widthNum) || widthNum <= 0) {
        throw new BadRequestException([
          'Width (how many columns the bin has) must be a positive whole number.',
        ]);
      }
      if (!Number.isInteger(depthNum) || depthNum <= 0) {
        throw new BadRequestException([
          'Depth (positions per column) must be a positive whole number.',
        ]);
      }
      // Depth Tiers (2026-09-07, optional, default 1) — how many bins are
      // stacked back-to-back in the depth direction on each side, before
      // reaching the aisle. Each tier is a genuinely separate bin — its own
      // depth numbering restarts at 1, matching the real client-confirmed
      // picture ("Bin A depth 1-4, then Bin B depth 1-4 AGAIN, its own
      // block code") — not a continuation to depth 5-8 of one bin. See
      // buildLocationFields'/buildCode's own comments on Depth Tier.
      const depthTiersInput = data.depthTiers;
      const depthTiersNum =
        depthTiersInput === undefined ||
        depthTiersInput === null ||
        String(depthTiersInput).trim() === ''
          ? 1
          : Number(depthTiersInput);
      if (!Number.isInteger(depthTiersNum) || depthTiersNum <= 0) {
        throw new BadRequestException([
          'Depth Tiers (how many bins stack back-to-back on one side) must be a positive whole number.',
        ]);
      }
      const blockRanges = [data.blockRange, data.blockRange2].filter(
        (r) => r !== undefined && r !== null && String(r).trim() !== '',
      );
      rows = [];
      const pushBinRows = (
        block: string | undefined,
        isSecondary?: boolean,
      ) => {
        for (let column = 1; column <= widthNum; column++) {
          for (let tier = 1; tier <= depthTiersNum; tier++) {
            for (let depth = 1; depth <= depthNum; depth++) {
              rows.push({
                block,
                rack: String(column),
                depth,
                width: widthNum,
                isSecondary,
                depthTier: depthTiersNum > 1 ? tier : undefined,
              });
            }
          }
        }
      };
      blockRanges.forEach((blockRangeStr, rangeIndex) => {
        const isSecondary = rangeIndex === 1;
        for (const block of expandRange(blockRangeStr))
          pushBinRows(block, isSecondary);
      });
      if (blockRanges.length === 0) {
        for (const block of expandRange(undefined)) pushBinRows(block);
      }
    } else {
      // STILLAGE — no "second side" concept; a stillage stack isn't a
      // two-flank structure the way an aisle's rack rows or floor blocks
      // are. 2026-09-13 redesign (see wms-putaway-design memory) — a bin
      // (one Stack) now expands into `width × depth` real rows, one per
      // real stack-height POSITION, instead of the single aggregate-
      // capacity row this used to produce — same "one row per real
      // position" move Ground/Floor already went through. `rack` (reused
      // as column number, 1..width) and `depth` (position within that
      // column, 1..depth) are generated per position, same nested-loop
      // shape Ground's own generator already uses.
      const widthNum =
        data.width === undefined ||
        data.width === null ||
        String(data.width).trim() === ''
          ? 1
          : Number(data.width);
      const depthNum =
        data.depth === undefined ||
        data.depth === null ||
        String(data.depth).trim() === ''
          ? 1
          : Number(data.depth);
      if (!Number.isInteger(widthNum) || widthNum <= 0) {
        throw new BadRequestException([
          'Width (how many stillage columns the stack has) must be a positive whole number.',
        ]);
      }
      if (!Number.isInteger(depthNum) || depthNum <= 0) {
        throw new BadRequestException([
          'Depth (positions per stillage column) must be a positive whole number.',
        ]);
      }
      rows = [];
      for (const stack of expandRange(data.stackRange)) {
        for (let column = 1; column <= widthNum; column++) {
          for (let depth = 1; depth <= depthNum; depth++) {
            rows.push({
              stack,
              rack: String(column),
              depth,
              width: widthNum,
              height: data.height,
            });
          }
        }
      }
    }

    if (rows.length === 0)
      throw new BadRequestException([
        'The given range(s) produced no rows to generate.',
      ]);
    if (rows.length > MAX_GENERATE_BATCH) {
      throw new BadRequestException([
        `This range would generate ${rows.length} locations in one batch — narrow it down (max ${MAX_GENERATE_BATCH} per generation).`,
      ]);
    }

    // `id` added to a success row 2026-08-29 — Location Labels needs the
    // real ids of just-generated locations to offer "download labels for
    // this batch" right after generation, without a second round-trip.
    const results: {
      id?: string;
      code?: string;
      status: 'success' | 'error';
      errors?: string[];
    }[] = [];
    const codesSeenInBatch = new Set<string>();
    for (const row of rows) {
      const rowData = { ...data, ...row };
      const prepared = await this.prepareRow(rowData, user);
      if (prepared.errors.length > 0) {
        results.push({ status: 'error', errors: prepared.errors });
        continue;
      }
      if (codesSeenInBatch.has(prepared.code!)) {
        results.push({
          code: prepared.code,
          status: 'error',
          errors: ['Duplicate within this generation batch.'],
        });
        continue;
      }
      const existing = await this.prisma.location.findUnique({
        where: {
          warehouseId_code: {
            warehouseId: prepared.warehouseId!,
            code: prepared.code!,
          },
        },
      });
      if (existing) {
        results.push({
          code: prepared.code,
          status: 'error',
          errors: ['A location with this code already exists.'],
        });
        continue;
      }
      try {
        const created = await this.prisma.location.create({
          data: {
            warehouse: { connect: { id: prepared.warehouseId } },
            code: prepared.code!,
            zone: data.zone ? String(data.zone).trim() : undefined,
            zoneType: prepared.zoneType as any,
            storageType: prepared.storageType!,
            category: prepared.categoryId
              ? { connect: { id: prepared.categoryId } }
              : undefined,
            ...prepared.fields,
          },
        });
        results.push({
          id: created.id,
          code: prepared.code,
          status: 'success',
        });
        codesSeenInBatch.add(prepared.code!);
      } catch (err: any) {
        results.push({
          code: prepared.code,
          status: 'error',
          errors: [err.message || 'Unknown error'],
        });
      }
    }

    return {
      totalRequested: rows.length,
      successCount: results.filter((r) => r.status === 'success').length,
      failCount: results.filter((r) => r.status === 'error').length,
      results,
    };
  }

  private async resolveWarehouseCodeToId(
    code: any,
    user: AuthUser,
    errors: string[],
  ): Promise<string | undefined> {
    const codeStr = code ? String(code).trim().toUpperCase() : '';
    if (!codeStr) {
      errors.push('Warehouse Code is required.');
      return undefined;
    }
    const warehouse = await this.prisma.warehouse.findUnique({
      // Non-null assertion: this resolver is only ever called from a
      // company-scoped bulk-import/generate path — same reasoning as
      // companyFilter()'s own return type in tenant.util.ts.
      where: { companyId_code: { companyId: user.companyId!, code: codeStr } },
    });
    if (!warehouse) {
      errors.push(`Warehouse Code "${codeStr}" not found.`);
      return undefined;
    }
    if (WAREHOUSE_SCOPED_ROLES.includes(user.role)) {
      const ids = await ownWarehouseIds(this.prisma, user.userId);
      if (!ids.includes(warehouse.id)) {
        errors.push(`You do not have access to Warehouse "${codeStr}".`);
        return undefined;
      }
    }
    return warehouse.id;
  }

  // Excel bulk import — one row per Location, same xlsx -> per-row validation
  // -> success/error results shape as Warehouse/SKU/Customer/User. Unlike
  // those, this template's rows aren't grouped by a repeated key — each row
  // is already exactly one Location, so no grouping pass is needed first.
  async bulkImport(rows: any[], user: AuthUser) {
    if (!user.companyId) {
      throw new ForbiddenException(
        'Super admin accounts cannot import locations directly — log in as a company admin instead.',
      );
    }
    const results: {
      code?: string;
      status: 'success' | 'error';
      errors?: string[];
    }[] = [];
    const codesSeenInFile = new Map<string, string>(); // warehouseId::code -> row label, for within-file dupes

    for (const row of rows) {
      const errors: string[] = [];
      const warehouseId = await this.resolveWarehouseCodeToId(
        row.warehouseCode,
        user,
        errors,
      );
      const prepared = warehouseId
        ? await this.prepareRow({ ...row, warehouseId }, user)
        : { errors };
      if (warehouseId) prepared.errors = [...errors, ...prepared.errors];

      if (prepared.errors.length > 0 || !prepared.code) {
        results.push({
          status: 'error',
          errors: prepared.errors.length
            ? prepared.errors
            : ['Could not process this row.'],
        });
        continue;
      }

      const batchKey = `${prepared.warehouseId}::${prepared.code}`;
      if (codesSeenInFile.has(batchKey)) {
        results.push({
          code: prepared.code,
          status: 'error',
          errors: [
            'Duplicate within this file (same Warehouse + resulting code).',
          ],
        });
        continue;
      }
      const existing = await this.prisma.location.findUnique({
        where: {
          warehouseId_code: {
            warehouseId: prepared.warehouseId!,
            code: prepared.code,
          },
        },
      });
      if (existing) {
        results.push({
          code: prepared.code,
          status: 'error',
          errors: [
            'A location with this code already exists in this warehouse.',
          ],
        });
        continue;
      }

      try {
        await this.prisma.location.create({
          data: {
            warehouse: { connect: { id: prepared.warehouseId } },
            code: prepared.code,
            zone: row.zone ? String(row.zone).trim() : undefined,
            zoneType: prepared.zoneType as any,
            storageType: prepared.storageType!,
            category: prepared.categoryId
              ? { connect: { id: prepared.categoryId } }
              : undefined,
            ...prepared.fields,
          },
        });
        results.push({ code: prepared.code, status: 'success' });
        codesSeenInFile.set(batchKey, prepared.code);
      } catch (err: any) {
        results.push({
          code: prepared.code,
          status: 'error',
          errors: [err.message || 'Unknown error'],
        });
      }
    }

    return {
      totalRows: rows.length,
      successCount: results.filter((r) => r.status === 'success').length,
      failCount: results.filter((r) => r.status === 'error').length,
      results,
    };
  }

  async findAll(user: AuthUser) {
    const where: any = { warehouse: { ...companyFilter(user) } };
    if (WAREHOUSE_SCOPED_ROLES.includes(user.role)) {
      where.warehouseId = {
        in: await ownWarehouseIds(this.prisma, user.userId),
      };
    }
    const locations = await this.prisma.location.findMany({
      where,
      include: {
        warehouse: { select: { id: true, code: true, name: true } },
        category: { select: { id: true, name: true } },
      },
      orderBy: { code: 'asc' },
    });
    return locations.map((l) => this.attachCapacity(l));
  }

  // Plan View occupancy overlay (2026-09-05 — see [[wms-putaway-design]]) —
  // "which ever bins are used, we need to keep different colour in this...
  // these should be picked from the actual storage data." One row per
  // currently-occupied location (on-hand > 0, derived from StockMovement,
  // same "always derive, never store a counter" convention as
  // suggestBin()/Insights) — an empty location simply doesn't appear in the
  // result, the frontend renders anything absent as neutral. A location
  // with more than one real occupant SKU (only possible for a multi-SKU
  // lane sharing depths, per suggestBin()'s own maxSkusClass* rule) reports
  // just the first one found — this is per-LOCATION-ROW occupancy for a
  // Plan View box, not per-lane, and a genuine multi-occupant single row
  // isn't a real scenario this schema allows.
  async occupancyByWarehouse(warehouseId: string, user: AuthUser) {
    if (!warehouseId) throw new BadRequestException('warehouseId is required.');
    const warehouse = await this.prisma.warehouse.findUnique({
      where: { id: warehouseId },
    });
    if (!warehouse) throw new NotFoundException('Warehouse not found.');
    if (user.role !== 'SUPER_ADMIN' && warehouse.companyId !== user.companyId) {
      throw new ForbiddenException('You do not have access to this warehouse.');
    }
    if (WAREHOUSE_SCOPED_ROLES.includes(user.role)) {
      const ids = await ownWarehouseIds(this.prisma, user.userId);
      if (!ids.includes(warehouseId))
        throw new ForbiddenException(
          'You do not have access to this warehouse.',
        );
    }

    const locations = await this.prisma.location.findMany({
      where: { warehouseId },
      select: { id: true },
    });
    const locationIds = locations.map((l) => l.id);
    if (locationIds.length === 0) return [];

    const movements = await this.prisma.stockMovement.findMany({
      where: { locationId: { in: locationIds } },
      select: { locationId: true, skuId: true, quantity: true },
    });

    const balanceByLocSku = new Map<string, number>();
    for (const m of movements) {
      const key = `${m.locationId}|${m.skuId}`;
      balanceByLocSku.set(
        key,
        (balanceByLocSku.get(key) || 0) + Number(m.quantity),
      );
    }
    const occupantSkuIdByLocation = new Map<string, string>();
    for (const [key, qty] of balanceByLocSku) {
      if (qty <= 0) continue;
      const [locationId, skuId] = key.split('|');
      if (!occupantSkuIdByLocation.has(locationId))
        occupantSkuIdByLocation.set(locationId, skuId);
    }
    if (occupantSkuIdByLocation.size === 0) return [];

    const skuIds = [...new Set(occupantSkuIdByLocation.values())];
    const skus = await this.prisma.sku.findMany({
      where: { id: { in: skuIds } },
      select: {
        id: true,
        code: true,
        abcClass: true,
        category: { select: { id: true, name: true } },
      },
    });
    const skuById = new Map(skus.map((s) => [s.id, s]));
    // FMS×ABC (2026-09-08) — the per-warehouse COMPUTED classification
    // (SkuWarehouseClass, real trailing-dispatch-derived) is fetched here
    // too, same override-when-known/fall-back-to-manual chain suggestBin()
    // itself already uses — this occupancy overlay predates SkuWarehouseClass
    // (built 2026-09-05, a day before Topic 1 shipped) and had never been
    // updated to prefer it for abcClass; doing so now costs nothing extra,
    // since the same row has to be fetched for fmsClass anyway (fmsClass has
    // no manual-fallback equivalent at all — it's purely a computed fact).
    const warehouseClasses = await this.prisma.skuWarehouseClass.findMany({
      where: { warehouseId, skuId: { in: skuIds } },
      select: { skuId: true, abcClass: true, fmsClass: true },
    });
    const warehouseClassBySku = new Map(
      warehouseClasses.map((w) => [w.skuId, w]),
    );

    return [...occupantSkuIdByLocation.entries()].map(([locationId, skuId]) => {
      const sku = skuById.get(skuId);
      const warehouseClass = warehouseClassBySku.get(skuId);
      return {
        locationId,
        skuId,
        skuCode: sku?.code ?? null,
        // Unclassified defaults to C — same convention suggestBin()/Insights
        // already use, confirmed 2026-08-28.
        categoryId: sku?.category?.id ?? null,
        categoryName: sku?.category?.name ?? null,
        abcClass: (
          warehouseClass?.abcClass ||
          sku?.abcClass ||
          'C'
        ).toUpperCase(),
        // No manual-class equivalent to fall back to — null means either the
        // occupant is ABC-class D (no FMS lookup, treated as CS regardless)
        // or FMS classification hasn't been run for this warehouse yet.
        fmsClass: warehouseClass?.fmsClass
          ? warehouseClass.fmsClass.toUpperCase()
          : null,
        // On-hand quantity at this location, for the click-to-inspect panel
        // (2026-09-06 — "I need SKU details in it also") — the exact same
        // positive balance already computed above, just carried through
        // instead of discarded once it picked the occupant SKU.
        quantity: balanceByLocSku.get(`${locationId}|${skuId}`) ?? 0,
      };
    });
  }

  // Bin Rank — "which of the 9 ABC×FMS matrix cells does this bin's own
  // POSITION represent" (2026-09-09, see [[wms-abc-velocity-design]] in
  // memory). Genuinely location-intrinsic, no occupancy or SKU involved at
  // all — confirmed directly, multiple rounds: "idc if the bin is used or
  // not, i just wanna know our bin ranking," and the exact numbering is the
  // 9-cell matrix itself, 1=AF (best) through 9=CS (worst), same order
  // already used throughout this design (row-major: A-row/B-row/C-row,
  // F/M/S across each). Scoped to GROUND_FLOOR only — that's the one
  // storage type where a SINGLE combined score genuinely drives placement
  // (`PutawayTasksService.suggestGroundBin()`'s own target-rank mechanism);
  // Rack (SPR/ASRS) splits ABC and FMS across two INDEPENDENT levers
  // (aisle vs. level), so a single 1-9 number per bin wouldn't honestly
  // represent a Rack position without also folding in its Level — flagged
  // as a genuine open follow-on, not silently included with a half-formed
  // number.
  //
  // 2026-09-12: extended to PER-BIN granularity (was per-AISLE only) — a
  // real, correct client catch: "the furthest bin from the dock should be
  // red, closest bin should be green" — every bin in one aisle used to get
  // the identical rank/color, which can't be right once a warehouse's dock
  // sits on the front/back wall of every aisle (the ROW axis — see
  // dock-zone.util.ts's buildRowProximityRanker(), step 2 of the 4-wall
  // model) rather than either end of the aisle sequence. Now mirrors
  // PutawayTasksService.suggestGroundBin()'s own combined aisle+row
  // fraction exactly (byte-for-byte the same formula, duplicated rather
  // than shared — no shared code exists between locations/ and putaway/ in
  // this codebase, same convention as every other cross-module pure
  // function here) so the DISPLAY genuinely matches what real placement
  // uses, not a separate approximation. A warehouse with only an aisle-axis
  // zone configured (today's only real case, e.g. TNR8) still returns the
  // identical rank for every bin in one aisle — zero visible change until a
  // row-axis zone is actually added.
  private static readonly BIN_RANK_MATRIX_LABELS = [
    'AF',
    'AM',
    'AS',
    'BF',
    'BM',
    'BS',
    'CF',
    'CM',
    'CS',
  ];

  async binRankByWarehouse(warehouseId: string, user: AuthUser) {
    if (!warehouseId) throw new BadRequestException('warehouseId is required.');
    const warehouse = await this.prisma.warehouse.findUnique({
      where: { id: warehouseId },
    });
    if (!warehouse) throw new NotFoundException('Warehouse not found.');
    if (user.role !== 'SUPER_ADMIN' && warehouse.companyId !== user.companyId) {
      throw new ForbiddenException('You do not have access to this warehouse.');
    }
    if (WAREHOUSE_SCOPED_ROLES.includes(user.role)) {
      const ids = await ownWarehouseIds(this.prisma, user.userId);
      if (!ids.includes(warehouseId))
        throw new ForbiddenException(
          'You do not have access to this warehouse.',
        );
    }

    const groundLocations = await this.prisma.location.findMany({
      where: {
        warehouseId,
        storageType: 'GROUND_FLOOR',
        aisle: { not: null },
        block: { not: null },
      },
      select: { aisle: true, flankNumber: true, block: true },
    });
    const distinctAisles = [
      ...new Set(
        groundLocations
          .map((l) => l.aisle)
          .filter((a): a is string => a != null),
      ),
    ];
    if (distinctAisles.length === 0) return { configured: false, ranks: [] };

    const dockZones = await this.prisma.warehouseDockZone.findMany({
      where: { warehouseId },
      select: { purpose: true, dockSide: true, numberOneNearDock: true },
    });
    const aisleRanker = buildOutboundProximityRanker(distinctAisles, dockZones);
    const rowRanker = buildRowProximityRanker(dockZones);
    if (!aisleRanker && !rowRanker) return { configured: false, ranks: [] };

    const maxAisleRaw = aisleRanker
      ? Math.max(...distinctAisles.map((a) => aisleRanker(a)))
      : 0;

    // Distinct (aisle, flankNumber, block) bins — same grouping key
    // suggestGroundBin() itself uses (binKeyOf) — and each flank's own
    // sorted distinct blocks, for the row ranker (mirrors
    // PutawayTasksService's groundRowGroups exactly).
    const binKeyOf = (l: {
      aisle: string | null;
      flankNumber: number | null;
      block: string | null;
    }) => `${l.aisle}|${l.flankNumber ?? 'x'}|${l.block}`;
    const distinctBins = new Map<
      string,
      { aisle: string; flankNumber: number | null; block: string }
    >();
    const rowGroups = new Map<string, string[]>();
    for (const l of groundLocations) {
      if (l.aisle == null || l.block == null) continue;
      distinctBins.set(binKeyOf(l), {
        aisle: l.aisle,
        flankNumber: l.flankNumber,
        block: l.block,
      });
      const groupKey = `${l.aisle}|${l.flankNumber ?? 'x'}`;
      if (!rowGroups.has(groupKey)) rowGroups.set(groupKey, []);
      rowGroups.get(groupKey)!.push(l.block);
    }
    // Normalized against the WAREHOUSE-WIDE longest row sequence, NOT each
    // group's own length (2026-09-12 — a real bug the client caught live:
    // two bins at the same visual depth from a South-wall dock, in
    // different aisles, got very different ranks — because a per-group max
    // made the identical physical row position read as a worse fraction in
    // whichever aisle happened to have fewer distinct blocks. Every aisle's
    // Row 1 anchors to the same shared line, so a raw row index means the
    // same real depth everywhere — mirrors the identical fix in
    // PutawayTasksService.suggestGroundBin()'s own rowFractionFor().
    let globalMaxRowIndex = 0;
    for (const [key, positions] of rowGroups) {
      const sorted = Array.from(new Set(positions)).sort(
        (a, b) => (Number(a) || 0) - (Number(b) || 0),
      );
      rowGroups.set(key, sorted);
      globalMaxRowIndex = Math.max(globalMaxRowIndex, sorted.length - 1);
    }

    const bucketOf = (fraction: number) =>
      Math.min(9, Math.max(1, Math.round(fraction * 8) + 1));

    const ranks = [...distinctBins.values()].map((bin) => {
      let aisleFraction: number | null = null;
      if (aisleRanker)
        aisleFraction =
          maxAisleRaw > 0 ? aisleRanker(bin.aisle) / maxAisleRaw : 0;
      let rowFraction: number | null = null;
      if (rowRanker) {
        const positions =
          rowGroups.get(`${bin.aisle}|${bin.flankNumber ?? 'x'}`) ?? [];
        rowFraction =
          globalMaxRowIndex > 0
            ? rowRanker(positions, bin.block, globalMaxRowIndex) /
              globalMaxRowIndex
            : 0;
      }
      const parts = [aisleFraction, rowFraction].filter(
        (v): v is number => v != null,
      );
      const combinedFraction = parts.reduce((a, b) => a + b, 0) / parts.length;
      const bucket = bucketOf(combinedFraction);
      return {
        aisle: bin.aisle,
        flankNumber: bin.flankNumber,
        block: bin.block,
        rank: bucket,
        label: LocationsService.BIN_RANK_MATRIX_LABELS[bucket - 1],
      };
    });
    return { configured: true, ranks };
  }

  // Rack Rank (2026-09-13) — Rack's own analogue to Ground's Bin Rank above,
  // raised directly after building numberOneNearDock: "asking whether Rack
  // should eventually get its own analogous ranking treatment." Genuinely
  // different shape, not a copy: Ground has ONE physical lever (distance
  // from the dock), so one combined 1-9 number honestly represents a bin.
  // Rack has TWO independent levers — which AISLE (a real travel-distance
  // cost, ABC-driven) and which LEVEL (a reach-effort cost, FMS-driven,
  // SPR/ASRS only — Drive-in locks a whole column to one SKU top to bottom,
  // so there's no independent level choice to rank there at all). Blending
  // the two into one score the way Ground does would quietly hide which
  // kind of cost is actually driving a bad rank — so this returns two
  // separate small tier lists instead, each on its own real 3-tier scale
  // matching the classification it's actually built from (A/B/C for aisle,
  // F/M/S for level) rather than borrowing Ground's 9-cell AF..CS labels.
  //
  // Both are warehouse-wide small lists (one entry per distinct Aisle, one
  // per distinct Level) — NOT per-bin like Ground's Bin Rank needed to be,
  // since neither axis here needs combining with the other the way Ground's
  // aisle+row fractions did into one number per bin.
  private static readonly AISLE_RANK_LABELS = ['A', 'B', 'C'];
  private static readonly LEVEL_RANK_LABELS = ['F', 'M', 'S'];
  private static bucket3(fraction: number): number {
    if (fraction <= 1 / 3) return 0;
    if (fraction <= 2 / 3) return 1;
    return 2;
  }

  async rackRankByWarehouse(warehouseId: string, user: AuthUser) {
    if (!warehouseId) throw new BadRequestException('warehouseId is required.');
    const warehouse = await this.prisma.warehouse.findUnique({
      where: { id: warehouseId },
    });
    if (!warehouse) throw new NotFoundException('Warehouse not found.');
    if (user.role !== 'SUPER_ADMIN' && warehouse.companyId !== user.companyId) {
      throw new ForbiddenException('You do not have access to this warehouse.');
    }
    if (WAREHOUSE_SCOPED_ROLES.includes(user.role)) {
      const ids = await ownWarehouseIds(this.prisma, user.userId);
      if (!ids.includes(warehouseId))
        throw new ForbiddenException(
          'You do not have access to this warehouse.',
        );
    }

    const rackLocations = await this.prisma.location.findMany({
      where: {
        warehouseId,
        storageType: { in: RACK_STORAGE_TYPES },
        aisle: { not: null },
      },
      select: { storageType: true, aisle: true, level: true },
    });

    // Aisle Rank — reuses the exact same buildOutboundProximityRanker()
    // suggestBin() itself uses for real Rack placement (ABC-driven), just
    // bucketed into 3 tiers instead of consumed as a raw sort key.
    const distinctAisles = [
      ...new Set(
        rackLocations.map((l) => l.aisle).filter((a): a is string => a != null),
      ),
    ];
    let aisleRank: {
      configured: boolean;
      ranks: { aisle: string; rank: string }[];
    } = { configured: false, ranks: [] };
    if (distinctAisles.length > 0) {
      const dockZones = await this.prisma.warehouseDockZone.findMany({
        where: { warehouseId },
        select: { purpose: true, dockSide: true, numberOneNearDock: true },
      });
      const aisleRanker = buildOutboundProximityRanker(
        distinctAisles,
        dockZones,
      );
      if (aisleRanker) {
        const maxRaw = Math.max(...distinctAisles.map((a) => aisleRanker(a)));
        const ranks = distinctAisles
          .map((aisle) => {
            const fraction = maxRaw > 0 ? aisleRanker(aisle) / maxRaw : 0;
            return {
              aisle,
              rank: LocationsService.AISLE_RANK_LABELS[
                LocationsService.bucket3(fraction)
              ],
            };
          })
          .sort((a, b) => (Number(a.aisle) || 0) - (Number(b.aisle) || 0));
        aisleRank = { configured: true, ranks };
      }
    }

    // Level Rank — purely structural, no dock zone needed at all: "low is
    // easy to reach" is a fixed physical fact, not dependent on where the
    // dock is. SPR only (Drive-in has no independent level choice; ASRS was
    // removed 2026-09-13 — real ASRS runs its own dedicated WCS/WES
    // software), matching suggestBin()'s own level-tiebreak scoping.
    //
    // Grouped by NUMERIC value, not raw string — a real bug caught live
    // against TNR8's own data: Level Range generation zero-pads ("01".."07"
    // on one aisle) while other aisles/rows store the bare number ("1".."7"),
    // same "01-20" range-preservation behavior documented on the Location
    // generator. `suggestBin()`'s own level tiebreak never hit this (it only
    // ever numerically COMPARES two candidates, `Number(a.level) - Number(
    // b.level)`, never builds a distinct-value SET), but this function does
    // — treating "7" and "07" as two different levels doubled the apparent
    // level count and skewed every bucket boundary, and returning whichever
    // raw spelling happened to land in the Set meant a real bin's OWN level
    // string often didn't even match its own rank entry on the frontend.
    // The response's `level` field is the canonical bare-number string
    // (`String(numeric)`) — frontend lookups normalize a Location's own
    // `level` the same way before joining against this list.
    const levelNumbers = [
      ...new Set(
        rackLocations
          .filter((l) => l.storageType === 'SPR')
          .map((l) => l.level)
          .filter((lv): lv is string => lv != null)
          .map((lv) => Number(lv) || 0),
      ),
    ].sort((a, b) => a - b);
    let levelRank: {
      configured: boolean;
      ranks: { level: string; rank: string }[];
    } = { configured: false, ranks: [] };
    if (levelNumbers.length > 0) {
      const maxIdx = levelNumbers.length - 1;
      const ranks = levelNumbers.map((num, idx) => {
        const fraction = maxIdx > 0 ? idx / maxIdx : 0;
        return {
          level: String(num),
          rank: LocationsService.LEVEL_RANK_LABELS[
            LocationsService.bucket3(fraction)
          ],
        };
      });
      levelRank = { configured: true, ranks };
    }

    return { aisleRank, levelRank };
  }

  // Location Labels (2026-08-29) — a genuine, simple stand-in for a real
  // barcode: since we're the sole source of a bin's identity (unlike a
  // SKU, which can have multiple manufacturer-printed barcodes across pack
  // levels — see SkuBarcode), a location doesn't need its own separate
  // barcode value at all. This just prints the location's own existing
  // Rack Name (falling back to the raw `code` for Ground/Stillage) as a
  // Code128 barcode image — matching the same hardware keyboard-wedge
  // scanners already used everywhere else in this codebase (Inbound
  // receiving, SKU barcodes), and exactly the string completeTrip() and
  // every other Putaway screen already accept. One PNG per location,
  // zipped — used both right after the range generator (labels for the
  // just-created batch) and as a standalone reprint action for any
  // already-existing set of locations. Explicit ids are checked against
  // the caller's own accessible warehouses, same "don't trust a client-
  // supplied id blindly" pattern as every other scoped lookup in this
  // codebase.
  async buildLabelsZip(locationIds: string[], user: AuthUser): Promise<Buffer> {
    if (!Array.isArray(locationIds) || locationIds.length === 0) {
      throw new BadRequestException('At least one location id is required.');
    }
    if (locationIds.length > MAX_GENERATE_BATCH) {
      throw new BadRequestException(
        `Too many locations at once — narrow it down (max ${MAX_GENERATE_BATCH} per label batch).`,
      );
    }
    const where: any = {
      id: { in: locationIds },
      warehouse: { ...companyFilter(user) },
    };
    if (WAREHOUSE_SCOPED_ROLES.includes(user.role)) {
      where.warehouseId = {
        in: await ownWarehouseIds(this.prisma, user.userId),
      };
    }
    const locations = await this.prisma.location.findMany({ where });
    if (locations.length === 0)
      throw new BadRequestException(
        'None of the given locations were found, or you do not have access to them.',
      );

    return new Promise((resolve, reject) => {
      const archive = new ZipArchive({ zlib: { level: 9 } });
      const chunks: Buffer[] = [];
      archive.on('data', (chunk: Buffer) => chunks.push(chunk));
      archive.on('error', reject);
      archive.on('end', () => resolve(Buffer.concat(chunks)));

      const usedFilenames = new Set<string>();
      Promise.all(
        locations.map(async (loc: any) => {
          const text = displayCode(loc);
          const png = await bwipjs.toBuffer({
            bcid: 'code128',
            text,
            scale: 3,
            height: 12,
            includetext: true,
            textxalign: 'center',
          });
          // Two different locations could share a display label in a
          // genuinely pathological case (e.g. a legacy row with no
          // flankNumber falling back to a code that collides after
          // sanitization) — a numeric suffix keeps the zip from silently
          // dropping one file for another with the same name.
          let filename = `${text.replace(/[^A-Za-z0-9_-]/g, '_')}.png`;
          let n = 2;
          while (usedFilenames.has(filename))
            filename = `${text.replace(/[^A-Za-z0-9_-]/g, '_')}_${n++}.png`;
          usedFilenames.add(filename);
          archive.append(png, { name: filename });
        }),
      )
        .then(() => archive.finalize())
        .catch(reject);
    });
  }

  // One row per Location, columns matching the Excel import exactly — an
  // exported file can be edited and re-imported unchanged. Code/Capacity are
  // extra reference-only columns the importer doesn't read (harmless).
  async exportRows(user: AuthUser) {
    const locations = await this.findAll(user);
    return locations.map((l: any) => ({
      'Warehouse Code': l.warehouse.code,
      'Zone Type': l.zoneType,
      'Storage Type': l.storageType,
      Category: l.category?.name || '',
      Zone: l.zone || '',
      Section: l.section || '',
      'Flank #': l.flankNumber ?? '',
      Aisle: l.aisle || '',
      Rack: l.rack || '',
      Level: l.level || '',
      Bin: l.bin || '',
      Block: l.block || '',
      Stack: l.stack || '',
      Depth: l.depth ?? '',
      Width: l.width ?? '',
      Height: l.height ?? '',
      Code: l.code,
      // The same string Location Labels prints/scans (Rack Name, falling
      // back to the raw code for Ground/Stillage) — 2026-08-29, so an
      // exported sheet can be cross-referenced against physical labels
      // without a separate lookup.
      Barcode: displayCode(l),
      Capacity: l.capacity ?? '',
      Active: l.isActive ? 'TRUE' : 'FALSE',
    }));
  }

  private async assertAccess(id: string, user: AuthUser) {
    const location = await this.prisma.location.findUnique({
      where: { id },
      include: { warehouse: true },
    });
    if (!location) throw new NotFoundException('Location not found.');
    if (
      user.role !== 'SUPER_ADMIN' &&
      location.warehouse.companyId !== user.companyId
    ) {
      throw new ForbiddenException('You do not have access to this location.');
    }
    if (WAREHOUSE_SCOPED_ROLES.includes(user.role)) {
      const ids = await ownWarehouseIds(this.prisma, user.userId);
      if (!ids.includes(location.warehouseId))
        throw new ForbiddenException(
          'You do not have access to this location.',
        );
    }
    return location;
  }

  async update(id: string, data: any, user: AuthUser) {
    const existingLocation = await this.assertAccess(id, user);

    const prepared = await this.prepareRow(
      {
        ...data,
        warehouseId: data.warehouseId || existingLocation.warehouseId,
      },
      user,
      id,
      existingLocation.aisle ?? undefined,
    );
    if (prepared.errors.length > 0)
      throw new BadRequestException(prepared.errors);

    const duplicate = await this.prisma.location.findUnique({
      where: {
        warehouseId_code: {
          warehouseId: prepared.warehouseId!,
          code: prepared.code!,
        },
      },
    });
    if (duplicate && duplicate.id !== id) {
      throw new BadRequestException(
        `A location with code "${prepared.code}" already exists in this warehouse — check for a duplicate aisle/rack/level/bin (or block/stack).`,
      );
    }

    const updated = await this.prisma.location.update({
      where: { id },
      data: {
        warehouse: { connect: { id: prepared.warehouseId } },
        code: prepared.code!,
        zone: data.zone ? String(data.zone).trim() : null,
        zoneType: prepared.zoneType as any,
        storageType: prepared.storageType!,
        category: prepared.categoryId
          ? { connect: { id: prepared.categoryId } }
          : { disconnect: true },
        // Clear every identifier/dimension field first so switching Storage
        // Type on an existing row doesn't leave stale fields from the old
        // group behind (e.g. a "block" value surviving a switch to rack).
        aisle: null,
        rack: null,
        level: null,
        bin: null,
        block: null,
        stack: null,
        depth: null,
        width: null,
        height: null,
        ...prepared.fields,
      },
      include: {
        warehouse: { select: { id: true, code: true, name: true } },
        category: { select: { id: true, name: true } },
      },
    });
    return this.attachCapacity(updated);
  }

  async deactivate(id: string, user: AuthUser) {
    await this.assertAccess(id, user);
    return this.prisma.location.update({
      where: { id },
      data: { isActive: false },
    });
  }

  async reactivate(id: string, user: AuthUser) {
    await this.assertAccess(id, user);
    return this.prisma.location.update({
      where: { id },
      data: { isActive: true },
    });
  }

  async removeAll(user: AuthUser) {
    const locations = await this.prisma.location.findMany({
      where: { warehouse: { ...companyFilter(user) } },
      select: {
        id: true,
        code: true,
        _count: {
          select: {
            stockMovements: true,
            putawayFrom: true,
            putawayTo: true,
            receiptLinesStaged: true,
            allocations: true,
            returns: true,
          },
        },
      },
    });
    const deletable: string[] = [];
    const blocked: string[] = [];
    for (const loc of locations) {
      const c = loc._count;
      const totalLinked =
        c.stockMovements +
        c.putawayFrom +
        c.putawayTo +
        c.receiptLinesStaged +
        c.allocations +
        c.returns;
      if (totalLinked > 0) blocked.push(loc.code);
      else deletable.push(loc.id);
    }
    if (deletable.length > 0) {
      await this.prisma.location.deleteMany({
        where: { id: { in: deletable } },
      });
    }
    return {
      deletedCount: deletable.length,
      blockedCount: blocked.length,
      blockedCodes: blocked,
    };
  }

  // Single-record delete — "Delete All" alone wasn't enough once real data
  // built up (only one or two rows need removing, not the whole list); same
  // blocking-check shape as removeAll's per-row check, just for one id.
  // Confirmed 2026-08-25.
  async remove(id: string, user: AuthUser) {
    await this.assertAccess(id, user);
    const location = await this.prisma.location.findUnique({
      where: { id },
      select: {
        code: true,
        _count: {
          select: {
            stockMovements: true,
            putawayFrom: true,
            putawayTo: true,
            receiptLinesStaged: true,
            allocations: true,
            returns: true,
          },
        },
      },
    });
    if (!location) throw new NotFoundException('Location not found.');
    const c = location._count;
    const totalLinked =
      c.stockMovements +
      c.putawayFrom +
      c.putawayTo +
      c.receiptLinesStaged +
      c.allocations +
      c.returns;
    if (totalLinked > 0) {
      throw new BadRequestException(
        `Cannot permanently delete "${location.code}" — it has ${totalLinked} linked transaction record(s). Deactivate it instead.`,
      );
    }
    await this.prisma.location.delete({ where: { id } });
    return { deleted: true, code: location.code };
  }
}
