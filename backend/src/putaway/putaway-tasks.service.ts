import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  type AuthUser,
  companyFilter,
  ownWarehouseIds,
  PUTAWAY_SCOPED_ROLES,
} from '../common/tenant.util';
import {
  buildRackName,
  displayCode,
  laneKeyOf,
  RACK_STORAGE_TYPES,
} from '../common/rack-name.util';
import {
  buildOutboundProximityRanker,
  buildRowProximityRanker,
} from '../common/dock-zone.util';

// Rack storage types share the LIFO
// depth constraint (see
// schema.prisma's comment on Location.depth and [[wms-putaway-design]] in
// memory) — SPR, Drive-in, and ASRS all use `depth`; the constraint is
// keyed off whether a given (aisle, rack, level) group actually HAS more
// than one depth position, never off the storageType label itself (a
// single-deep SPR bay behaves exactly like a random-access bin; a
// double-deep SPR bay behaves exactly like a drive-in lane). Also, not
// coincidentally, the same set of storage types Rack Name applies to
// (rack-name.util.ts) — pulled into a shared const 2026-08-29 once
// Location Label generation needed the identical list, rather than a
// second hand-typed copy.

const TASK_INCLUDE = {
  // receipt.referenceNo (PO Number) and receipt.vehicle.vehicleNumber
  // (Truck No.) added 2026-08-29 so the frontend can filter the task
  // queue by either — the same client-side-filter-over-already-fetched-
  // list pattern LocationsPage.tsx already uses.
  receiptLine: {
    select: {
      id: true,
      skuId: true,
      receiptId: true,
      receipt: {
        select: {
          referenceNo: true,
          vehicle: { select: { vehicleNumber: true } },
        },
      },
    },
  },
  sku: { select: { id: true, code: true, description: true } },
  // Extra fields beyond `code` let the frontend build the human "Rack
  // Name" (R{flank}-{rack}-L{level}[-D{depth}]) instead of the raw DB
  // code — 2026-08-29, the client's own correction: the Plan View already
  // showed a bin as "R2-01", but the task queue showed the same bin's raw
  // code with a "B" suffix instead ("1-R01B-..."), two different labels
  // for one location. See buildRackName() below and completeTrip(), which
  // now accepts this same string at the scan step too.
  fromLocation: {
    select: {
      id: true,
      code: true,
      storageType: true,
      rack: true,
      level: true,
      depth: true,
      flankNumber: true,
    },
  },
  toLocation: {
    select: {
      id: true,
      code: true,
      storageType: true,
      rack: true,
      level: true,
      depth: true,
      flankNumber: true,
    },
  },
} as const;

// The Putaway module — see [[wms-putaway-design]] in memory for the full
// design conversation this comes out of (2026-08-28). Covers: bin
// suggestion (ABC/multi-deep-lane-aware), BATCH/IMMEDIATE task creation
// hooked from Inbound's own scan/receipt-status code, the scan-driven
// execution flow (staging scan claims a trip, location scan completes it),
// "request different bin", and the receipt-level PUTAWAY_COMPLETE signal.
// Claim-expiry and the MultiSkuLaneException workflow live in their own
// files (putaway-claim-expiry.scheduler.ts, multi-sku-lane-exceptions.*).
@Injectable()
export class PutawayTasksService {
  constructor(private prisma: PrismaService) {}

  // ------------------------------------------------------------
  // Bin suggestion
  // ------------------------------------------------------------

  // "Same age" comparison — see Company.agingGranularity's schema comment.
  // Null granularity (nothing configured) means exact-match-only, the safe
  // default that in practice only ever matches trips within the same
  // continuous putaway operation.
  private sameAgeBucket(a: Date, b: Date, granularity: string | null): boolean {
    if (!granularity) return a.getTime() === b.getTime();
    if (granularity === 'DAY') return a.toDateString() === b.toDateString();
    if (granularity === 'MONTH')
      return (
        a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth()
      );
    if (granularity === 'WEEK') {
      const weekStart = (d: Date) => {
        const x = new Date(d);
        const day = (x.getDay() + 6) % 7; // Monday = 0
        x.setDate(x.getDate() - day);
        x.setHours(0, 0, 0, 0);
        return x.getTime();
      };
      return weekStart(a) === weekStart(b);
    }
    return false;
  }

  private maxSkusForClass(
    row: {
      maxSkusClassA: number | null;
      maxSkusClassB: number | null;
      maxSkusClassC: number | null;
    },
    abcClass: string,
  ): number | null {
    if (abcClass === 'A') return row.maxSkusClassA;
    if (abcClass === 'B') return row.maxSkusClassB;
    return row.maxSkusClassC;
  }

  // Combined ABC×FMS priority score (2026-09-09) — Ground's own analog to
  // Rack's independent aisle+level axes (see [[wms-abc-velocity-design]] in
  // memory for the full conversation). Ground has only one physical lever
  // (aisle/dock proximity), so FMS can only ever matter there by blending
  // into the same score ABC already drives, not by getting its own separate
  // lever. Lower = higher priority = wants the nearest bin: AF scores 2
  // (the best possible), CS scores 6 (the worst). D is scored identically
  // to CS — same "D behaves exactly like CS" precedent Rack's own level
  // tiebreak already established, not a separate "even worse" tier, since
  // there's no real signal to justify one. An unknown fmsClass (FMS not yet
  // computed for this warehouse) falls back to fmsRank = abcRank, which
  // collapses this formula to exactly 2×abcRank — the SAME relative
  // ordering as the old pure-ABC near/far split, so an unconfigured/
  // not-yet-classified SKU sees zero placement regression.
  private combinedPriorityScore(
    abcClass: string,
    fmsClass: string | null,
  ): number {
    if (abcClass === 'D') return 6;
    const abcRank = abcClass === 'A' ? 1 : abcClass === 'B' ? 2 : 3;
    const fmsRank =
      fmsClass === 'F'
        ? 1
        : fmsClass === 'M'
          ? 2
          : fmsClass === 'S'
            ? 3
            : abcRank;
    return abcRank + fmsRank;
  }

