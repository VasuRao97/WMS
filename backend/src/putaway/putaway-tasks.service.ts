import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { companyFilter, ownWarehouseIds, PUTAWAY_SCOPED_ROLES } from '../common/tenant.util';
import { RACK_STORAGE_TYPES, buildRackName } from '../common/rack-name.util';

// Rack storage types (imported above) share the LIFO depth constraint (see
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
  receiptLine: { select: { id: true, skuId: true, receiptId: true, receipt: { select: { referenceNo: true, vehicle: { select: { vehicleNumber: true } } } } } },
  sku: { select: { id: true, code: true, description: true } },
  // Extra fields beyond `code` let the frontend build the human "Rack
  // Name" (R{flank}-{rack}-L{level}[-D{depth}]) instead of the raw DB
  // code — 2026-08-29, the client's own correction: the Plan View already
  // showed a bin as "R2-01", but the task queue showed the same bin's raw
  // code with a "B" suffix instead ("1-R01B-..."), two different labels
  // for one location. See buildRackName() below and completeTrip(), which
  // now accepts this same string at the scan step too.
  fromLocation: { select: { id: true, code: true, storageType: true, rack: true, level: true, depth: true, flankNumber: true } },
  toLocation: { select: { id: true, code: true, storageType: true, rack: true, level: true, depth: true, flankNumber: true } },
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

  // 2026-08-29 fix: flankNumber must be part of the key. On a mirrored
  // aisle ("Mirror same numbers on other side" in the generator), R01 and
  // R01B are physically SEPARATE racks facing each other across the
  // aisle, but both store the literal rack value "01" — the "B" only ever
  // exists in the display code, never in the `rack` column itself.
  // Without flankNumber here, R01-L01's 3 depths and R01B-L01's 3 depths
  // silently merged into one fake 6-deep lane, since (aisle, rack, level)
  // alone can't tell them apart. Caught via the client's own live
  // testing — same-SKU consolidation was hopping across the aisle to the
  // "other side" instead of staying on one physical rack.
  private laneKeyOf(loc: { id: string; storageType: string; aisle: string | null; rack: string | null; level: string | null; flankNumber: number | null }): string {
    return RACK_STORAGE_TYPES.includes(loc.storageType) && loc.aisle && loc.rack && loc.level
      ? `${loc.aisle}|${loc.flankNumber ?? 'x'}|${loc.rack}|${loc.level}`
      : `single|${loc.id}`;
  }

  // "Same age" comparison — see Company.agingGranularity's schema comment.
  // Null granularity (nothing configured) means exact-match-only, the safe
  // default that in practice only ever matches trips within the same
  // continuous putaway operation.
  private sameAgeBucket(a: Date, b: Date, granularity: string | null): boolean {
    if (!granularity) return a.getTime() === b.getTime();
    if (granularity === 'DAY') return a.toDateString() === b.toDateString();
    if (granularity === 'MONTH') return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
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

  private maxSkusForClass(row: { maxSkusClassA: number | null; maxSkusClassB: number | null; maxSkusClassC: number | null }, abcClass: string): number | null {
    if (abcClass === 'A') return row.maxSkusClassA;
    if (abcClass === 'B') return row.maxSkusClassB;
    return row.maxSkusClassC;
  }

  // The core slotting algorithm. Returns a Location id, or null if nothing
  // eligible exists (the caller sets the task to NEEDS_BIN in that case).
  // excludeLocationIds — "request different bin" passes every location this
  // task has already been assigned to, so a re-suggestion can't loop back.
  // newStockDate — this putaway's own "age" (see resolveReceivedDate below)
  // for the same-SKU-top-up aging check.
  async suggestBin(tx: any, params: { warehouseId: string; skuId: string; excludeLocationIds?: string[]; newStockDate?: Date | null }): Promise<string | null> {
    const { warehouseId, skuId, excludeLocationIds = [], newStockDate = null } = params;

    const sku = await tx.sku.findUnique({ where: { id: skuId } });
    if (!sku) return null;
    const abcClass = (sku.abcClass || 'C').toUpperCase(); // unclassified defaults to C — confirmed 2026-08-28

    const storageTypeRows = await tx.warehouseStorageType.findMany({ where: { warehouseId, categoryId: sku.categoryId } });
    const eligibleStorageTypes: string[] = storageTypeRows.map((r: any) => r.storageType).filter((t: string) => t !== 'MIX');
    if (eligibleStorageTypes.length === 0) return null;
    const storageTypeRowByType = new Map(storageTypeRows.map((r: any) => [r.storageType, r]));

    const rawLocations = await tx.location.findMany({
      where: { warehouseId, zoneType: 'ACTUAL_STORAGE', storageType: { in: eligibleStorageTypes }, isActive: true },
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
    const categoryTaggedLocations = sku.categoryId ? rawLocations.filter((l: any) => l.categoryId === sku.categoryId) : [];
    const locations = categoryTaggedLocations.length > 0 ? categoryTaggedLocations : rawLocations;

    const locationIds = locations.map((l: any) => l.id);
    const warehouse = await tx.warehouse.findUnique({ where: { id: warehouseId }, select: { companyId: true } });
    const [movements, openTaskTargets, companyRow, exception] = await Promise.all([
      tx.stockMovement.findMany({
        where: { locationId: { in: locationIds } },
        select: { locationId: true, skuId: true, quantity: true, receivedDate: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      }),
      tx.putawayTask.findMany({ where: { toLocationId: { in: locationIds }, status: { in: ['PENDING', 'NEEDS_BIN'] } }, select: { toLocationId: true, skuId: true } }),
      warehouse ? tx.company.findUnique({ where: { id: warehouse.companyId }, select: { agingGranularity: true } }) : null,
      tx.multiSkuLaneException.findFirst({ where: { warehouseId, status: 'APPROVED' } }),
    ]);

    const agingGranularity: string | null = companyRow?.agingGranularity ?? null;
    const exceptionActive = !!exception;

    // balance + last receivedDate per (location, sku)
    const balanceByLocSku = new Map<string, number>();
    const lastReceivedDateByLocSku = new Map<string, Date | null>();
    for (const m of movements) {
      const key = `${m.locationId}|${m.skuId}`;
      balanceByLocSku.set(key, (balanceByLocSku.get(key) || 0) + Number(m.quantity));
      if (Number(m.quantity) > 0 && m.receivedDate) lastReceivedDateByLocSku.set(key, m.receivedDate);
    }
    const targetedLocationIds = new Set(openTaskTargets.map((t: any) => t.toLocationId).filter(Boolean));
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
    for (const t of openTaskTargets) if (t.toLocationId) pendingSkuByLocation.set(t.toLocationId, t.skuId);

    // group into lanes
    const lanes = new Map<string, any[]>();
    for (const loc of locations) {
      const key = this.laneKeyOf(loc);
      if (!lanes.has(key)) lanes.set(key, []);
      lanes.get(key)!.push(loc);
    }

    type Candidate = { locationId: string; occupancyCount: number; flankNumber: number | null };
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
        for (const [key, qty] of balanceByLocSku) {
          if (qty > 0 && key.startsWith(`${loc.id}|`)) occupantSkuIds.add(key.split('|')[1]);
        }
        const pendingSku = pendingSkuByLocation.get(loc.id);
        if (pendingSku) occupantSkuIds.add(pendingSku);
      }

      let laneEligible = true;
      let sameSku = false;

      if (occupantSkuIds.size === 0) {
        laneEligible = true;
      } else if (occupantSkuIds.size === 1 && occupantSkuIds.has(skuId)) {
        // Same-SKU top-up — always eligible on distinct-SKU-count grounds;
        // gated instead by the aging check (rule: only if age matches, or
        // no prior age is on file to compare against).
        sameSku = true;
        let existingDate: Date | null = null;
        for (const loc of laneLocations) {
          const d = lastReceivedDateByLocSku.get(`${loc.id}|${skuId}`);
          if (d) existingDate = d;
        }
        if (existingDate && newStockDate && !this.sameAgeBucket(existingDate, newStockDate, agingGranularity)) {
          laneEligible = false; // must fully empty before a different-age batch can enter
        }
      } else {
        // Cross-SKU mixing — governed by maxSkusClass*, most-restrictive-
        // class-wins across every occupant AND the incoming SKU, UNLESS an
        // approved MultiSkuLaneException is currently active for this
        // warehouse (the only bypass, per [[wms-putaway-design]]).
        if (!exceptionActive) {
          const occupantClasses = await Promise.all(
            [...occupantSkuIds].map(async (id) => {
              const s = await tx.sku.findUnique({ where: { id }, select: { abcClass: true } });
              return (s?.abcClass || 'C').toUpperCase();
            }),
          );
          const caps = [abcClass, ...occupantClasses].map((cls) => this.maxSkusForClass(row, cls));
          // null = unbounded; the most restrictive (lowest, non-null) cap wins.
          const finiteCaps = caps.filter((c): c is number => c !== null);
          const effectiveCap = finiteCaps.length > 0 ? Math.min(...finiteCaps) : null;
          if (effectiveCap !== null && occupantSkuIds.size >= effectiveCap) laneEligible = false;
          // An A-class occupant's own cap (1) makes effectiveCap 1 the
          // moment it's present, which — combined with occupantSkuIds.size
          // already being >=1 — always blocks a different SKU. Matches
          // "till a A class is there... it should get empty" exactly.
        }
      }

      if (!laneEligible) continue;
      if (excludeLocationIds.includes(laneLocations[0].id) && laneLocations.length === 1) continue;

      // Deepest-first fill: among this lane's positions, pick the one with
      // the HIGHEST depth that's currently empty, not already targeted by
      // another open task, and not in the excluded list.
      const sorted = [...laneLocations].sort((a, b) => (b.depth ?? 0) - (a.depth ?? 0));
      const target = sorted.find(
        (loc) => (balanceByLocSku.get(`${loc.id}|${skuId}`) || 0) <= 0 && !targetedLocationIds.has(loc.id) && !excludeLocationIds.includes(loc.id) && [...balanceByLocSku.keys()].every((k) => !(k.startsWith(`${loc.id}|`) && (balanceByLocSku.get(k) || 0) > 0)),
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
        (loc: any) => [...balanceByLocSku.keys()].some((k) => k.startsWith(`${loc.id}|`) && (balanceByLocSku.get(k) || 0) > 0) || pendingSkuByLocation.has(loc.id),
      ).length;

      candidates.push({ locationId: target.id, occupancyCount, flankNumber: target.flankNumber ?? null });
    }

    if (candidates.length === 0) return null;

    // Two-tier preference: (1) prefer the FULLEST eligible lane — most
    // positions already occupied by anyone, same SKU or a different
    // compatible one — so a lane sitting at 2/3 full always wins over one
    // at 1/3 full. This naturally makes same-SKU top-up "win" too (a lane
    // holding only this SKU has no competition, so it's already the
    // fullest option for it) without needing a separate same-SKU rule —
    // and for A-class it collapses back to exactly today's behavior,
    // since A's maxSkusClassA=1 cap means the only way a lane can have
    // ANY occupant at all is if it's this exact SKU. (2) otherwise order
    // by flankNumber as the distance proxy until DockLocationDistance has
    // real data — A-class prefers low (near), C-class prefers high (far),
    // B defaults near same as A (no strong signal either way yet).
    // 2026-08-29 — the client's own "3 C-class SKUs should share one
    // lane's 3 depths, not open 3 separate levels" correction, refined a
    // second time after the client's own trace showed the first fix was
    // still too coarse (exact-SKU-match beating a fuller different-SKU
    // lane).
    candidates.sort((a, b) => {
      if (a.occupancyCount !== b.occupancyCount) return b.occupancyCount - a.occupancyCount;
      const fa = a.flankNumber ?? Number.MAX_SAFE_INTEGER;
      const fb = b.flankNumber ?? Number.MAX_SAFE_INTEGER;
      return abcClass === 'C' ? fb - fa : fa - fb;
    });

    return candidates[0].locationId;
  }

  // The vehicle's own Dock In time, per receipt — confirmed as "the" date
  // for the simple localized-aging stand-in (one shared date per vehicle,
  // not per case — see [[wms-putaway-design]]).
  async resolveReceivedDate(tx: any, receiptId: string): Promise<Date | null> {
    const receipt = await tx.inboundReceipt.findUnique({ where: { id: receiptId }, select: { gateEntry: { select: { dockedInAt: true } } } });
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
  private async assumedCapacity(warehouseId: string): Promise<{ capacity: number; avgTripMinutes: number; equipmentTypeName: string } | null> {
    const primaryRow = await this.prisma.warehouseEquipmentSuitability.findFirst({
      where: { warehouseId, putawaySuitability: 'PRIMARY' },
      include: { equipmentType: true },
    });
    if (!primaryRow) return null;
    return {
      capacity: Number(primaryRow.equipmentType.genericPalletsPerTrip) || 1,
      avgTripMinutes: Number(primaryRow.equipmentType.genericAvgTripMinutes || 0),
      equipmentTypeName: primaryRow.equipmentType.name,
    };
  }

  async estimateTrips(warehouseId: string, quantity: number): Promise<{ trips: number; equipmentTypeName: string | null; estimatedMinutes: number | null }> {
    const assumed = await this.assumedCapacity(warehouseId);
    if (!assumed) return { trips: 1, equipmentTypeName: null, estimatedMinutes: null };
    const trips = Math.max(1, Math.ceil(quantity / assumed.capacity));
    return { trips, equipmentTypeName: assumed.equipmentTypeName, estimatedMinutes: trips * assumed.avgTripMinutes };
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
      include: { lines: true, warehouse: { select: { id: true } }, stagingLocation: { select: { id: true } } },
    });
    if (!receipt) return;
    const receivedDate = await this.resolveReceivedDate(tx, receiptId);

    for (const line of receipt.lines) {
      const qty = Number(line.receivedQty);
      if (qty <= 0) continue;
      const existingTask = await tx.putawayTask.findFirst({ where: { receiptLineId: line.id } });
      if (existingTask) continue;

      const fromLocationId = line.stagingLocationId ?? receipt.stagingLocationId;
      if (!fromLocationId) continue; // shouldn't happen — matchReceipt requires staging

      const toLocationId = await this.suggestBin(tx, { warehouseId: receipt.warehouse.id, skuId: line.skuId, newStockDate: receivedDate });
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
  async handleAcceptedScan(tx: any, params: { receiptLineId: string; skuId: string; quantity: number; locationId: string; warehouseId: string; receiptId: string }) {
    const warehouse = await tx.warehouse.findUnique({ where: { id: params.warehouseId }, select: { companyId: true } });
    if (!warehouse) return;
    const company = await tx.company.findUnique({ where: { id: warehouse.companyId }, select: { putawayTriggerMode: true, putawayDefaultBatchQty: true } });
    if (!company || company.putawayTriggerMode !== 'IMMEDIATE') return;

    const sku = await tx.sku.findUnique({ where: { id: params.skuId }, select: { putawayBatchQty: true } });
    const thresholdRaw = sku?.putawayBatchQty ?? company.putawayDefaultBatchQty;
    const threshold = thresholdRaw != null ? Number(thresholdRaw) : null;
    const receivedDate = await this.resolveReceivedDate(tx, params.receiptId);

    const createTask = async (quantity: number, openForAccumulation: boolean) => {
      const toLocationId = await this.suggestBin(tx, { warehouseId: params.warehouseId, skuId: params.skuId, newStockDate: receivedDate });
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

    const open = await tx.putawayTask.findFirst({ where: { receiptLineId: params.receiptLineId, openForAccumulation: true } });
    if (open) {
      const newQty = Number(open.quantity) + params.quantity;
      await tx.putawayTask.update({ where: { id: open.id }, data: { quantity: newQty, openForAccumulation: newQty < threshold } });
      return;
    }
    await createTask(params.quantity, params.quantity < threshold);
  }

  // ------------------------------------------------------------
  // Read
  // ------------------------------------------------------------

  async findAll(user: any, warehouseId?: string) {
    const where: any = { receiptLine: { receipt: { warehouse: { ...companyFilter(user) } } } };
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
        const movedQuantity = t.trips.filter((tr: any) => tr.status === 'COMPLETED').reduce((sum: number, tr: any) => sum + Number(tr.quantity), 0);
        const inProgressTrip = t.trips.find((tr: any) => tr.status === 'IN_PROGRESS');
        return { ...t, movedQuantity, inProgressTrip };
      });
  }

  private async assertTaskAccess(id: string, user: any) {
    const task = await this.prisma.putawayTask.findUnique({
      where: { id },
      include: { ...TASK_INCLUDE, receiptLine: { include: { receipt: { include: { warehouse: true } } } }, trips: true },
    });
    if (!task) throw new NotFoundException('Putaway task not found.');
    const warehouse = (task.receiptLine as any).receipt.warehouse;
    if (user.role !== 'SUPER_ADMIN' && warehouse.companyId !== user.companyId) throw new ForbiddenException('You do not have access to this task.');
    if (PUTAWAY_SCOPED_ROLES.includes(user.role)) {
      const ids = await ownWarehouseIds(this.prisma, user.userId);
      if (!ids.includes(warehouse.id)) throw new ForbiddenException('You do not have access to this task.');
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
  async claimTrip(barcode: any, user: any) {
    const trimmed = barcode != null ? String(barcode).trim() : '';
    if (!trimmed) throw new BadRequestException('A barcode is required.');

    const barcodeMatches = await this.prisma.skuBarcode.findMany({
      where: { barcode: trimmed, sku: { companyId: user.companyId } },
      select: { skuId: true },
    });
    if (barcodeMatches.length === 0) throw new BadRequestException('Unrecognized barcode.');
    const skuIds = [...new Set(barcodeMatches.map((b: any) => b.skuId))];

    const scopedWarehouseIds = PUTAWAY_SCOPED_ROLES.includes(user.role) ? await ownWarehouseIds(this.prisma, user.userId) : null;

    const candidateTasks = await this.prisma.putawayTask.findMany({
      where: {
        skuId: { in: skuIds },
        status: 'PENDING',
        openForAccumulation: false,
        receiptLine: { receipt: { warehouse: { companyId: user.companyId, ...(scopedWarehouseIds ? { id: { in: scopedWarehouseIds } } : {}) } } },
      },
      include: { trips: true },
      orderBy: { createdAt: 'asc' },
    });

    const task = candidateTasks.find((t: any) => {
      const moved = t.trips.filter((tr: any) => tr.status === 'COMPLETED').reduce((s: number, tr: any) => s + Number(tr.quantity), 0);
      const hasOpenTrip = t.trips.some((tr: any) => tr.status === 'IN_PROGRESS');
      return moved < Number(t.quantity) && !hasOpenTrip;
    });
    if (!task) throw new BadRequestException('No workable putaway task found for this SKU — it may already be fully claimed or completed.');

    const moved = task.trips.filter((tr: any) => tr.status === 'COMPLETED').reduce((s: number, tr: any) => s + Number(tr.quantity), 0);
    const remaining = Number(task.quantity) - moved;
    const warehouseId = (await this.prisma.location.findUnique({ where: { id: task.fromLocationId }, select: { warehouseId: true } }))!.warehouseId;
    const assumed = await this.assumedCapacity(warehouseId);
    // One trip moves whatever the assumed equipment can carry, capped at
    // what's actually left on the task — the last trip of a task is
    // naturally smaller than a full capacity load. No equipment configured
    // for this warehouse yet -> one trip covers everything remaining.
    const tripQuantity = assumed ? Math.min(remaining, assumed.capacity) : remaining;

    return this.prisma.putawayTrip.create({
      data: { taskId: task.id, quantity: tripQuantity, claimedById: user.userId, stagingBarcodeScanned: trimmed },
      include: { task: { include: TASK_INCLUDE } },
    });
  }

  // The location scan — completes a trip. Only a scan matching the task's
  // own toLocationId is ever accepted; a mismatch hard-blocks with no
  // override, per the client's explicit "doesnt allow operator to
  // override." Writes the real PUTAWAY_OUT/PUTAWAY_IN StockMovement pair
  // for this trip's quantity, carrying receivedDate forward unchanged.
  async completeTrip(tripId: string, locationCode: any, user: any) {
    const trip = await this.prisma.putawayTrip.findUnique({ where: { id: tripId }, include: { task: true } });
    if (!trip) throw new NotFoundException('Trip not found.');
    if (trip.status !== 'IN_PROGRESS') throw new BadRequestException('This trip is not awaiting a location scan.');
    if (trip.claimedById !== user.userId) throw new ForbiddenException('Only the operator who claimed this trip can complete it.');

    const task = trip.task as any;
    if (!task.toLocationId) throw new BadRequestException('This task has no assigned bin yet.');

    const trimmed = locationCode != null ? String(locationCode).trim().toUpperCase() : '';
    // Match against the task's own destination directly — accepting
    // EITHER the raw `code` or the human "Rack Name" (buildRackName
    // above), since 2026-08-29 the task screen shows Rack Name, not the
    // raw code, so whatever's displayed must be exactly what completes
    // the trip when typed/scanned back.
    const scannedLocation = await this.prisma.location.findUnique({ where: { id: task.toLocationId } });
    const rackName = buildRackName(scannedLocation as any);
    const matches = !!scannedLocation && (scannedLocation.code.toUpperCase() === trimmed || (rackName != null && rackName.toUpperCase() === trimmed));

    if (!matches) {
      throw new BadRequestException(`Wrong location — this must be put away at the assigned bin, not "${trimmed}".`);
    }
    const targetLocation = scannedLocation!;

    const receivedDate = await this.resolveReceivedDate(this.prisma, (await this.prisma.inboundReceiptLine.findUnique({ where: { id: task.receiptLineId }, select: { receiptId: true } }))!.receiptId);

    return this.prisma.$transaction(async (tx) => {
      const updatedTrip = await tx.putawayTrip.update({
        where: { id: tripId },
        data: { status: 'COMPLETED', scannedLocationId: targetLocation.id, completedAt: new Date() },
      });

      await tx.stockMovement.create({
        data: {
          warehouseId: targetLocation.warehouseId,
          skuId: task.skuId,
          locationId: task.fromLocationId,
          quantity: -Number(trip.quantity),
          movementType: 'PUTAWAY_OUT',
          referenceType: 'PutawayTrip',
          referenceId: tripId,
          createdById: user.userId,
          receivedDate,
        },
      });
      await tx.stockMovement.create({
        data: {
          warehouseId: targetLocation.warehouseId,
          skuId: task.skuId,
          locationId: task.toLocationId,
          quantity: Number(trip.quantity),
          movementType: 'PUTAWAY_IN',
          referenceType: 'PutawayTrip',
          referenceId: tripId,
          createdById: user.userId,
          receivedDate,
        },
      });

      const allTrips = await tx.putawayTrip.findMany({ where: { taskId: task.id } });
      const moved = allTrips.filter((t: any) => t.status === 'COMPLETED').reduce((s: number, t: any) => s + Number(t.quantity), 0);
      if (moved >= Number(task.quantity)) {
        await tx.putawayTask.update({ where: { id: task.id }, data: { status: 'COMPLETED' } });
        await this.maybeCompleteReceiptPutaway(tx, task.receiptLineId);
      }

      return updatedTrip;
    });
  }

  // Flips InboundReceipt.status to PUTAWAY_COMPLETE once every task tied to
  // it is COMPLETED — closes the loop completeInward() already checks for
  // but nothing has ever set (see [[wms-putaway-design]]).
  private async maybeCompleteReceiptPutaway(tx: any, receiptLineId: string) {
    const line = await tx.inboundReceiptLine.findUnique({ where: { id: receiptLineId }, select: { receiptId: true } });
    if (!line) return;
    const receiptTasks = await tx.putawayTask.findMany({ where: { receiptLine: { receiptId: line.receiptId } } });
    if (receiptTasks.length === 0 || receiptTasks.some((t: any) => t.status !== 'COMPLETED')) return;
    const receipt = await tx.inboundReceipt.findUnique({ where: { id: line.receiptId }, select: { status: true } });
    if (receipt?.status === 'RECEIVED') {
      await tx.inboundReceipt.update({ where: { id: line.receiptId }, data: { status: 'PUTAWAY_COMPLETE' } });
    }
  }

  // "Request different bin" — only when the suggested location is
  // physically unusable, never a manual pick. Re-suggests excluding every
  // location this task has already been assigned to.
  async requestDifferentBin(taskId: string, reason: any, user: any) {
    const task = await this.assertTaskAccess(taskId, user);
    if (task.status === 'COMPLETED') throw new BadRequestException('This task is already completed.');
    if (task.trips.some((t: any) => t.status === 'IN_PROGRESS')) throw new BadRequestException('Complete or abandon the in-progress trip before requesting a different bin.');

    const priorReassignments = await this.prisma.putawayReassignment.findMany({ where: { taskId }, select: { previousLocationId: true, newLocationId: true } });
    const excludeLocationIds = [
      ...new Set([task.toLocationId, ...priorReassignments.flatMap((r: any) => [r.previousLocationId, r.newLocationId])].filter(Boolean) as string[]),
    ];

    const warehouseId = (await this.prisma.location.findUnique({ where: { id: task.fromLocationId }, select: { warehouseId: true } }))!.warehouseId;
    const receivedDate = await this.resolveReceivedDate(this.prisma, (await this.prisma.inboundReceiptLine.findUnique({ where: { id: task.receiptLineId }, select: { receiptId: true } }))!.receiptId);
    const newLocationId = await this.suggestBin(this.prisma, { warehouseId, skuId: task.skuId, excludeLocationIds, newStockDate: receivedDate });

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
        data: { toLocationId: newLocationId ?? null, status: newLocationId ? 'PENDING' : 'NEEDS_BIN' },
        include: TASK_INCLUDE,
      });
    });
  }
}