  // The core slotting algorithm. Returns a Location id, or null if nothing
  // eligible exists (the caller sets the task to NEEDS_BIN in that case).
  // excludeLocationIds — "request different bin" passes every location this
  // task has already been assigned to, so a re-suggestion can't loop back.
  // newStockDate — this putaway's own "age" (see resolveReceivedDate below)
  // for the same-SKU-top-up aging check.
  async suggestBin(
    tx: any,
    params: {
      warehouseId: string;
      skuId: string;
      excludeLocationIds?: string[];
      newStockDate?: Date | null;
    },
  ): Promise<string | null> {
    const {
      warehouseId,
      skuId,
      excludeLocationIds = [],
      newStockDate = null,
    } = params;

    const sku = await tx.sku.findUnique({ where: { id: skuId } });
    if (!sku) return null;
    // 2026-09-06 — Topic 2's real integration point with Topic 1's ABC
    // velocity reassessment: the per-warehouse COMPUTED class
    // (SkuWarehouseClass, real trailing-dispatch-derived, warehouse-scoped)
    // now takes priority over the manually-set/imported Sku.abcClass the
    // moment one exists for this warehouse — same override-when-known,
    // fall-back-otherwise chain as everywhere else in this codebase
    // (Vehicle overriding VehicleType, etc.). Without this, Topic 1's whole
    // "don't trust the import" effort would never actually affect real
    // placement decisions. Unclassified (neither exists) still defaults to
    // C, unchanged — confirmed 2026-08-28.
    const warehouseClass = await tx.skuWarehouseClass.findUnique({
      where: { skuId_warehouseId: { skuId, warehouseId } },
    });
    const abcClass = (
      warehouseClass?.abcClass ||
      sku.abcClass ||
      'C'
    ).toUpperCase();
    // FMS (Fast/Medium/Slow-moving) — 2026-09-08, see [[wms-abc-velocity-design]]
    // in memory for the full design conversation. A genuinely different axis
    // from ABC above (movement FREQUENCY, not quantity) — only ever set by
    // the same AbcClassificationService pass that sets abcClass, so it's
    // null until that feature is run for this warehouse, same "falls back
    // cleanly to today's behavior when unconfigured" shape as WarehouseDockZone's
    // outboundRanker. Not read at all for a D-class SKU — see preferHighLevel().
    const fmsClass = warehouseClass?.fmsClass?.toUpperCase() || null;

    const storageTypeRows = await tx.warehouseStorageType.findMany({
      where: { warehouseId, categoryId: sku.categoryId },
    });
    const eligibleStorageTypes: string[] = storageTypeRows
      .map((r: any) => r.storageType)
      .filter((t: string) => t !== 'MIX');
    if (eligibleStorageTypes.length === 0) return null;
    const storageTypeRowByType = new Map(
      storageTypeRows.map((r: any) => [r.storageType, r]),
    );

    const rawLocations = await tx.location.findMany({
      where: {
        warehouseId,
        zoneType: 'ACTUAL_STORAGE',
        storageType: { in: eligibleStorageTypes },
        isActive: true,
      },
    });
    if (rawLocations.length === 0) return null;

    // Location-level Category narrowing (2026-08-28 — see [[wms-putaway-design]]).
    // WarehouseStorageType above is only a warehouse-wide PLAN ("SPR is
    // meant to hold Category X somewhere, N positions worth") — it doesn't
    // say which specific racks. Location.categoryId is the actual per-rack
    // tag staff give at generation time; when at least one eligible rack
    // carries a tag matching this SKU's own Category, narrow to just those
    // — a much more precise suggestion than "any rack of the right storage
    // type." The moment NONE of them are tagged (tagging is optional, most
    // warehouses may never bother), fall back to the full untagged set —
    // confirmed explicitly: Putaway must never dead-end just because a
    // warehouse hasn't tagged its racks.
    const categoryTaggedLocations = sku.categoryId
      ? rawLocations.filter((l: any) => l.categoryId === sku.categoryId)
      : [];
    const locations =
      categoryTaggedLocations.length > 0
        ? categoryTaggedLocations
        : rawLocations;

    const locationIds = locations.map((l: any) => l.id);
    // agingGranularity is read straight off the Warehouse row (moved off
    // Company 2026-08-29 — see schema.prisma's comment on Warehouse.
    // agingGranularity: the client's own call, "depends on the node the
    // granularity might be different," same reasoning as
    // WarehouseEquipmentSuitability being warehouse-scoped rather than a
    // single platform/company-wide value). No separate Company lookup
    // needed any more.
    const [
      warehouse,
      movements,
      openTaskTargets,
      exception,
      dockZones,
      allAisleRows,
      allGroundPositionRows,
      allStillagePositionRows,
    ] = await Promise.all([
      tx.warehouse.findUnique({
        where: { id: warehouseId },
        select: { agingGranularity: true },
      }),
      tx.stockMovement.findMany({
        where: { locationId: { in: locationIds } },
        select: {
          locationId: true,
          skuId: true,
          quantity: true,
          receivedDate: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'asc' },
      }),
      tx.putawayTask.findMany({
        where: {
          toLocationId: { in: locationIds },
          status: { in: ['PENDING', 'NEEDS_BIN'] },
        },
        select: { toLocationId: true, skuId: true },
      }),
      tx.multiSkuLaneException.findFirst({
        where: { warehouseId, status: 'APPROVED' },
      }),
      // Dock-relative placement (Topic 2, 2026-09-06) — the warehouse's own
      // coarse dock-zone config, if any. See dock-zone.util.ts.
      tx.warehouseDockZone.findMany({ where: { warehouseId } }),
      // The FULL warehouse-wide distinct aisle list (not narrowed to this
      // SKU's own eligible storage types/category) — proximity has to be
      // computed against the warehouse's real physical aisle order, not
      // just whichever aisles happen to be eligible for this one SKU, or a
      // narrow eligible subset could wrongly redefine which end is "far."
      tx.location.findMany({
        where: {
          warehouseId,
          zoneType: 'ACTUAL_STORAGE',
          aisle: { not: null },
        },
        select: { aisle: true },
        distinct: ['aisle'],
      }),
      // Row-axis placement (step 2 of the 4-wall dock model, 2026-09-12) —
      // the FULL warehouse-wide (aisle, flankNumber, block) list for Ground,
      // same "not narrowed to this SKU's own eligible subset" discipline as
      // allAisleRows above, for the identical reason (a narrower subset
      // could wrongly redefine which end of a flank's own Row 1..N sequence
      // is "far"). Only Ground needs this today — see suggestGroundBin()'s
      // own comment for why Rack isn't touched yet.
      tx.location.findMany({
        where: {
          warehouseId,
          storageType: 'GROUND_FLOOR',
          aisle: { not: null },
          block: { not: null },
        },
        select: { aisle: true, flankNumber: true, block: true },
      }),
      // Row-axis for Stillage (2026-09-13 follow-up to the 2026-09-12 4-wall
      // dock model) — the client confirmed reusing the exact same row-axis
      // mechanism Ground already has ("we need the second row also for
      // stillage, same as ground"). A SEPARATE warehouse-wide group from
      // Ground's own (below), keyed by `stack` instead of `block` — the two
      // storage types can never share an Aisle (assertNoConflictingFamily()
      // in locations.service.ts hard-blocks that), so their row sequences
      // are physically unrelated axes and must be normalized against their
      // OWN longest sequence, not against each other's.
      tx.location.findMany({
        where: {
          warehouseId,
          storageType: 'STILLAGE',
          aisle: { not: null },
          stack: { not: null },
        },
        select: { aisle: true, flankNumber: true, stack: true },
      }),
    ]);
    const outboundRanker = buildOutboundProximityRanker(
      allAisleRows
        .map((r: any) => r.aisle)
        .filter((a: string | null): a is string => !!a),
      dockZones,
    );
    // Row-axis: "Row 1..N" is only ever meaningful within ONE (aisle, flank)
    // at a time (see buildRowProximityRanker's own comment) — group the
    // full warehouse-wide Ground position list that way, sorting each
    // group's distinct blocks numerically (`Number(x)||0`, matching this
    // file's own established convention elsewhere, e.g. the column-sorting
    // a few lines into suggestGroundBin() below — not the frontend's
    // separate naturalCompare, no shared code exists between the two
    // sides).
    const rowRanker = buildRowProximityRanker(dockZones);
    const groundRowGroups = new Map<string, string[]>();
    // Normalized against the WAREHOUSE-WIDE longest row sequence, NOT each
    // group's own length (2026-09-12 — a real bug the client caught live:
    // "GF-5-BLK10B... : 9 (CS), but GF-3-BLK08... : 4 (BF), both are
    // parallel, but they are having different ranks"). Aisle 5's flanks
    // only have 10 distinct blocks; Aisle 3's have 20 — a per-GROUP max
    // made the identical physical row position (e.g. "4th block from the
    // dock wall") read as a much WORSE fraction in the shorter aisle than
    // the longer one, even though both sit the same real distance from a
    // wall-spanning South dock. Every aisle's Row 1 anchors to the exact
    // same shared line (see buildBoxesForAisle()'s own z=0-at-Row-1
    // convention) — a raw row index means the same real depth everywhere,
    // so the SAME "full list, not narrowed to what's available right now"
    // discipline buildOutboundProximityRanker() itself already uses for
    // the aisle axis applies here too: normalize by the longest row
    // sequence found ANYWHERE in the warehouse, not by whichever aisle a
    // given candidate happens to be in.
    let globalMaxRowIndex = 0;
    if (rowRanker) {
      for (const r of allGroundPositionRows as any[]) {
        const key = `${r.aisle}|${r.flankNumber ?? 'x'}`;
        if (!groundRowGroups.has(key)) groundRowGroups.set(key, []);
        groundRowGroups.get(key)!.push(r.block);
      }
      for (const [key, positions] of groundRowGroups) {
        const sorted = Array.from(new Set(positions)).sort(
          (a, b) => (Number(a) || 0) - (Number(b) || 0),
        );
        groundRowGroups.set(key, sorted);
        globalMaxRowIndex = Math.max(globalMaxRowIndex, sorted.length - 1);
      }
    }

    // Stillage's own row-axis groups — same shape as Ground's above, keyed
    // by `stack` instead of `block`, normalized against ITS OWN longest
    // sequence (see this batch's own query comment for why the two storage
    // types' row axes can't be compared against a shared global max).
    const stillageRowGroups = new Map<string, string[]>();
    let globalMaxStillageRowIndex = 0;
    if (rowRanker) {
      for (const r of allStillagePositionRows as any[]) {
        const key = `${r.aisle}|${r.flankNumber ?? 'x'}`;
        if (!stillageRowGroups.has(key)) stillageRowGroups.set(key, []);
        stillageRowGroups.get(key)!.push(r.stack);
      }
      for (const [key, positions] of stillageRowGroups) {
        const sorted = Array.from(new Set(positions)).sort(
          (a, b) => (Number(a) || 0) - (Number(b) || 0),
        );
        stillageRowGroups.set(key, sorted);
        globalMaxStillageRowIndex = Math.max(
          globalMaxStillageRowIndex,
          sorted.length - 1,
        );
      }
    }

    // 2026-08-29 fix: default to same-CALENDAR-DAY, not exact-millisecond-
    // match. Before this fix (and before the field moved to Warehouse),
    // this was completely unwired anywhere (no Settings UI/API existed),
    // so every warehouse always read `null` here — which in practice meant
    // two separate trips of the same SKU (e.g. one unloaded in the
    // morning, another in the evening) were always treated as a different
    // "age," even same-day, closing a partially-filled lane's remaining
    // depth to the second trip. Confirmed with the client: "same calendar
    // day would do" — exact-millisecond was "too much check." A warehouse
    // can still be configured to WEEK/MONTH via Company Settings' per-
    // warehouse "Aging Methodology" control.
    const agingGranularity: string | null =
      warehouse?.agingGranularity ?? 'DAY';
    const exceptionActive = !!exception;

    // balance + last receivedDate per (location, sku)
    const balanceByLocSku = new Map<string, number>();
    const lastReceivedDateByLocSku = new Map<string, Date | null>();
    // 2026-09-06 hardening-pass perf fix: an index of the SAME balances,
    // keyed by location first (locationId -> skuId -> balance) — several
    // spots below used to re-scan the ENTIRE balanceByLocSku map with a
    // string startsWith() check for every single candidate location, which
    // made suggestBin() cost grow with the warehouse's WHOLE movement
    // history, not just the handful of SKUs a given location has ever
    // held. Built once here, alongside the flat map (same source data, one
    // pass), so every later per-location lookup below is O(distinct SKUs
    // at that location) instead of O(every balance entry in the warehouse).
    const skuBalancesByLocation = new Map<string, Map<string, number>>();
    for (const m of movements) {
      const key = `${m.locationId}|${m.skuId}`;
      const newBalance = (balanceByLocSku.get(key) || 0) + Number(m.quantity);
      balanceByLocSku.set(key, newBalance);
      if (Number(m.quantity) > 0 && m.receivedDate)
        lastReceivedDateByLocSku.set(key, m.receivedDate);
      let perLocation = skuBalancesByLocation.get(m.locationId);
      if (!perLocation) {
        perLocation = new Map<string, number>();
        skuBalancesByLocation.set(m.locationId, perLocation);
      }
      perLocation.set(m.skuId, newBalance);
    }
    const targetedLocationIds = new Set(
      openTaskTargets.map((t: any) => t.toLocationId).filter(Boolean),
    );
    // 2026-08-29 fix: a bin already the destination of another still-open
    // (PENDING/NEEDS_BIN) task is "reserved" for that task's SKU even
    // before the trip physically completes — the occupant set below must
    // count this alongside real StockMovement balances, or two units of the
    // same SKU scanned close together (before the first trip completes)
    // each see the lane as empty and get suggested into DIFFERENT
    // lanes/levels instead of continuing to fill the same one's remaining
    // depths first (the reported bug — confirmed: same-age same-SKU stock
    // should fill out one lane's D2/D1 before ever opening a new level).
    const pendingSkuByLocation = new Map<string, string>();
    for (const t of openTaskTargets)
      if (t.toLocationId) pendingSkuByLocation.set(t.toLocationId, t.skuId);

    // 2026-08-29 — "still incoming" lane reservation (client-requested,
    // Class B & C — see [[wms-putaway-design]]). A SKU still actively
    // receiving from an in-progress vehicle should get its lane to
    // itself while more of it is still coming — otherwise an unrelated
    // SKU can "steal" a depth mid-delivery and fragment the larger SKU's
    // shipment across two lanes (confirmed scenario: a 3-unit SKU whose
    // 2nd depth gets taken by a different SKU's single unit, forcing the
    // 3rd unit into a brand-new lane). Class A needs no special handling
    // here — its cap of 1 already locks a lane to one SKU permanently,
    // not just "while incoming," so this rule can't change anything
    // there. "Still incoming" = does this SKU have ANY InboundReceiptLine
    // with receivedQty < expectedQty — reused directly, no new schema,
    // since that IS "more of this SKU is still coming off some vehicle."
    // Bypassed by an active MultiSkuLaneException, same as the
    // maxSkusClass* cap itself — one consistent "the exception turns off
    // all mixing protection" behavior, not a second separate override.
    const allOccupantSkuIds = new Set<string>();
    for (const [key, qty] of balanceByLocSku)
      if (qty > 0) allOccupantSkuIds.add(key.split('|')[1]);
    for (const sid of pendingSkuByLocation.values()) allOccupantSkuIds.add(sid);
    const stillIncomingSkuIds = new Set<string>();
    // 2026-09-06 hardening-pass perf fix: every occupant SKU's abcClass used
    // to be fetched with its own tx.sku.findUnique() call PER LANE (inside
    // the lanes loop below) — one DB round trip per (lane, occupant SKU)
    // pair instead of one query total. Batched here alongside the existing
    // "still incoming" lookup, which already has the exact same
    // allOccupantSkuIds set in hand.
    const abcClassBySkuId = new Map<string, string>();
    if (!exceptionActive && allOccupantSkuIds.size > 0) {
      const [occupantLines, occupantSkus] = await Promise.all([
        tx.inboundReceiptLine.findMany({
          where: { skuId: { in: [...allOccupantSkuIds] } },
          select: { skuId: true, expectedQty: true, receivedQty: true },
        }),
        tx.sku.findMany({
          where: { id: { in: [...allOccupantSkuIds] } },
          select: { id: true, abcClass: true },
        }),
      ]);
      for (const l of occupantLines) {
        if (Number(l.receivedQty) < Number(l.expectedQty))
          stillIncomingSkuIds.add(l.skuId);
      }
      for (const s of occupantSkus)
        abcClassBySkuId.set(s.id, (s.abcClass || 'C').toUpperCase());
    }

    // 2026-09-06 — Ground/Floor Putaway (see wms-putaway-design memory for
    // the full design conversation). Deliberately dispatches to two fully
    // SEPARATE methods below rather than threading a storageType branch
    // through one shared candidate loop — the client's own explicit ask
    // ("keep all logic for different storage type separate, like ground is
    // sep, rack is sep"), same discipline Drive-in already got split out
    // from SPR/ASRS with. Both methods are pure, synchronous, in-memory
    // logic — no further DB queries needed, everything they read was
    // already fetched above in this shared setup.
    const rackLocations = locations.filter((l: any) =>
      RACK_STORAGE_TYPES.includes(l.storageType),
    );
    const groundLocations = locations.filter(
      (l: any) => l.storageType === 'GROUND_FLOOR',
    );
    const stillageLocations = locations.filter(
      (l: any) => l.storageType === 'STILLAGE',
    );
    const ctx = {
      skuId,
      abcClass,
      fmsClass,
      storageTypeRowByType,
      balanceByLocSku,
      skuBalancesByLocation,
      lastReceivedDateByLocSku,
      pendingSkuByLocation,
      targetedLocationIds,
      stillIncomingSkuIds,
      abcClassBySkuId,
      exceptionActive,
      agingGranularity,
      newStockDate,
      excludeLocationIds,
      outboundRanker,
      rowRanker,
      groundRowGroups,
      globalMaxRowIndex,
      stillageRowGroups,
      globalMaxStillageRowIndex,
      movements,
    };

    // Rack tried first, Ground then Stillage as fallbacks — a simple,
    // explicitly-flagged placeholder ordering for the (probably rare) case
    // where one Category is eligible for more than one storage type in the
    // same warehouse; not a decision that's actually been discussed, and
    // one more thing the future FMS×ABC study (see wms-abc-velocity-design
    // memory) may eventually want to revisit rather than a fixed priority.
    const rackResult = this.suggestRackBin(rackLocations, ctx);
    if (rackResult) return rackResult;
    const groundResult = this.suggestGroundBin(groundLocations, ctx);
    if (groundResult) return groundResult;
    return this.suggestStillageBin(stillageLocations, ctx);
  }

  // ------------------------------------------------------------
  // RACK bin suggestion (SPR/Drive-in/ASRS) — moved out of suggestBin()
  // verbatim, 2026-09-06, purely to give it the same clean separation from
  // Ground/Floor's own logic below. No behavior change from before this
  // split; every comment/rule here predates the split.
  // ------------------------------------------------------------
  private suggestRackBin(locations: any[], ctx: any): string | null {
    const {
      skuId,
      abcClass,
      fmsClass,
      storageTypeRowByType,
      balanceByLocSku,
      skuBalancesByLocation,
      lastReceivedDateByLocSku,
      pendingSkuByLocation,
      targetedLocationIds,
      stillIncomingSkuIds,
      abcClassBySkuId,
      exceptionActive,
      agingGranularity,
      newStockDate,
      excludeLocationIds,
      outboundRanker,
    } = ctx;

    // group into lanes
    const lanes = new Map<string, any[]>();
    for (const loc of locations) {
      const key = laneKeyOf(loc);
      if (!lanes.has(key)) lanes.set(key, []);
      lanes.get(key)!.push(loc);
    }

    type Candidate = {
      locationId: string;
      occupancyCount: number;
      flankNumber: number | null;
      aisle: string | null;
      level: string | null;
      storageType: string;
    };
    const candidates: Candidate[] = [];

    for (const laneLocations of lanes.values()) {
      const storageType = laneLocations[0].storageType;
      const row: any = storageTypeRowByType.get(storageType);
      if (!row) continue;

      // Distinct occupant SKUs across the WHOLE lane (every depth position
      // pooled together — see [[wms-putaway-design]]'s "whole lane, not
      // per-position" resolution).
      const occupantSkuIds = new Set<string>();
      for (const loc of laneLocations) {
        const perLocation = skuBalancesByLocation.get(loc.id);
        if (perLocation)
          for (const [sid, qty] of perLocation)
            if (qty > 0) occupantSkuIds.add(sid);
        const pendingSku = pendingSkuByLocation.get(loc.id);
        if (pendingSku) occupantSkuIds.add(pendingSku);
      }

      let laneEligible = true;

      if (occupantSkuIds.size === 0) {
        laneEligible = true;
      } else if (occupantSkuIds.size === 1 && occupantSkuIds.has(skuId)) {
        // Same-SKU top-up — always eligible on distinct-SKU-count grounds;
        // gated instead by the aging check (rule: only if age matches, or
        // no prior age is on file to compare against).
        let existingDate: Date | null = null;
        for (const loc of laneLocations) {
          const d = lastReceivedDateByLocSku.get(`${loc.id}|${skuId}`);
          if (d) existingDate = d;
        }
        if (
          existingDate &&
          newStockDate &&
          !this.sameAgeBucket(existingDate, newStockDate, agingGranularity)
        ) {
          laneEligible = false; // must fully empty before a different-age batch can enter
        }
      } else if (storageType === 'DRIVE_IN') {
        // Absolute, unconditional single-SKU-per-column — 2026-09-02, see
        // CLAUDE.md's Putaway section. Unlike SPR's maxSkusClass* cap,
        // this is NOT a policy choice this codebase can relax: an MHE
        // drives into a Drive-in lane from one opening and physically
        // cannot dig past stock to reach a different SKU buried behind or
        // above it, so there is no bypass for it, not even an approved
        // MultiSkuLaneException (confirmed explicitly — "its not possible
        // to remove 30 bins to find 1 sku if its B/C class"). The "still
        // incoming" reservation is correspondingly redundant here too,
        // same reason it already is for Class A: this lock is permanent,
        // not conditional on anything.
        laneEligible = false;
      } else {
        // Cross-SKU mixing (SPR/ASRS only) — governed by maxSkusClass*,
        // most-restrictive-class-wins across every occupant AND the
        // incoming SKU, UNLESS an approved MultiSkuLaneException is
        // currently active for this warehouse (the only bypass, per
        // [[wms-putaway-design]]).
        if (!exceptionActive) {
          // "Still incoming" reservation overrides the mixing cap
          // entirely — checked BEFORE the cap logic, not folded into it,
          // since it's an unconditional block, not another tier of the
          // same cap math.
          const anyOccupantStillIncoming = [...occupantSkuIds].some((id) =>
            stillIncomingSkuIds.has(id),
          );
          if (anyOccupantStillIncoming) {
            laneEligible = false;
          } else {
            const occupantClasses = [...occupantSkuIds].map(
              (id) => abcClassBySkuId.get(id) || 'C',
            );
            const caps = [abcClass, ...occupantClasses].map((cls) =>
              this.maxSkusForClass(row, cls),
            );
            // null = unbounded; the most restrictive (lowest, non-null) cap wins.
            const finiteCaps = caps.filter((c): c is number => c !== null);
            const effectiveCap =
              finiteCaps.length > 0 ? Math.min(...finiteCaps) : null;
            if (effectiveCap !== null && occupantSkuIds.size >= effectiveCap)
              laneEligible = false;
          }
          // An A-class occupant's own cap (1) makes effectiveCap 1 the
          // moment it's present, which — combined with occupantSkuIds.size
          // already being >=1 — always blocks a different SKU. Matches
          // "till a A class is there... it should get empty" exactly.
        }
      }

      if (!laneEligible) continue;
      if (
        excludeLocationIds.includes(laneLocations[0].id) &&
        laneLocations.length === 1
      )
        continue;

      // Deepest-first fill: among this lane's positions, pick the one with
      // the HIGHEST depth that's currently empty, not already targeted by
      // another open task, and not in the excluded list. Level ASC is a
      // pure tiebreaker for Drive-in's whole-column lanes (2026-09-02) —
      // several levels can share the same depth number, so once the
      // deepest tier is chosen, fill it bottom-up before moving to the
      // next-shallower tier (confirmed: "it has to fill deepest of all
      // levels, then the rest etc, progressive in that way" — matches how
      // an MHE actually loads, ground level first). A no-op for SPR/ASRS,
      // whose lanes only ever contain one level's positions to begin with.
      const sorted = [...laneLocations].sort(
        (a, b) =>
          (b.depth ?? 0) - (a.depth ?? 0) ||
          (Number(a.level) || 0) - (Number(b.level) || 0),
      );
      const target = sorted.find(
        (loc) =>
          (balanceByLocSku.get(`${loc.id}|${skuId}`) || 0) <= 0 &&
          !targetedLocationIds.has(loc.id) &&
          !excludeLocationIds.includes(loc.id) &&
          ![...(skuBalancesByLocation.get(loc.id)?.values() ?? [])].some(
            (qty) => qty > 0,
          ),
      );
      if (!target) continue; // lane has no genuinely free position right now (sealed if full, or all free ones excluded/targeted)

      // How many of this lane's positions are already occupied (real stock
      // OR a pending reservation), by ANYONE — used below to prefer
      // finishing off the fullest eligible lane, not just any lane with
      // an occupant. 2026-08-29 fix, replacing an earlier two-tier
      // same-SKU/any-occupant scheme that let "exact same SKU, own mostly-
      // empty lane elsewhere" wrongly outrank a lane that was already
      // fuller with a DIFFERENT SKU — caught by the client's own trace: a
      // lane at 2/3 full should win over a lane at 1/3 full for ANY
      // eligible incoming SKU, not just that lane's own original tenant.
      const occupancyCount = laneLocations.filter(
        (loc: any) =>
          [...(skuBalancesByLocation.get(loc.id)?.values() ?? [])].some(
            (qty) => qty > 0,
          ) || pendingSkuByLocation.has(loc.id),
      ).length;

      candidates.push({
        locationId: target.id,
        occupancyCount,
        flankNumber: target.flankNumber ?? null,
        aisle: target.aisle ?? null,
        level: target.level ?? null,
        storageType: target.storageType,
      });
    }

    if (candidates.length === 0) return null;

    // Preference order, confirmed 2026-09-06 (Topic 2 — see
    // wms-abc-velocity-design memory): (1) prefer the FULLEST eligible
    // lane — most positions already occupied by anyone, same SKU or a
    // different compatible one — so a lane sitting at 2/3 full always wins
    // over one at 1/3 full. This naturally makes same-SKU top-up "win" too
    // (a lane holding only this SKU has no competition, so it's already
    // the fullest option for it) without needing a separate same-SKU rule
    // — and for A-class it collapses back to exactly today's behavior,
    // since A's maxSkusClassA=1 cap means the only way a lane can have ANY
    // occupant at all is if it's this exact SKU. 2026-08-29 — the client's
    // own "3 C-class SKUs should share one lane's 3 depths, not open 3
    // separate levels" correction, refined a second time after the
    // client's own trace showed the first fix was still too coarse
    // (exact-SKU-match beating a fuller different-SKU lane).
    // (2) Outbound-proximity — confirmed as the PRIMARY tiebreak once a
    // warehouse has real WarehouseDockZone config ("Outbound-proximity
    // wins first"): near-movers (A/B, and any unclassified SKU, matching
    // this codebase's existing "unclassified defaults to C-like" fallback
    // being the ONLY thing that prefers far) want low proximity rank
    // (near Outbound), C/D want high rank (far from Outbound, matching
    // maxSkusForClass()'s own A/B-vs-everything-else split above).
    // (3) Level — secondary tiebreak, SPR/ASRS only; Drive-in's own
    // within-column fill order already fully governs level via its
    // (depth DESC, level ASC) sort (see laneKeyOf()'s 2026-09-02 comment),
    // so applying it again here as a between-LANE tiebreak would fight
    // that rather than help it. (4) flankNumber — the original, purely
    // arbitrary creation-order proxy, kept as the final fallback so an
    // unconfigured warehouse (no dock zones at all) behaves EXACTLY as it
    // always has ("First-available" for Drive-in falls out of this same
    // ordering — whichever eligible column sorts first by proximity/level/
    // flank simply wins, no separate reservation logic needed).
    //
    // 2026-09-08 — FMS×ABC combined classification (see
    // [[wms-abc-velocity-design]] in memory for the full design
    // conversation): the aisle tiebreak (2) and the level tiebreak (3) are
    // now driven by two INDEPENDENT signals instead of one shared boolean —
    // ABC still decides aisle exactly as before (preferFarAisle, unchanged
    // computation), FMS now decides level (preferHighLevel) instead of ABC.
    // Confirmed directly as the chosen mechanism over a single hand-ranked
    // 1-9 combined score: this is a two-line change to a sort that already
    // works, can't misplace a SKU due to an arbitrary aisle-vs-level
    // weighting, and matches physical reality (aisle-to-aisle walking
    // distance is a real, much bigger cost than one shelf level's reach
    // effort, so aisle proximity should always win a tie over level, which
    // it still does here — sequential stages, unchanged order).
    const preferFarAisle = abcClass !== 'A' && abcClass !== 'B'; // C/D — same fallback bucket maxSkusForClass() already uses
    // D behaves exactly like CS (far aisle, high level) — confirmed
    // directly ("D, you can treat to be the futherest, or want to merge
    // with C?" → merge): no FMS lookup for a D-class SKU, no separate
    // "even further" tier, since there's no physical lever left to express
    // one (both axes already bottom out at C's own values). For F/M/S,
    // only S prefers a high level — F and M both default to preferring the
    // easy-reach low level, a deliberate judgment call (M has no strong
    // pull either way; grouping it with F costs nothing structurally,
    // where wrongly pushing a genuinely frequent mover to a high level
    // would). When fmsClass hasn't been computed yet for this warehouse
    // (feature not run, or not enabled), fall back to preferFarAisle —
    // today's ABC-only behavior, zero regression for a company not using
    // this yet, same "unconfigured falls back cleanly" shape as
    // outboundRanker itself.
    const preferHighLevel =
      abcClass === 'D' ? true : fmsClass ? fmsClass === 'S' : preferFarAisle;
    candidates.sort((a, b) => {
      if (a.occupancyCount !== b.occupancyCount)
        return b.occupancyCount - a.occupancyCount;

      if (outboundRanker) {
        const ra =
          a.aisle != null ? outboundRanker(a.aisle) : Number.MAX_SAFE_INTEGER;
        const rb =
          b.aisle != null ? outboundRanker(b.aisle) : Number.MAX_SAFE_INTEGER;
        if (ra !== rb) return preferFarAisle ? rb - ra : ra - rb;
      }

      if (
        a.storageType !== 'DRIVE_IN' &&
        b.storageType !== 'DRIVE_IN' &&
        a.level != null &&
        b.level != null
      ) {
        const la = Number(a.level) || 0;
        const lb = Number(b.level) || 0;
        if (la !== lb) return preferHighLevel ? lb - la : la - lb;
      }

      const fa = a.flankNumber ?? Number.MAX_SAFE_INTEGER;
      const fb = b.flankNumber ?? Number.MAX_SAFE_INTEGER;
      return preferFarAisle ? fb - fa : fa - fb;
    });

    return candidates[0].locationId;
  }

  // Restrictiveness order among the four classes, most restrictive first —
  // used to pick which class's rules govern a bin holding more than one
  // class's worth of SKU (the incoming one plus every current occupant),
  // same "most-restrictive-wins" principle suggestRackBin() already uses,
  // just needing a real ordering here since Ground's D class didn't exist
  // as a concept in Rack's own cap math.
  private static readonly GROUND_CLASS_RESTRICTIVENESS = ['A', 'B', 'C', 'D'];
  private mostRestrictiveGroundClass(classes: string[]): string {
    let best = 'D';
    let bestRank = PutawayTasksService.GROUND_CLASS_RESTRICTIVENESS.length;
    for (const cls of classes) {
      const rank =
        PutawayTasksService.GROUND_CLASS_RESTRICTIVENESS.indexOf(cls);
      const effectiveRank =
        rank === -1
          ? PutawayTasksService.GROUND_CLASS_RESTRICTIVENESS.indexOf('C')
          : rank;
      if (effectiveRank < bestRank) {
        bestRank = effectiveRank;
        best = PutawayTasksService.GROUND_CLASS_RESTRICTIVENESS[effectiveRank];
      }
    }
    return best;
  }

  // Whether a column must stay internally single-SKU for this class, per
  // WarehouseStorageType.respectsColumnBoundariesClassA/B/C/D — see
  // schema.prisma's comment and the Ground design conversation in
  // wms-putaway-design. Defaults true (the safe, expected behavior) for any
  // unrecognized class rather than silently allowing free mixing.
  private respectsColumnBoundaries(row: any, cls: string): boolean {
    const field = `respectsColumnBoundariesClass${cls}`;
    return row && field in row ? !!row[field] : true;
  }

  // A column position is CLOSED to new putaway once it's had a real
  // pick/dispatch-type decrease since it last returned to exactly zero,
  // until it returns to fully empty again — the column-lifecycle rule from
  // the Ground design conversation (wms-putaway-design memory), the
  // client's own explicit call once asked whether to relax it for a
  // same-SKU top-up: "yes we cannot use it, we will do a consolidation
  // strategy for these" (i.e. the reslotting engine's job, not Putaway's).
  // Walks each Ground location's own movement history (already fetched,
  // ordered by createdAt ascending, for this whole suggestBin() call) once;
  // dormant until Picking exists — no negative movement is ever written to
  // a Location yet — but correct and ready the moment it does, rather than
  // needing a second pass through this code later.
  private computeClosedGroundLocationIds(
    movements: any[],
    groundLocationIds: Set<string>,
  ): Set<string> {
    const closed = new Set<string>();
    const byLocation = new Map<string, any[]>();
    for (const m of movements) {
      if (!groundLocationIds.has(m.locationId)) continue;
      if (!byLocation.has(m.locationId)) byLocation.set(m.locationId, []);
      byLocation.get(m.locationId)!.push(m);
    }
    for (const [locId, locMovements] of byLocation) {
      let running = 0;
      let depletedSinceZero = false;
      for (const m of locMovements) {
        const qty = Number(m.quantity);
        if (qty < 0 && running > 0) depletedSinceZero = true;
        running += qty;
        if (running <= 0) {
          running = 0;
          depletedSinceZero = false;
        }
      }
      if (depletedSinceZero) closed.add(locId);
    }
    return closed;
  }

  // ------------------------------------------------------------
  // GROUND/FLOOR bin suggestion — 2026-09-06, see the full design
  // conversation in the wms-putaway-design memory. DELIBERATELY a fully
  // separate method from suggestRackBin() above, not a shared function
  // with storageType branches threaded through it — the client's own
  // explicit ask, same discipline Drive-in already got split out from
  // SPR/ASRS with. Ground's physical shape genuinely needs TWO levels of
  // grouping where Rack only ever needed one: a BIN (one physical
  // footprint, `aisle+block+flankNumber`) subdivides into COLUMNS (single-
  // file LIFO lines, `aisle+block+flankNumber+rack` where `rack` is reused
  // as the column number) — mechanically identical to a Rack lane, just
  // laid flat on the floor instead of racked.
  // ------------------------------------------------------------
  private suggestGroundBin(groundLocations: any[], ctx: any): string | null {
    if (groundLocations.length === 0) return null;
    const {
      skuId,
      abcClass,
      fmsClass,
      storageTypeRowByType,
      balanceByLocSku,
      skuBalancesByLocation,
      lastReceivedDateByLocSku,
      pendingSkuByLocation,
      targetedLocationIds,
      stillIncomingSkuIds,
      abcClassBySkuId,
      exceptionActive,
      agingGranularity,
      newStockDate,
      excludeLocationIds,
      outboundRanker,
      rowRanker,
      groundRowGroups,
      globalMaxRowIndex,
      movements,
    } = ctx;

    const row: any = storageTypeRowByType.get('GROUND_FLOOR');
    if (!row) return null;

    const groundLocationIds = new Set(groundLocations.map((l: any) => l.id));
    const closedLocationIds = this.computeClosedGroundLocationIds(
      movements,
      groundLocationIds,
    );

    const binKeyOf = (loc: any) =>
      `${loc.aisle}|${loc.block}|${loc.flankNumber}`;
    const columnKeyOf = (loc: any) => `${binKeyOf(loc)}|${loc.rack}`;

    const bins = new Map<string, any[]>();
    for (const loc of groundLocations) {
      const key = binKeyOf(loc);
      if (!bins.has(key)) bins.set(key, []);
      bins.get(key)!.push(loc);
    }

    type Candidate = {
      locationId: string;
      occupancyCount: number;
      flankNumber: number | null;
      aisle: string | null;
      block: string | null;
      storageType: string;
    };
    const candidates: Candidate[] = [];

    for (const binLocations of bins.values()) {
      // Distinct occupant SKUs across the WHOLE BIN (every column pooled
      // together) — same "whole shared unit, not per-position" resolution
      // as Rack's own lane, just one grouping level up (bin instead of
      // lane, since a Ground bin's columns are the SKU-sharing eligibility
      // unit here).
      const occupantSkuIds = new Set<string>();
      for (const loc of binLocations) {
        const perLocation = skuBalancesByLocation.get(loc.id);
        if (perLocation)
          for (const [sid, qty] of perLocation)
            if (qty > 0) occupantSkuIds.add(sid);
        const pendingSku = pendingSkuByLocation.get(loc.id);
        if (pendingSku) occupantSkuIds.add(pendingSku);
      }

      const occupantClasses = [...occupantSkuIds].map(
        (id) => abcClassBySkuId.get(id) || 'C',
      );
      const classesInPlay = [abcClass, ...occupantClasses];
      const mostRestrictiveClass =
        this.mostRestrictiveGroundClass(classesInPlay);
      const boundaryRespected = this.respectsColumnBoundaries(
        row,
        mostRestrictiveClass,
      );

      let binEligible = true;

      if (occupantSkuIds.size === 0) {
        binEligible = true;
      } else if (occupantSkuIds.size === 1 && occupantSkuIds.has(skuId)) {
        // Same-SKU top-up — handled at column level below (aging-gated);
        // bin-level eligibility is fine regardless of the boundary toggle.
        binEligible = true;
      } else if (boundaryRespected) {
        // Column-respecting sharing (A/B/C's default) — same
        // most-restrictive-wins cap math as Rack, counting distinct SKUs
        // across this bin's COLUMNS instead of a lane's depth positions.
        // "Still incoming" applies here too, same reasoning as Rack: B/C
        // only (redundant once boundaries are respected AND the class is
        // A, since A's cap of 1 is already exclusive; meaningless once
        // boundaries aren't respected at all).
        if (!exceptionActive) {
          const anyOccupantStillIncoming = [...occupantSkuIds].some((id) =>
            stillIncomingSkuIds.has(id),
          );
          if (anyOccupantStillIncoming) {
            binEligible = false;
          } else {
            const caps = classesInPlay.map((cls) =>
              this.maxSkusForClass(row, cls),
            );
            const finiteCaps = caps.filter((c): c is number => c !== null);
            const effectiveCap =
              finiteCaps.length > 0 ? Math.min(...finiteCaps) : null;
            const columnsOccupied = new Set(
              binLocations
                .filter(
                  (l: any) =>
                    (skuBalancesByLocation.get(l.id)?.size ?? 0) > 0 ||
                    pendingSkuByLocation.has(l.id),
                )
                .map((l: any) => l.rack),
            ).size;
            if (effectiveCap !== null && columnsOccupied >= effectiveCap)
              binEligible = false;
          }
        }
      } else {
        // Boundary NOT respected for this class (D's default, or C opted
        // in) — free per-pallet mixing, no SKU-count cap at all; the only
        // remaining question is whether there's any genuinely free
        // position left, checked below.
        binEligible = true;
      }

      if (!binEligible) continue;

      // Column/position selection within this eligible bin.
      const columns = new Map<string, any[]>();
      for (const loc of binLocations) {
        const key = columnKeyOf(loc);
        if (!columns.has(key)) columns.set(key, []);
        columns.get(key)!.push(loc);
      }

      let target: any = null;

      if (boundaryRespected) {
        // Prefer topping up an existing same-SKU column whose age matches
        // and isn't closed (confirmed this will be the RARE case — the
        // ordinary case is opening the next unused column, lowest column
        // number first).
        const sortedColumns = [...columns.values()].sort(
          (a, b) => (Number(a[0].rack) || 0) - (Number(b[0].rack) || 0),
        );
        let bestColumn: any[] | null = null;
        for (const columnLocations of sortedColumns) {
          if (columnLocations.some((l: any) => closedLocationIds.has(l.id)))
            continue;
          const colOccupants = new Set<string>();
          for (const loc of columnLocations) {
            const perLocation = skuBalancesByLocation.get(loc.id);
            if (perLocation)
              for (const [sid, qty] of perLocation)
                if (qty > 0) colOccupants.add(sid);
          }
          if (colOccupants.size !== 1 || !colOccupants.has(skuId)) continue;
          const hasRoom = columnLocations.some(
            (l: any) =>
              (balanceByLocSku.get(`${l.id}|${skuId}`) || 0) <= 0 &&
              !targetedLocationIds.has(l.id) &&
              !excludeLocationIds.includes(l.id),
          );
          if (!hasRoom) continue;
          let existingDate: Date | null = null;
          for (const loc of columnLocations) {
            const d = lastReceivedDateByLocSku.get(`${loc.id}|${skuId}`);
            if (d) existingDate = d;
          }
          if (
            existingDate &&
            newStockDate &&
            !this.sameAgeBucket(existingDate, newStockDate, agingGranularity)
          )
            continue;
          bestColumn = columnLocations;
          break;
        }
        if (!bestColumn) {
          bestColumn =
            sortedColumns.find((columnLocations) => {
              if (columnLocations.some((l: any) => closedLocationIds.has(l.id)))
                return false;
              const hasAnyOccupant = columnLocations.some(
                (l: any) =>
                  (skuBalancesByLocation.get(l.id)?.size ?? 0) > 0 ||
                  pendingSkuByLocation.has(l.id),
              );
              return !hasAnyOccupant;
            }) ?? null;
        }
        if (bestColumn) {
          // Deepest-first fill within the chosen column — same convention
          // Rack/Drive-in already use (an MHE pushes each new pallet all
          // the way to the back first).
          const sortedPositions = [...bestColumn].sort(
            (a, b) => (b.depth ?? 0) - (a.depth ?? 0),
          );
          target =
            sortedPositions.find(
              (loc: any) =>
                (balanceByLocSku.get(`${loc.id}|${skuId}`) || 0) <= 0 &&
                !targetedLocationIds.has(loc.id) &&
                !excludeLocationIds.includes(loc.id),
            ) ?? null;
        }
      } else {
        // Free-mixing mode — no column purity required; prefer completing
        // the fullest column first (same "prefer the fullest" principle as
        // everywhere else in this codebase), deepest empty position within
        // it, skipping closed columns exactly as the boundary-respecting
        // path does.
        const ranked = [...columns.values()]
          .filter(
            (columnLocations) =>
              !columnLocations.some((l: any) => closedLocationIds.has(l.id)),
          )
          .map((columnLocations) => ({
            columnLocations,
            occupied: columnLocations.filter(
              (l: any) =>
                (skuBalancesByLocation.get(l.id)?.size ?? 0) > 0 ||
                pendingSkuByLocation.has(l.id),
            ).length,
          }))
          .sort((a, b) => b.occupied - a.occupied);
        for (const { columnLocations } of ranked) {
          const sortedPositions = [...columnLocations].sort(
            (a, b) => (b.depth ?? 0) - (a.depth ?? 0),
          );
          // Free-mixing means a column can hold several different SKUs at
          // once, so "is this position free" must check for NO occupant AT
          // ALL, not just "no stock of THIS SKU" — the same real distinction
          // Rack's own target-finding already has to make, but one that
          // never came up in suggestRackBin()/the boundary-respecting path
          // above, since both of those only ever pick a column that's
          // either wholly this-SKU or wholly empty to begin with.
          const found = sortedPositions.find(
            (loc: any) =>
              !targetedLocationIds.has(loc.id) &&
              !excludeLocationIds.includes(loc.id) &&
              ![...(skuBalancesByLocation.get(loc.id)?.values() ?? [])].some(
                (qty: number) => qty > 0,
              ),
          );
          if (found) {
            target = found;
            break;
          }
        }
      }

      if (!target) continue;

      const occupancyCount = binLocations.filter(
        (loc: any) =>
          (skuBalancesByLocation.get(loc.id)?.size ?? 0) > 0 ||
          pendingSkuByLocation.has(loc.id),
      ).length;

      candidates.push({
        locationId: target.id,
        occupancyCount,
        flankNumber: target.flankNumber ?? null,
        aisle: target.aisle ?? null,
        block: target.block ?? null,
        storageType: target.storageType,
      });
    }

    if (candidates.length === 0) return null;

    // Ground's own FMS×ABC placement (2026-09-09 — see
    // [[wms-abc-velocity-design]] in memory for the full conversation).
    // Ground has only ONE physical lever (aisle/dock proximity — no
    // vertical level concept the way Rack has), so unlike Rack's
    // independent-axes choice, FMS can only ever influence Ground placement
    // by blending into that same one lever. Confirmed directly: "we just
    // need to map like closest bin to outbound dock is A-F combo and
    // further be next set of, then furtherest b the rest" — resolved as a
    // combined ABC×FMS PRIORITY SCORE (combinedPriorityScore(), lower =
    // better = wants the nearest bin) mapped onto a TARGET position along
    // the full near..far proximity range, candidates ranked by closeness to
    // that target — not a simple ascending/descending direction. A pure
    // near/far direction can't produce real gradation (AF always nearest,
    // CS always farthest, everything else genuinely in between) since a
    // single SKU's own bin search only ever has one direction to sort in;
    // target-distance is what turns "prefer near" into "prefer THIS SPECIFIC
    // degree of near."
    const priorityScore = this.combinedPriorityScore(abcClass, fmsClass);
    // Computed from EVERY Ground location in the warehouse (groundLocations,
    // the function's own full input), not just the currently-eligible
    // `candidates` — the exact same "full distinct-aisle list, not narrowed
    // to what's available right now" discipline buildOutboundProximityRanker()
    // itself was already built with, for the identical reason: narrowing to
    // whatever's still open shrinks the scale as bins fill up, corrupting
    // the target-rank mapping (an AF SKU placed after a slower one already
    // took the nearest aisle would otherwise compute its target against a
    // smaller remaining range and land somewhere that ISN'T actually
    // nearest overall). A real bug caught by the diagnostic script's own
    // shuffled-placement-order test, not assumed correct.
    const allRanks = outboundRanker
      ? groundLocations
          .map((l: any) => (l.aisle != null ? outboundRanker(l.aisle) : null))
          .filter((r: number | null): r is number => r != null)
      : [];
    // outboundRanker() is 0-INDEXED (nearest aisle = rank 0, not 1) — a real
    // bug caught by the diagnostic script's own multi-aisle test (every SKU
    // landed one aisle farther than intended until this was fixed): the
    // target-rank formula below must map onto [0, maxRank], not [1, maxRank].
    const maxRank = allRanks.length > 0 ? Math.max(...allRanks) : 0;
    // 0 (AF, the best possible score) .. 1 (CS/D, the worst).
    const targetFraction = (priorityScore - 2) / 4;

    // Row axis (step 2 of the 4-wall dock model, 2026-09-12 — "the furthest
    // bin from the dock should be red, closest bin should be green"). Same
    // 0..1 normalization as the aisle axis, just scoped to the candidate's
    // OWN (aisle, flank) group — each flank has its own independent Row
    // 1..N length, so a raw index isn't comparable across groups the way a
    // warehouse-wide aisle index is; dividing by that group's own max index
    // first is what makes the two axes combinable at all.
    const rowFractionFor = (loc: {
      aisle: string | null;
      flankNumber: number | null;
      block: string | null;
    }): number | null => {
      if (!rowRanker || loc.aisle == null || loc.block == null) return null;
      const positions = groundRowGroups.get(
        `${loc.aisle}|${loc.flankNumber ?? 'x'}`,
      );
      if (!positions || positions.length === 0) return null;
      const raw = rowRanker(positions, loc.block, globalMaxRowIndex);
      // Normalized against globalMaxRowIndex (the longest row sequence
      // anywhere in the warehouse), NOT this group's own length — see this
      // function's own ctx-building comment above for the real bug this
      // fixes (a shorter aisle's bins reading a falsely worse rank than an
      // equally-close bin in a longer aisle).
      return globalMaxRowIndex > 0 ? raw / globalMaxRowIndex : 0;
    };
    // Combines whichever axis (or axes) the warehouse has actually
    // configured into ONE 0..1 closeness fraction — a plain average, not a
    // sum, so the result stays in the same 0..1 scale regardless of
    // whether one wall or two (a corner dock: one OUTBOUND zone per axis)
    // is configured. A warehouse with only an aisle zone (today's only
    // real case, e.g. TNR8) gets a combinedFraction identical to its own
    // aisleFraction alone — zero behavior change for any warehouse that
    // hasn't added a row-axis zone yet. `null` (neither axis configured)
    // falls through to the existing flankNumber-only fallback below,
    // completely unchanged from before this step.
    const combinedFractionFor = (loc: {
      aisle: string | null;
      flankNumber: number | null;
      block: string | null;
    }): number | null => {
      let aisleFraction: number | null = null;
      if (outboundRanker && loc.aisle != null)
        aisleFraction = maxRank > 0 ? outboundRanker(loc.aisle) / maxRank : 0;
      const rowFraction = rowFractionFor(loc);
      const parts = [aisleFraction, rowFraction].filter(
        (v): v is number => v != null,
      );
      if (parts.length === 0) return null;
      return parts.reduce((a, b) => a + b, 0) / parts.length;
    };
    // Unconfigured-warehouse fallback (no WarehouseDockZone at all, on
    // EITHER axis) — same binary near/far direction this codebase has
    // always used when there's no real dock geometry to rank against,
    // completely unchanged from before this pass; only ever consulted when
    // combinedFractionFor() returns null for a candidate, so a warehouse
    // that hasn't configured any dock zone sees zero regression.
    const preferFar = abcClass !== 'A' && abcClass !== 'B';
    candidates.sort((a, b) => {
      if (a.occupancyCount !== b.occupancyCount)
        return b.occupancyCount - a.occupancyCount;
      const fracA = combinedFractionFor(a);
      const fracB = combinedFractionFor(b);
      if (fracA != null && fracB != null && fracA !== fracB)
        return (
          Math.abs(fracA - targetFraction) - Math.abs(fracB - targetFraction)
        );
      const fa = a.flankNumber ?? Number.MAX_SAFE_INTEGER;
      const fb = b.flankNumber ?? Number.MAX_SAFE_INTEGER;
      return preferFar ? fb - fa : fa - fb;
    });

    return candidates[0].locationId;
  }

  // ------------------------------------------------------------
  // STILLAGE bin suggestion — 2026-09-13, see the full design conversation
  // in the wms-putaway-design memory. DELIBERATELY a fully separate method
  // from suggestGroundBin()/suggestRackBin() above, same discipline Drive-in
  // and Ground already got split out with. Stillage's physical shape is
  // close to Ground's own — a BIN (`stack`) subdivides into COLUMNS
  // (`stack`+`rack`, single-file LIFO lines `depth` positions deep) — but
  // the client's own real-world rule is simpler than Ground's: always
  // single-SKU-per-column (self-stacking cages make partial/FIFO retrieval
  // within one column impractical — "FIFO is very tough so we need to
  // empty the full bin first then only allow next putaway into this"), no
  // free-mixing option at all (unlike Ground's respectsColumnBoundaries*
  // toggle). Reuses WarehouseStorageType.maxSkusClassA/B/C directly, no new
  // schema — the client's own confirmed rule ("A class can be given full
  // 3x3... C can be kept in 1 column each") maps exactly onto this existing
  // config: A/B (client's own "like A for now") both default to cap 1 (one
  // SKU may use the WHOLE bin, spanning as many columns as it needs); C
  // defaults to cap null/unbounded (any number of distinct SKUs, each
  // confined to its own column — bounded for free by the bin's own real
  // column count, since `occupantSkuIds.size` can never exceed it). D falls
  // through to C's cap, same "D behaves like C" convention as everywhere
  // else in this codebase (maxSkusForClass() already does this).
  //
  // Deliberately simpler than suggestGroundBin() in one remaining way, still
  // flagged rather than silently matched: no "closed column" lifecycle
  // tracking (a column that's had a real pick/dispatch decrease stays open
  // here — this wasn't discussed for Stillage, and is dormant/inert either
  // way until a Picking module exists and starts writing negative
  // movements). Row-axis (NORTH/SOUTH second dock wall) placement WAS added
  // 2026-09-13, same day as this method's own build — the client confirmed
  // reusing Ground's exact mechanism ("we need the second row also for
  // stillage, same as ground"); Stillage gets its OWN separate row-groups
  // (`stillageRowGroups`/`globalMaxStillageRowIndex`, built alongside
  // Ground's own in suggestBin() above) rather than sharing Ground's — the
  // two storage types can never share an Aisle
  // (assertNoConflictingFamily() in locations.service.ts hard-blocks that),
  // so their row sequences are physically unrelated axes.
  // ------------------------------------------------------------
  private suggestStillageBin(
    stillageLocations: any[],
    ctx: any,
  ): string | null {
    if (stillageLocations.length === 0) return null;
    const {
      skuId,
      abcClass,
      fmsClass,
      storageTypeRowByType,
      balanceByLocSku,
      skuBalancesByLocation,
      lastReceivedDateByLocSku,
      pendingSkuByLocation,
      targetedLocationIds,
      stillIncomingSkuIds,
      abcClassBySkuId,
      exceptionActive,
      agingGranularity,
      newStockDate,
      excludeLocationIds,
      outboundRanker,
      rowRanker,
      stillageRowGroups,
      globalMaxStillageRowIndex,
    } = ctx;

    const row: any = storageTypeRowByType.get('STILLAGE');
    if (!row) return null;

    const binKeyOf = (loc: any) => `${loc.aisle}|${loc.stack}`;
    const columnKeyOf = (loc: any) => `${binKeyOf(loc)}|${loc.rack}`;

    const bins = new Map<string, any[]>();
    for (const loc of stillageLocations) {
      const key = binKeyOf(loc);
      if (!bins.has(key)) bins.set(key, []);
      bins.get(key)!.push(loc);
    }

    type Candidate = {
      locationId: string;
      occupancyCount: number;
      flankNumber: number | null;
      aisle: string | null;
      stack: string | null;
      storageType: string;
    };
    const candidates: Candidate[] = [];

    for (const binLocations of bins.values()) {
      // Distinct occupant SKUs across the WHOLE BIN (every column pooled
      // together) — same "whole shared unit, not per-position" resolution
      // as Rack's own lane / Ground's own bin, just naming a stack instead.
      const occupantSkuIds = new Set<string>();
      for (const loc of binLocations) {
        const perLocation = skuBalancesByLocation.get(loc.id);
        if (perLocation)
          for (const [sid, qty] of perLocation)
            if (qty > 0) occupantSkuIds.add(sid);
        const pendingSku = pendingSkuByLocation.get(loc.id);
        if (pendingSku) occupantSkuIds.add(pendingSku);
      }

      let binEligible = true;

      if (occupantSkuIds.size === 0) {
        binEligible = true;
      } else if (occupantSkuIds.size === 1 && occupantSkuIds.has(skuId)) {
        // Same-SKU top-up — always eligible on distinct-SKU-count grounds
        // (this SKU may keep using more of the bin's OWN columns, unbounded
        // — the "whole bin" cap only ever restricts a DIFFERENT SKU from
        // entering, never this one from growing); gated instead by the
        // aging check at column-selection time below.
        binEligible = true;
      } else if (!exceptionActive) {
        // Cross-SKU mixing — governed by maxSkusClassA/B/C, most-restrictive-
        // class-wins across every occupant AND the incoming SKU, same cap
        // math as Rack's own lanes. "Still incoming" reservation applies
        // here too (B/C only, same reasoning as Rack/Ground — redundant for
        // A/B since their cap of 1 is already exclusive).
        const anyOccupantStillIncoming = [...occupantSkuIds].some((id) =>
          stillIncomingSkuIds.has(id),
        );
        if (anyOccupantStillIncoming) {
          binEligible = false;
        } else {
          const occupantClasses = [...occupantSkuIds].map(
            (id) => abcClassBySkuId.get(id) || 'C',
          );
          const caps = [abcClass, ...occupantClasses].map((cls) =>
            this.maxSkusForClass(row, cls),
          );
          const finiteCaps = caps.filter((c): c is number => c !== null);
          const effectiveCap =
            finiteCaps.length > 0 ? Math.min(...finiteCaps) : null;
          if (effectiveCap !== null && occupantSkuIds.size >= effectiveCap)
            binEligible = false;
        }
      }

      if (!binEligible) continue;

      // Column selection within this eligible bin — prefer topping up an
      // existing same-SKU column whose age matches (the ordinary case for a
      // multi-trip delivery), else open the next unused column, lowest
      // column number first (same order Ground's own generator/renderer
      // already use for columns).
      const columns = new Map<string, any[]>();
      for (const loc of binLocations) {
        const key = columnKeyOf(loc);
        if (!columns.has(key)) columns.set(key, []);
        columns.get(key)!.push(loc);
      }
      const sortedColumns = [...columns.values()].sort(
        (a, b) => (Number(a[0].rack) || 0) - (Number(b[0].rack) || 0),
      );

      let bestColumn: any[] | null = null;
      for (const columnLocations of sortedColumns) {
        const colOccupants = new Set<string>();
        for (const loc of columnLocations) {
          const perLocation = skuBalancesByLocation.get(loc.id);
          if (perLocation)
            for (const [sid, qty] of perLocation)
              if (qty > 0) colOccupants.add(sid);
        }
        if (colOccupants.size !== 1 || !colOccupants.has(skuId)) continue;
        const hasRoom = columnLocations.some(
          (l: any) =>
            (balanceByLocSku.get(`${l.id}|${skuId}`) || 0) <= 0 &&
            !targetedLocationIds.has(l.id) &&
            !excludeLocationIds.includes(l.id),
        );
        if (!hasRoom) continue;
        let existingDate: Date | null = null;
        for (const loc of columnLocations) {
          const d = lastReceivedDateByLocSku.get(`${loc.id}|${skuId}`);
          if (d) existingDate = d;
        }
        if (
          existingDate &&
          newStockDate &&
          !this.sameAgeBucket(existingDate, newStockDate, agingGranularity)
        )
          continue; // must fully empty before a different-age batch can enter this column
        bestColumn = columnLocations;
        break;
      }
      if (!bestColumn) {
        bestColumn =
          sortedColumns.find((columnLocations) => {
            const hasAnyOccupant = columnLocations.some(
              (l: any) =>
                (skuBalancesByLocation.get(l.id)?.size ?? 0) > 0 ||
                pendingSkuByLocation.has(l.id),
            );
            return !hasAnyOccupant;
          }) ?? null;
      }

      let target: any = null;
      if (bestColumn) {
        // Deepest-first fill within the chosen column — same convention
        // Rack/Ground already use (an MHE pushes each new stack all the way
        // to the back first).
        const sortedPositions = [...bestColumn].sort(
          (a, b) => (b.depth ?? 0) - (a.depth ?? 0),
        );
        target =
          sortedPositions.find(
            (loc: any) =>
              (balanceByLocSku.get(`${loc.id}|${skuId}`) || 0) <= 0 &&
              !targetedLocationIds.has(loc.id) &&
              !excludeLocationIds.includes(loc.id),
          ) ?? null;
      }
      if (!target) continue; // bin has no genuinely free/eligible position right now

      const occupancyCount = binLocations.filter(
        (loc: any) =>
          (skuBalancesByLocation.get(loc.id)?.size ?? 0) > 0 ||
          pendingSkuByLocation.has(loc.id),
      ).length;

      candidates.push({
        locationId: target.id,
        occupancyCount,
        flankNumber: target.flankNumber ?? null,
        aisle: target.aisle ?? null,
        stack: target.stack ?? null,
        storageType: target.storageType,
      });
    }

    if (candidates.length === 0) return null;

    // Same combined ABC×FMS priority-score + target-rank placement Ground
    // uses (confirmed with the client — "yes" to reusing it), now on BOTH
    // axes — aisle (outboundRanker) same as before, plus row (rowRanker,
    // 2026-09-13 addition) using Stillage's own separate row-groups. See
    // suggestGroundBin()'s own comment on combinedPriorityScore()/
    // targetFraction/rowFractionFor for the full reasoning — mirrored here
    // near-verbatim, just keyed by `stack` instead of `block`.
    const priorityScore = this.combinedPriorityScore(abcClass, fmsClass);
    const allRanks = outboundRanker
      ? stillageLocations
          .map((l: any) => (l.aisle != null ? outboundRanker(l.aisle) : null))
          .filter((r: number | null): r is number => r != null)
      : [];
    const maxRank = allRanks.length > 0 ? Math.max(...allRanks) : 0;
    const targetFraction = (priorityScore - 2) / 4;
    const preferFar = abcClass !== 'A' && abcClass !== 'B'; // unconfigured-warehouse fallback direction, same as Rack/Ground

    const rowFractionFor = (c: Candidate): number | null => {
      if (!rowRanker || c.aisle == null || c.stack == null) return null;
      const positions = stillageRowGroups.get(
        `${c.aisle}|${c.flankNumber ?? 'x'}`,
      );
      if (!positions || positions.length === 0) return null;
      const raw = rowRanker(positions, c.stack, globalMaxStillageRowIndex);
      return globalMaxStillageRowIndex > 0
        ? raw / globalMaxStillageRowIndex
        : 0;
    };
    const combinedFractionFor = (c: Candidate): number | null => {
      let aisleFraction: number | null = null;
      if (outboundRanker && c.aisle != null)
        aisleFraction = maxRank > 0 ? outboundRanker(c.aisle) / maxRank : 0;
      const rowFraction = rowFractionFor(c);
      const parts = [aisleFraction, rowFraction].filter(
        (v): v is number => v != null,
      );
      if (parts.length === 0) return null;
      return parts.reduce((a, b) => a + b, 0) / parts.length;
    };

    candidates.sort((a, b) => {
      if (a.occupancyCount !== b.occupancyCount)
        return b.occupancyCount - a.occupancyCount;
      const fracA = combinedFractionFor(a);
      const fracB = combinedFractionFor(b);
      if (fracA != null && fracB != null && fracA !== fracB)
        return (
          Math.abs(fracA - targetFraction) - Math.abs(fracB - targetFraction)
        );
      const fa = a.flankNumber ?? Number.MAX_SAFE_INTEGER;
      const fb = b.flankNumber ?? Number.MAX_SAFE_INTEGER;
      return preferFar ? fb - fa : fa - fb;
    });

    return candidates[0].locationId;
  }

  // The vehicle's own Dock In time, per receipt — confirmed as "the" date
  // for the simple localized-aging stand-in (one shared date per vehicle,
  // not per case — see [[wms-putaway-design]]).
  async resolveReceivedDate(tx: any, receiptId: string): Promise<Date | null> {
    const receipt = await tx.inboundReceipt.findUnique({
      where: { id: receiptId },
      select: { gateEntry: { select: { dockedInAt: true } } },
    });
    return receipt?.gateEntry?.dockedInAt ?? null;
  }

  // ------------------------------------------------------------
  // Equipment assumption (trips/time estimate) — never stored, always
  // derived, same "always derive" philosophy as on-hand stock.
  // ------------------------------------------------------------

  // The warehouse's own assumed Primary equipment type's per-trip capacity
  // for Putaway — null when nothing is rated Primary there yet (matrix
  // unconfigured), in which case callers treat a "trip" as the whole
  // remaining quantity (no MHE-aware splitting to fall back on).
  private async assumedCapacity(warehouseId: string): Promise<{
    capacity: number;
    avgTripMinutes: number;
    equipmentTypeName: string;
  } | null> {
    const primaryRow =
      await this.prisma.warehouseEquipmentSuitability.findFirst({
        where: { warehouseId, putawaySuitability: 'PRIMARY' },
        include: { equipmentType: true },
      });
    if (!primaryRow) return null;
    return {
      capacity: Number(primaryRow.equipmentType.genericPalletsPerTrip) || 1,
      avgTripMinutes: Number(
        primaryRow.equipmentType.genericAvgTripMinutes || 0,
      ),
      equipmentTypeName: primaryRow.equipmentType.name,
    };
  }

  async estimateTrips(
    warehouseId: string,
    quantity: number,
  ): Promise<{
    trips: number;
    equipmentTypeName: string | null;
    estimatedMinutes: number | null;
  }> {
    const assumed = await this.assumedCapacity(warehouseId);
    if (!assumed)
      return { trips: 1, equipmentTypeName: null, estimatedMinutes: null };
    const trips = Math.max(1, Math.ceil(quantity / assumed.capacity));
    return {
      trips,
      equipmentTypeName: assumed.equipmentTypeName,
      estimatedMinutes: trips * assumed.avgTripMinutes,
    };
  }

  // ------------------------------------------------------------
  // Task creation — BATCH mode
  // ------------------------------------------------------------

  // Called from GateEntriesService/InboundReceiptsService's own
  // recomputeReceiptStatus, only on the PARTIALLY_RECEIVED/PENDING ->
  // RECEIVED transition, only when the company is in BATCH trigger mode.
  // One task per line with real receivedQty > 0. Guarded against double-
  // creation (checks for an existing task per line first) so a duplicate
  // call is a harmless no-op.
  async createBatchTasksForReceipt(tx: any, receiptId: string) {
    const receipt = await tx.inboundReceipt.findUnique({
      where: { id: receiptId },
      include: {
        lines: true,
        warehouse: { select: { id: true } },
        stagingLocation: { select: { id: true } },
      },
    });
    if (!receipt) return;
    const receivedDate = await this.resolveReceivedDate(tx, receiptId);

    for (const line of receipt.lines) {
      const qty = Number(line.receivedQty);
      if (qty <= 0) continue;
      const existingTask = await tx.putawayTask.findFirst({
        where: { receiptLineId: line.id },
      });
      if (existingTask) continue;

      const fromLocationId =
        line.stagingLocationId ?? receipt.stagingLocationId;
      if (!fromLocationId) continue; // shouldn't happen — matchReceipt requires staging

      const toLocationId = await this.suggestBin(tx, {
        warehouseId: receipt.warehouse.id,
        skuId: line.skuId,
        newStockDate: receivedDate,
      });
      await tx.putawayTask.create({
        data: {
          receiptLineId: line.id,
          skuId: line.skuId,
          fromLocationId,
          toLocationId: toLocationId ?? undefined,
          quantity: qty,
          status: toLocationId ? 'PENDING' : 'NEEDS_BIN',
        },
      });
    }
  }

  // ------------------------------------------------------------
  // Task creation/accumulation — IMMEDIATE mode
  // ------------------------------------------------------------

  // Called right after GateEntriesService.scan() / InboundReceiptsService.
  // approveScan() write their RECEIPT StockMovement — only does anything
  // when the company is in IMMEDIATE trigger mode (a no-op otherwise, since
  // BATCH mode handles everything at the RECEIVED transition instead).
  async handleAcceptedScan(
    tx: any,
    params: {
      receiptLineId: string;
      skuId: string;
      quantity: number;
      locationId: string;
      warehouseId: string;
      receiptId: string;
    },
  ) {
    const warehouse = await tx.warehouse.findUnique({
      where: { id: params.warehouseId },
      select: { companyId: true },
    });
    if (!warehouse) return;
    const company = await tx.company.findUnique({
      where: { id: warehouse.companyId },
      select: { putawayTriggerMode: true, putawayDefaultBatchQty: true },
    });
    if (!company || company.putawayTriggerMode !== 'IMMEDIATE') return;

    const sku = await tx.sku.findUnique({
      where: { id: params.skuId },
      select: { putawayBatchQty: true },
    });
    const thresholdRaw = sku?.putawayBatchQty ?? company.putawayDefaultBatchQty;
    const threshold = thresholdRaw != null ? Number(thresholdRaw) : null;
    const receivedDate = await this.resolveReceivedDate(tx, params.receiptId);

    const createTask = async (
      quantity: number,
      openForAccumulation: boolean,
    ) => {
      const toLocationId = await this.suggestBin(tx, {
        warehouseId: params.warehouseId,
        skuId: params.skuId,
        newStockDate: receivedDate,
      });
      return tx.putawayTask.create({
        data: {
          receiptLineId: params.receiptLineId,
          skuId: params.skuId,
          fromLocationId: params.locationId,
          toLocationId: toLocationId ?? undefined,
          quantity,
          status: toLocationId ? 'PENDING' : 'NEEDS_BIN',
          openForAccumulation,
        },
      });
    };

    if (threshold == null) {
      // No threshold configured — every scan is its own task, released immediately.
      await createTask(params.quantity, false);
      return;
    }

    const open = await tx.putawayTask.findFirst({
      where: { receiptLineId: params.receiptLineId, openForAccumulation: true },
    });
    if (open) {
      const newQty = Number(open.quantity) + params.quantity;
      await tx.putawayTask.update({
        where: { id: open.id },
        data: { quantity: newQty, openForAccumulation: newQty < threshold },
      });
      return;
    }
    await createTask(params.quantity, params.quantity < threshold);
  }

  // ------------------------------------------------------------
  // Task creation — Pallet consolidation path (2026-09-01)
  // ------------------------------------------------------------

  // Called from PalletsService the moment a PalletLoad closes (auto, on
  // hitting its effective max-cases cap, or a manual short-close) — see
  // [[wms-putaway-design]]'s Pallet consolidation entry. Deliberately NOT
  // reusing createBatchTasksForReceipt's per-line duplicate-guard: a single
  // receipt line can spawn several pallets (several closed loads), each
  // needing its own task with its own destination bin, since a task can
  // only ever have one toLocationId. BATCH/IMMEDIATE triggers are bypassed
  // entirely for a palletized receipt (see GateEntriesService.scan()'s own
  // comment) — this is the ONLY task-creation path for that receipt.
  async createTaskForClosedPallet(tx: any, palletLoadId: string) {
    const load = await tx.palletLoad.findUnique({
      where: { id: palletLoadId },
      include: {
        receiptLine: {
          include: {
            receipt: {
              include: {
                warehouse: { select: { id: true } },
                stagingLocation: { select: { id: true } },
              },
            },
          },
        },
      },
    });
    if (!load || !load.receiptLine) return; // shouldn't happen — receiptLineId is set at the first scan married onto this load

    const agg = await tx.stockMovement.aggregate({
      where: { palletLoadId },
      _sum: { quantity: true },
    });
    const qty = Number(agg._sum.quantity || 0);
    if (qty <= 0) return; // a short-closed load nothing was ever scanned onto — nothing to put away

    const fromLocationId =
      load.receiptLine.stagingLocationId ??
      load.receiptLine.receipt.stagingLocationId;
    if (!fromLocationId) return; // shouldn't happen — matchReceipt requires staging before any scan can occur

    const receivedDate = await this.resolveReceivedDate(
      tx,
      load.receiptLine.receiptId,
    );
    const toLocationId = await this.suggestBin(tx, {
      warehouseId: load.receiptLine.receipt.warehouse.id,
      skuId: load.skuId,
      newStockDate: receivedDate,
    });

    await tx.putawayTask.create({
      data: {
        receiptLineId: load.receiptLineId,
        palletLoadId,
        skuId: load.skuId,
        fromLocationId,
        toLocationId: toLocationId ?? undefined,
        quantity: qty,
        status: toLocationId ? 'PENDING' : 'NEEDS_BIN',
      },
    });
  }

  // ------------------------------------------------------------
  // Read
  // ------------------------------------------------------------

  async findAll(user: AuthUser, warehouseId?: string) {
    const where: any = {
      receiptLine: { receipt: { warehouse: { ...companyFilter(user) } } },
    };
    if (PUTAWAY_SCOPED_ROLES.includes(user.role)) {
      const ids = await ownWarehouseIds(this.prisma, user.userId);
      where.receiptLine.receipt.warehouse.id = { in: ids };
    }
    if (warehouseId) where.receiptLine.receipt.warehouseId = warehouseId;
    const tasks = await this.prisma.putawayTask.findMany({
      where,
      include: { ...TASK_INCLUDE, trips: { orderBy: { claimedAt: 'asc' } } },
      orderBy: { createdAt: 'asc' },
    });
    return tasks
      .filter((t: any) => !t.openForAccumulation)
      .map((t: any) => {
        const movedQuantity = t.trips
          .filter((tr: any) => tr.status === 'COMPLETED')
          .reduce((sum: number, tr: any) => sum + Number(tr.quantity), 0);
        const inProgressTrip = t.trips.find(
          (tr: any) => tr.status === 'IN_PROGRESS',
        );
        // At-a-glance discrepancy flag (2026-09-06) — true the moment ANY
        // of this task's completed trips landed somewhere other than the
        // original assignment (only possible at all once
        // Company.allowPutawayLocationOverride is on). Visible to whoever
        // can already see the task list — this is just a signal on data
        // they already have; the fuller "Discrepancies" list below is
        // Supervisor+ only.
        const hasDiscrepancy = t.trips.some(
          (tr: any) =>
            tr.status === 'COMPLETED' &&
            tr.scannedLocationId &&
            tr.scannedLocationId !== t.toLocationId,
        );
        return { ...t, movedQuantity, inProgressTrip, hasDiscrepancy };
      });
  }

  // Discrepancy review list (2026-09-06, Plan View backlog items 2/3) —
  // every COMPLETED trip whose scannedLocationId ended up different from
  // its own task's toLocationId (only possible once the company's own
  // allowPutawayLocationOverride toggle let it happen at all). Prisma can't
  // compare two columns in a `where` clause directly, so this filters in
  // JS after a normal scoped fetch — same pattern this codebase already
  // uses for reservation/eligibility checks elsewhere in this file.
  // Supervisor+ only (PUTAWAY_DISCREPANCY_REVIEW_ROLES) — an Operator sees
  // the plain flag on their own row via findAll() above, not this fuller
  // audit view.
  async getDiscrepancies(user: AuthUser, warehouseId?: string) {
    const where: any = {
      status: 'COMPLETED',
      scannedLocationId: { not: null },
      task: {
        receiptLine: { receipt: { warehouse: { ...companyFilter(user) } } },
      },
    };
    if (PUTAWAY_SCOPED_ROLES.includes(user.role)) {
      const ids = await ownWarehouseIds(this.prisma, user.userId);
      where.task.receiptLine.receipt.warehouse.id = { in: ids };
    }
    if (warehouseId) where.task.receiptLine.receipt.warehouseId = warehouseId;

    const locationSelect = {
      id: true,
      code: true,
      storageType: true,
      rack: true,
      level: true,
      depth: true,
      flankNumber: true,
    };
    const trips = await this.prisma.putawayTrip.findMany({
      where,
      include: {
        task: {
          select: {
            toLocationId: true,
            sku: { select: { code: true } },
            toLocation: { select: locationSelect },
          },
        },
        scannedLocation: { select: locationSelect },
        claimedBy: { select: { name: true } },
        discrepancyReviewedBy: { select: { name: true } },
      },
      orderBy: { completedAt: 'desc' },
    });

    return trips
      .filter((tr: any) => tr.scannedLocationId !== tr.task.toLocationId)
      .map((tr: any) => ({
        tripId: tr.id,
        skuCode: tr.task.sku.code,
        assignedRackName: displayCode(tr.task.toLocation),
        actualRackName: displayCode(tr.scannedLocation),
        operatorName: tr.claimedBy.name,
        completedAt: tr.completedAt,
        reviewedAt: tr.discrepancyReviewedAt,
        reviewedByName: tr.discrepancyReviewedBy?.name ?? null,
      }));
  }

  // Marks one discrepancy reviewed — a Supervisor/Manager/Admin's
  // acknowledgment that they've seen it and handled it physically (same
  // "a status fact isn't the same as a human sign-off" reasoning as
  // VehicleGateEntry.inwardCompletedAt). Idempotent on a second call, same
  // convention as NotificationsService.acknowledge() — re-reviewing just
  // re-stamps who/when rather than erroring.
  async reviewDiscrepancy(tripId: string, user: AuthUser) {
    const trip = await this.prisma.putawayTrip.findUnique({
      where: { id: tripId },
      include: {
        task: {
          include: {
            receiptLine: {
              include: { receipt: { include: { warehouse: true } } },
            },
          },
        },
      },
    });
    if (!trip) throw new NotFoundException('Trip not found.');
    const warehouse = (trip.task as any).receiptLine.receipt.warehouse;
    if (user.role !== 'SUPER_ADMIN' && warehouse.companyId !== user.companyId)
      throw new ForbiddenException('You do not have access to this trip.');
    if (PUTAWAY_SCOPED_ROLES.includes(user.role)) {
      const ids = await ownWarehouseIds(this.prisma, user.userId);
      if (!ids.includes(warehouse.id))
        throw new ForbiddenException('You do not have access to this trip.');
    }
    return this.prisma.putawayTrip.update({
      where: { id: tripId },
      data: {
        discrepancyReviewedAt: new Date(),
        discrepancyReviewedById: user.userId,
      },
    });
  }

  private async assertTaskAccess(id: string, user: AuthUser) {
    const task = await this.prisma.putawayTask.findUnique({
      where: { id },
      include: {
        ...TASK_INCLUDE,
        receiptLine: { include: { receipt: { include: { warehouse: true } } } },
        trips: true,
      },
    });
    if (!task) throw new NotFoundException('Putaway task not found.');
    const warehouse = (task.receiptLine as any).receipt.warehouse;
    if (user.role !== 'SUPER_ADMIN' && warehouse.companyId !== user.companyId)
      throw new ForbiddenException('You do not have access to this task.');
    if (PUTAWAY_SCOPED_ROLES.includes(user.role)) {
      const ids = await ownWarehouseIds(this.prisma, user.userId);
      if (!ids.includes(warehouse.id))
        throw new ForbiddenException('You do not have access to this task.');
    }
    return task;
  }

  // ------------------------------------------------------------
  // Execution — scan-driven
  // ------------------------------------------------------------

  // The staging scan — claims one trip. Resolves the barcode to a SKU
  // (same SkuBarcode/SkuStorageUnit resolution as Inbound scanning, no new
  // label concept — confirmed 2026-08-28), finds the oldest still-workable
  // PENDING task for that SKU at that staging location, and opens an
  // IN_PROGRESS trip sized by the warehouse's assumed equipment capacity
  // for this SKU (never more than what's left on the task).
  async claimTrip(barcode: any, user: AuthUser) {
    const trimmed = barcode != null ? String(barcode).trim() : '';
    if (!trimmed) throw new BadRequestException('A barcode is required.');

    const barcodeMatches = await this.prisma.skuBarcode.findMany({
      // Non-null assertion: this scan-execution path is only ever reached by
      // a company-scoped user in practice (SUPER_ADMIN has no warehouse
      // floor to scan against) — same reasoning as companyFilter()'s own
      // return type above.
      where: { barcode: trimmed, sku: { companyId: user.companyId! } },
      select: { skuId: true },
    });
    if (barcodeMatches.length === 0)
      throw new BadRequestException('Unrecognized barcode.');
    const skuIds = [...new Set(barcodeMatches.map((b: any) => b.skuId))];

    const scopedWarehouseIds = PUTAWAY_SCOPED_ROLES.includes(user.role)
      ? await ownWarehouseIds(this.prisma, user.userId)
      : null;

    const candidateTasks = await this.prisma.putawayTask.findMany({
      where: {
        skuId: { in: skuIds },
        status: 'PENDING',
        openForAccumulation: false,
        receiptLine: {
          receipt: {
            warehouse: {
              companyId: user.companyId!,
              ...(scopedWarehouseIds ? { id: { in: scopedWarehouseIds } } : {}),
            },
          },
        },
      },
      include: { trips: true },
      orderBy: { createdAt: 'asc' },
    });

    const task = candidateTasks.find((t: any) => {
      const moved = t.trips
        .filter((tr: any) => tr.status === 'COMPLETED')
        .reduce((s: number, tr: any) => s + Number(tr.quantity), 0);
      const hasOpenTrip = t.trips.some(
        (tr: any) => tr.status === 'IN_PROGRESS',
      );
      return moved < Number(t.quantity) && !hasOpenTrip;
    });
    if (!task)
      throw new BadRequestException(
        'No workable putaway task found for this SKU — it may already be fully claimed or completed.',
      );

    const moved = task.trips
      .filter((tr: any) => tr.status === 'COMPLETED')
      .reduce((s: number, tr: any) => s + Number(tr.quantity), 0);
    const remaining = Number(task.quantity) - moved;
    const warehouseId = (await this.prisma.location.findUnique({
      where: { id: task.fromLocationId },
      select: { warehouseId: true },
    }))!.warehouseId;
    const assumed = await this.assumedCapacity(warehouseId);
    // One trip moves whatever the assumed equipment can carry, capped at
    // what's actually left on the task — the last trip of a task is
    // naturally smaller than a full capacity load. No equipment configured
    // for this warehouse yet -> one trip covers everything remaining.
    const tripQuantity = assumed
      ? Math.min(remaining, assumed.capacity)
      : remaining;

    return this.prisma.putawayTrip.create({
      data: {
        taskId: task.id,
        quantity: tripQuantity,
        claimedById: user.userId,
        stagingBarcodeScanned: trimmed,
      },
      include: { task: { include: TASK_INCLUDE } },
    });
  }

  // Resolves a scanned/typed string to a real, active Location within one
  // warehouse — used by completeTrip()'s override path (2026-09-06) to find
  // whatever bin an operator ACTUALLY scanned, not just check it against
  // the one bin that was expected. Tries the raw `code` first (a single
  // indexed lookup, the common case since it's also what's printed on a
  // real Location Label alongside the Rack Name) — falls back to computing
  // buildRackName() over every active location in the warehouse only if
  // that fails, since Rack Name isn't a stored/indexable column.
  private async resolveLocationInWarehouse(
    warehouseId: string,
    trimmed: string,
  ) {
    const byCode = await this.prisma.location.findFirst({
      where: {
        warehouseId,
        isActive: true,
        code: { equals: trimmed, mode: 'insensitive' },
      },
    });
    if (byCode) return byCode;
    const candidates = await this.prisma.location.findMany({
      where: { warehouseId, isActive: true },
    });
    return (
      candidates.find(
        (l: any) => buildRackName(l)?.toUpperCase() === trimmed,
      ) ?? null
    );
  }

  // The location scan — completes a trip. By default, only a scan matching
  // the task's own toLocationId is ever accepted; a mismatch hard-blocks
  // with no override, per the client's original explicit "doesnt allow
  // operator to override." Revisited 2026-09-06 (Plan View backlog items
  // 2/3 — see [[wms-putaway-design]]): when the warehouse's own company has
  // `allowPutawayLocationOverride` on, a scan resolving to any OTHER real,
  // active Location in the same warehouse now completes the trip too —
  // confirmed directly NOT to re-run suggestBin()'s own eligibility rules
  // against it (the whole point is trusting the operator's own physical
  // judgment, not second-guessing it), and frictionless — no reason/note
  // required, the discrepancy record itself (assigned vs. actual bin, who,
  // when) is the audit trail. Writes the real PUTAWAY_OUT/PUTAWAY_IN
  // StockMovement pair for this trip's quantity, carrying receivedDate
  // forward unchanged — the PUTAWAY_IN lands at wherever the stock
  // PHYSICALLY is (the resolved target), never blindly at the original
  // assignment, so the ledger stays honest even when overridden.
  async completeTrip(tripId: string, locationCode: any, user: AuthUser) {
    const trip = await this.prisma.putawayTrip.findUnique({
      where: { id: tripId },
      include: { task: true },
    });
    if (!trip) throw new NotFoundException('Trip not found.');
    if (trip.status !== 'IN_PROGRESS')
      throw new BadRequestException(
        'This trip is not awaiting a location scan.',
      );
    if (trip.claimedById !== user.userId)
      throw new ForbiddenException(
        'Only the operator who claimed this trip can complete it.',
      );

    const task = trip.task as any;
    if (!task.toLocationId)
      throw new BadRequestException('This task has no assigned bin yet.');

    const trimmed =
      locationCode != null ? String(locationCode).trim().toUpperCase() : '';
    // Match against the task's own destination directly — accepting
    // EITHER the raw `code` or the human "Rack Name" (buildRackName
    // above), since 2026-08-29 the task screen shows Rack Name, not the
    // raw code, so whatever's displayed must be exactly what completes
    // the trip when typed/scanned back.
    const assignedLocation = await this.prisma.location.findUnique({
      where: { id: task.toLocationId },
    });
    const assignedRackName = buildRackName(assignedLocation);
    const matchesAssigned =
      !!assignedLocation &&
      (assignedLocation.code.toUpperCase() === trimmed ||
        (assignedRackName != null &&
          assignedRackName.toUpperCase() === trimmed));

    let targetLocation = assignedLocation;
    if (!matchesAssigned) {
      const warehouse = await this.prisma.warehouse.findUnique({
        where: { id: assignedLocation!.warehouseId },
        select: { company: { select: { allowPutawayLocationOverride: true } } },
      });
      if (!warehouse?.company.allowPutawayLocationOverride) {
        throw new BadRequestException(
          `Wrong location — this must be put away at the assigned bin, not "${trimmed}".`,
        );
      }
      const resolved = await this.resolveLocationInWarehouse(
        assignedLocation!.warehouseId,
        trimmed,
      );
      if (!resolved) {
        throw new BadRequestException(
          `"${trimmed}" isn't a recognized location in this warehouse — scan a real bin's label.`,
        );
      }
      targetLocation = resolved;
    }

    const receivedDate = await this.resolveReceivedDate(
      this.prisma,
      (await this.prisma.inboundReceiptLine.findUnique({
        where: { id: task.receiptLineId },
        select: { receiptId: true },
      }))!.receiptId,
    );

    return this.prisma.$transaction(async (tx) => {
      const updatedTrip = await tx.putawayTrip.update({
        where: { id: tripId },
        data: {
          status: 'COMPLETED',
          scannedLocationId: targetLocation!.id,
          completedAt: new Date(),
        },
      });

      // palletLoadId carried forward unchanged, same as receivedDate above
      // (2026-09-01, see [[wms-putaway-design]]) — null for every ordinary
      // task, so a pallet's contents stay traceable end-to-end through
      // Putaway for whenever Picking needs to know how many pallets to
      // pick from.
      await tx.stockMovement.create({
        data: {
          warehouseId: targetLocation!.warehouseId,
          skuId: task.skuId,
          locationId: task.fromLocationId,
          quantity: -Number(trip.quantity),
          movementType: 'PUTAWAY_OUT',
          referenceType: 'PutawayTrip',
          referenceId: tripId,
          createdById: user.userId,
          receivedDate,
          palletLoadId: task.palletLoadId ?? undefined,
        },
      });
      await tx.stockMovement.create({
        data: {
          warehouseId: targetLocation!.warehouseId,
          skuId: task.skuId,
          // The REAL destination — the original assignment (task.toLocationId)
          // only when there's no override in play; a resolved override
          // target otherwise, so on-hand stock always reflects where the
          // item physically landed, never the stale assignment.
          locationId: targetLocation!.id,
          quantity: Number(trip.quantity),
          movementType: 'PUTAWAY_IN',
          referenceType: 'PutawayTrip',
          referenceId: tripId,
          createdById: user.userId,
          receivedDate,
          palletLoadId: task.palletLoadId ?? undefined,
        },
      });

      const allTrips = await tx.putawayTrip.findMany({
        where: { taskId: task.id },
      });
      const moved = allTrips
        .filter((t: any) => t.status === 'COMPLETED')
        .reduce((s: number, t: any) => s + Number(t.quantity), 0);
      if (moved >= Number(task.quantity)) {
        await tx.putawayTask.update({
          where: { id: task.id },
          data: { status: 'COMPLETED' },
        });
        await this.maybeCompleteReceiptPutaway(tx, task.receiptLineId);
      }

      return updatedTrip;
    });
  }

  // Flips InboundReceipt.status to PUTAWAY_COMPLETE once every task tied to
  // it is COMPLETED — closes the loop completeInward() already checks for
  // but nothing has ever set (see [[wms-putaway-design]]).
  private async maybeCompleteReceiptPutaway(tx: any, receiptLineId: string) {
    const line = await tx.inboundReceiptLine.findUnique({
      where: { id: receiptLineId },
      select: { receiptId: true },
    });
    if (!line) return;
    const receiptTasks = await tx.putawayTask.findMany({
      where: { receiptLine: { receiptId: line.receiptId } },
    });
    if (
      receiptTasks.length === 0 ||
      receiptTasks.some((t: any) => t.status !== 'COMPLETED')
    )
      return;
    const receipt = await tx.inboundReceipt.findUnique({
      where: { id: line.receiptId },
      select: { status: true },
    });
    if (receipt?.status === 'RECEIVED') {
      await tx.inboundReceipt.update({
        where: { id: line.receiptId },
        data: { status: 'PUTAWAY_COMPLETE' },
      });
    }
  }

  // "Request different bin" — only when the suggested location is
  // physically unusable, never a manual pick. Re-suggests excluding every
  // location this task has already been assigned to.
  async requestDifferentBin(taskId: string, reason: any, user: AuthUser) {
    const task = await this.assertTaskAccess(taskId, user);
    if (task.status === 'COMPLETED')
      throw new BadRequestException('This task is already completed.');
    if (task.trips.some((t: any) => t.status === 'IN_PROGRESS'))
      throw new BadRequestException(
        'Complete or abandon the in-progress trip before requesting a different bin.',
      );

    const priorReassignments = await this.prisma.putawayReassignment.findMany({
      where: { taskId },
      select: { previousLocationId: true, newLocationId: true },
    });
    const excludeLocationIds = [
      ...new Set(
        [
          task.toLocationId,
          ...priorReassignments.flatMap((r: any) => [
            r.previousLocationId,
            r.newLocationId,
          ]),
        ].filter(Boolean) as string[],
      ),
    ];

    const warehouseId = (await this.prisma.location.findUnique({
      where: { id: task.fromLocationId },
      select: { warehouseId: true },
    }))!.warehouseId;
    const receivedDate = await this.resolveReceivedDate(
      this.prisma,
      (await this.prisma.inboundReceiptLine.findUnique({
        where: { id: task.receiptLineId },
        select: { receiptId: true },
      }))!.receiptId,
    );
    const newLocationId = await this.suggestBin(this.prisma, {
      warehouseId,
      skuId: task.skuId,
      excludeLocationIds,
      newStockDate: receivedDate,
    });

    return this.prisma.$transaction(async (tx) => {
      await tx.putawayReassignment.create({
        data: {
          taskId,
          previousLocationId: task.toLocationId,
          newLocationId: newLocationId ?? undefined,
          reason: reason ? String(reason).trim() : undefined,
          requestedById: user.userId,
        },
      });
      return tx.putawayTask.update({
        where: { id: taskId },
        data: {
          toLocationId: newLocationId ?? null,
          status: newLocationId ? 'PENDING' : 'NEEDS_BIN',
        },
        include: TASK_INCLUDE,
      });
    });
  }

  // ------------------------------------------------------------
  // Operator assignment fairness (2026-09-02, see [[wms-putaway-design]])
  // ------------------------------------------------------------
  //
  // Deliberately NOT a hard task-to-operator lock — an operator still
  // scans whatever physical case is in front of them, same as always
  // (claimTrip() above is completely unchanged). This is a live-computed
  // recommendation + fairness layer on top: who SHOULD go next (by idle
  // time), and where the real priority is (oldest staged stock), shown on
  // the Putaway page. PutawayAssignmentScheduler consults the same
  // computeRecommendedOperator() to decide when to alert/escalate.

  // Ranks every currently-FREE (no IN_PROGRESS trip), MHE-capable operator
  // assigned to this warehouse by how long they've been free, longest
  // first — winner is the recommendation. "MHE-capable" means
  // canOperateMhe is true OR unset (null) — a small warehouse that never
  // bothers configuring this gets everyone eligible, exactly today's
  // undifferentiated behavior (see schema.prisma's comment on
  // User.canOperateMhe). Ground/Block routing is deliberately not built
  // here — Ground/Stillage has no Putaway logic of its own yet.
  //
  // An operator who has an unresolved PUTAWAY_OPERATOR_MISSED_TURN alert
  // (one created after their own last real activity, with no new trip
  // claimed since) has their effective rank time bumped forward to that
  // alert's own timestamp — a purely time-driven demotion, not a stored
  // "position" field: it naturally pushes them behind anyone who's freed
  // up since, without permanently exiling them to the back (the client's
  // own correction — dropping someone to last just rewards avoiding
  // work with less of it).
  async computeRecommendedOperator(
    warehouseIdOrIds: string | string[],
  ): Promise<{ id: string; name: string; effectiveRankTime: Date } | null> {
    const warehouseIds = Array.isArray(warehouseIdOrIds)
      ? warehouseIdOrIds
      : [warehouseIdOrIds];
    if (warehouseIds.length === 0) return null;
    const operators = await this.prisma.user.findMany({
      // NOT `canOperateMhe: { not: false }` — on a nullable column, Postgres
      // NULL comparisons make that silently EXCLUDE null rows (`NULL <>
      // false` evaluates to NULL, not true), which would wrongly drop
      // every operator who's never had this set at all. Explicit OR
      // instead, matching the real "true OR unset" intent.
      where: {
        role: 'OPERATOR',
        isActive: true,
        OR: [{ canOperateMhe: true }, { canOperateMhe: null }],
        assignedWarehouses: { some: { id: { in: warehouseIds } } },
      },
      select: { id: true, name: true, createdAt: true },
    });
    if (operators.length === 0) return null;
    const operatorIds = operators.map((o) => o.id);

    const inProgress = await this.prisma.putawayTrip.findMany({
      where: { claimedById: { in: operatorIds }, status: 'IN_PROGRESS' },
      select: { claimedById: true },
    });
    const busyIds = new Set(inProgress.map((t: any) => t.claimedById));
    const freeOperators = operators.filter((o) => !busyIds.has(o.id));
    if (freeOperators.length === 0) return null;
    const freeIds = freeOperators.map((o) => o.id);

    const trips = await this.prisma.putawayTrip.findMany({
      where: {
        claimedById: { in: freeIds },
        status: { in: ['COMPLETED', 'ABANDONED'] },
      },
      select: { claimedById: true, claimedAt: true, completedAt: true },
    });
    const lastActivity = new Map<string, Date>();
    for (const t of trips) {
      const ts: Date = t.completedAt ?? t.claimedAt;
      const prev = lastActivity.get(t.claimedById);
      if (!prev || ts > prev) lastActivity.set(t.claimedById, ts);
    }

    const missedAlerts = await this.prisma.notificationLog.findMany({
      where: {
        eventType: 'PUTAWAY_OPERATOR_MISSED_TURN',
        referenceType: 'User',
        referenceId: { in: freeIds },
      },
      orderBy: { createdAt: 'desc' },
      select: { referenceId: true, createdAt: true },
    });
    const latestAlertByOperator = new Map<string, Date>();
    for (const a of missedAlerts) {
      if (!latestAlertByOperator.has(a.referenceId!))
        latestAlertByOperator.set(a.referenceId!, a.createdAt);
    }

    const ranked = freeOperators.map((o) => {
      // Never worked a trip -> eligible immediately, ranked from account
      // creation (a brand-new operator shouldn't wait behind everyone
      // else just because they have no history yet).
      const freeSince = lastActivity.get(o.id) ?? o.createdAt;
      const alertAt = latestAlertByOperator.get(o.id);
      const effectiveRankTime =
        alertAt && alertAt > freeSince ? alertAt : freeSince;
      return { id: o.id, name: o.name, effectiveRankTime };
    });
    ranked.sort(
      (a, b) => a.effectiveRankTime.getTime() - b.effectiveRankTime.getTime(),
    );
    return ranked[0];
  }

  // The Putaway page's own live view — "who should go next" plus "where's
  // the real priority" (oldest staged stock still waiting, per the
  // client's own "smart system" ask — an operator who's technically busy
  // but always grabbing whatever's convenient isn't actually working on
  // what matters). Read-only, no side effects — PutawayAssignmentScheduler
  // is what actually fires alerts/escalations on a timer.
  // warehouseId is optional (2026-09-02 follow-up) — an OPERATOR has zero
  // master-data visibility by design and can never see/pick from a
  // warehouse dropdown at all, so requiring an explicit id here would mean
  // they could never see their own recommendation. Mirrors
  // PutawayTasksService.findAll()'s own convention exactly: omitted means
  // "every warehouse I'm actually scoped to" (via ownWarehouseIds for a
  // scoped role, company-wide for Admin), not "no filter at all."
  async getRecommendation(user: AuthUser, warehouseId?: string) {
    let warehouseIds: string[];
    if (warehouseId) {
      const warehouse = await this.prisma.warehouse.findUnique({
        where: { id: warehouseId },
      });
      if (!warehouse) throw new NotFoundException('Warehouse not found.');
      if (user.role !== 'SUPER_ADMIN' && warehouse.companyId !== user.companyId)
        throw new ForbiddenException(
          'You do not have access to this warehouse.',
        );
      if (PUTAWAY_SCOPED_ROLES.includes(user.role)) {
        const ids = await ownWarehouseIds(this.prisma, user.userId);
        if (!ids.includes(warehouseId))
          throw new ForbiddenException(
            'You do not have access to this warehouse.',
          );
      }
      warehouseIds = [warehouseId];
    } else if (PUTAWAY_SCOPED_ROLES.includes(user.role)) {
      warehouseIds = await ownWarehouseIds(this.prisma, user.userId);
    } else {
      // COMPANY_ADMIN/SUPER_ADMIN with no explicit warehouse — every
      // warehouse in scope (company-wide, or all companies for Super
      // Admin), same breadth findAll() itself falls back to.
      const warehouses = await this.prisma.warehouse.findMany({
        where: companyFilter(user),
        select: { id: true },
      });
      warehouseIds = warehouses.map((w) => w.id);
    }
    if (warehouseIds.length === 0)
      return { priorityTask: null, recommendedOperator: null };

    const priorityTask = await this.prisma.putawayTask.findFirst({
      where: {
        status: 'PENDING',
        openForAccumulation: false,
        receiptLine: { receipt: { warehouseId: { in: warehouseIds } } },
      },
      include: TASK_INCLUDE,
      orderBy: { createdAt: 'asc' },
    });
    const recommendedOperator =
      await this.computeRecommendedOperator(warehouseIds);

    return {
      priorityTask: priorityTask
        ? {
            skuCode: priorityTask.sku.code,
            locationCode: displayCode(priorityTask.fromLocation),
            waitingSince: priorityTask.createdAt,
          }
        : null,
      recommendedOperator: recommendedOperator
        ? {
            id: recommendedOperator.id,
            name: recommendedOperator.name,
            freeSince: recommendedOperator.effectiveRankTime,
          }
        : null,
    };
  }
}
