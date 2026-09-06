import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { PutawayTasksService } from '../putaway/putaway-tasks.service';

// Pick Face reslotting (2026-09-05, SPR only — see [[wms-putaway-design]] in
// memory and CLAUDE.md's "Pick Face" section for the full design
// conversation). A periodic scheduled run, NOT live/continuous — the
// client's own call, given this means real physical labor to swap a
// still-good pallet, closer to a real warehouse's periodic reslotting
// exercise than a live dispatch signal. Runs once a day for every
// `pickFaceEnabled` warehouse's SPR `PICK_FACE` locations:
//
//   - REFILL: an empty PICK_FACE location gets the highest-priority
//     unslotted A/B-class SKU with real reserve stock, sourced from that
//     SKU's LEANEST reserve (ACTUAL_STORAGE) location — the codebase's own
//     "prefer the fullest lane" logic in suggestBin(), mirrored in reverse
//     to consolidate/empty out the leanest reserve position first.
//   - EVICTION: an occupied PICK_FACE location's current SKU is a STRICTLY
//     LOWER class than some unslotted candidate (class-tier order only,
//     confirmed with the client — A can evict B, B/C never evict each
//     other, nothing ever evicts A) — moved back to reserve via
//     PutawayTasksService.suggestBin(), reusing the exact same
//     ACTUAL_STORAGE bin-suggestion logic as any other putaway. The freed
//     slot's own REFILL happens on the NEXT day's run once the eviction
//     trip actually completes and the location reads empty again —
//     deliberately not a single paired "swap" task (see schema.prisma's
//     comment on PickFaceTask for the full reasoning).
//
// A no-op for any warehouse with pickFaceEnabled false, and for any
// location tagged PICK_FACE that isn't storageType SPR (Drive-in/ASRS/
// Ground/Stillage pick faces are explicitly out of scope for this pass).
// Real depletion (a PICK_FACE slot's on-hand actually reaching zero through
// use) can't happen yet — MovementType.PICK is schema-only, never written
// anywhere until a real Picking module exists — so this scheduler is
// dormant-but-ready, same "built now, unexercised until X" situation as
// Pallet reuse-on-depletion.
@Injectable()
export class PickFaceReplenishmentScheduler {
  private readonly logger = new Logger(PickFaceReplenishmentScheduler.name);

  constructor(
    private prisma: PrismaService,
    private putawayTasks: PutawayTasksService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_1AM)
  async runDailyReslotting() {
    const warehouses = await this.prisma.warehouse.findMany({ where: { pickFaceEnabled: true }, select: { id: true } });
    for (const warehouse of warehouses) {
      try {
        await this.reslotWarehouse(warehouse.id);
      } catch (err) {
        this.logger.error(`Pick Face reslotting failed for warehouse ${warehouse.id}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  async reslotWarehouse(warehouseId: string) {
    const pickFaceLocations = await this.prisma.location.findMany({
      where: { warehouseId, zoneType: 'PICK_FACE', storageType: 'SPR', isActive: true },
    });
    if (pickFaceLocations.length === 0) return;

    const reserveLocations = await this.prisma.location.findMany({
      where: { warehouseId, zoneType: 'ACTUAL_STORAGE', isActive: true },
      select: { id: true },
    });
    const reserveLocationIds = new Set(reserveLocations.map((l) => l.id));

    const allLocationIds = [...pickFaceLocations.map((l) => l.id), ...reserveLocationIds];
    const movements = await this.prisma.stockMovement.findMany({
      where: { locationId: { in: allLocationIds } },
      select: { locationId: true, skuId: true, quantity: true },
    });

    // Current on-hand balance per (location, sku) — "always derive, never
    // store an occupancy flag," same convention as suggestBin()/Insights.
    const balanceByLocation = new Map<string, Map<string, number>>();
    for (const m of movements) {
      if (!balanceByLocation.has(m.locationId)) balanceByLocation.set(m.locationId, new Map());
      const inner = balanceByLocation.get(m.locationId)!;
      inner.set(m.skuId, (inner.get(m.skuId) || 0) + Number(m.quantity));
    }

    // Current occupant of each pick face location, if any (qty > 0). A pick
    // face slot is meant to hold exactly one SKU by design — the first
    // positive balance found is treated as the occupant.
    const occupantByPickFaceLoc = new Map<string, { skuId: string; qty: number }>();
    for (const loc of pickFaceLocations) {
      const inner = balanceByLocation.get(loc.id);
      if (!inner) continue;
      for (const [skuId, qty] of inner) {
        if (qty > 0) {
          occupantByPickFaceLoc.set(loc.id, { skuId, qty });
          break;
        }
      }
    }

    // Reserve stock per SKU across every ACTUAL_STORAGE location in this
    // warehouse (any storage type — the SKU's reserve doesn't care where it
    // physically sits, only the pick face SLOT itself is SPR-specific).
    const reserveBySku = new Map<string, { locationId: string; qty: number }[]>();
    for (const locId of reserveLocationIds) {
      const inner = balanceByLocation.get(locId);
      if (!inner) continue;
      for (const [skuId, qty] of inner) {
        if (qty <= 0) continue;
        if (!reserveBySku.has(skuId)) reserveBySku.set(skuId, []);
        reserveBySku.get(skuId)!.push({ locationId: locId, qty });
      }
    }

    // Guard against duplicating work already in flight — same
    // "pending-reservation blind spot" lesson as suggestBin()'s own fix: a
    // SKU/location already targeted by an open (PENDING) task from a prior
    // run must not get a second task piled on top before the first is even
    // worked.
    const openTasks = await this.prisma.pickFaceTask.findMany({
      where: { warehouseId, status: 'PENDING' },
      select: { skuId: true, fromLocationId: true, toLocationId: true, reason: true },
    });
    const alreadySlottedSkuIds = new Set<string>();
    for (const o of occupantByPickFaceLoc.values()) alreadySlottedSkuIds.add(o.skuId);
    for (const t of openTasks) if (t.reason === 'REFILL') alreadySlottedSkuIds.add(t.skuId);
    const targetedToLocationIds = new Set(openTasks.map((t) => t.toLocationId));
    const targetedFromLocationIds = new Set(openTasks.filter((t) => t.reason === 'EVICTION').map((t) => t.fromLocationId));

    // Eligible unslotted candidates — A/B class only ("mostly A+B," and the
    // client's explicit call that a slot with no A/B candidate stays empty
    // rather than falling back to C). A before B; same-class ties broken by
    // SKU code for determinism (no velocity/recency data exists in this
    // system to do better — see [[wms-putaway-design]]).
    const occupantSkuIds = [...occupantByPickFaceLoc.values()].map((o) => o.skuId);
    const candidateSkuIds = [...reserveBySku.keys()].filter((id) => !alreadySlottedSkuIds.has(id));
    const relevantSkus = await this.prisma.sku.findMany({
      where: { id: { in: [...new Set([...occupantSkuIds, ...candidateSkuIds])] } },
      select: { id: true, code: true, abcClass: true },
    });
    const classById = new Map(relevantSkus.map((s) => [s.id, (s.abcClass || 'C').toUpperCase()]));

    const rank = (cls: string) => (cls === 'A' ? 0 : cls === 'B' ? 1 : 2);
    const candidateQueue = relevantSkus
      .filter((s) => candidateSkuIds.includes(s.id) && ['A', 'B'].includes((s.abcClass || '').toUpperCase()))
      .map((s) => ({ id: s.id, code: s.code, abcClass: (s.abcClass || '').toUpperCase() }))
      .sort((a, b) => rank(a.abcClass) - rank(b.abcClass) || a.code.localeCompare(b.code));

    // Stable location processing order for determinism.
    const sortedLocations = [...pickFaceLocations].sort((a, b) => a.code.localeCompare(b.code));

    for (const loc of sortedLocations) {
      const occupant = occupantByPickFaceLoc.get(loc.id);

      if (!occupant) {
        if (targetedToLocationIds.has(loc.id)) continue; // already has an open REFILL task from a prior run
        const candidate = candidateQueue.shift();
        if (!candidate) continue; // no eligible A/B SKU left — stays empty, per the client's own call
        await this.createRefillTask(warehouseId, loc.id, candidate.id, reserveBySku.get(candidate.id)!);
        continue;
      }

      if (targetedFromLocationIds.has(loc.id)) continue; // already being evicted from a prior run
      const occupantClass = classById.get(occupant.skuId) || 'C';
      const best = candidateQueue[0];
      if (best && rank(best.abcClass) < rank(occupantClass)) {
        candidateQueue.shift();
        await this.createEvictionTask(warehouseId, loc.id, occupant.skuId, occupant.qty);
      }
    }
  }

  // reserve -> pick face. Sourced from the SKU's leanest reserve location —
  // consolidates/empties that position first rather than picking an
  // arbitrary one.
  private async createRefillTask(warehouseId: string, toLocationId: string, skuId: string, reserveOptions: { locationId: string; qty: number }[]) {
    const leanest = reserveOptions.reduce((min, cur) => (cur.qty < min.qty ? cur : min));
    await this.prisma.pickFaceTask.create({
      data: {
        warehouseId,
        skuId,
        fromLocationId: leanest.locationId,
        toLocationId,
        quantity: leanest.qty,
        reason: 'REFILL',
      },
    });
  }

  // pick face -> reserve. Destination chosen via the exact same
  // ACTUAL_STORAGE bin-suggestion logic as any other putaway — this SKU
  // just needs a reserve bin again, nothing pick-face-specific about it.
  private async createEvictionTask(warehouseId: string, fromLocationId: string, skuId: string, qty: number) {
    const toLocationId = await this.putawayTasks.suggestBin(this.prisma, { warehouseId, skuId });
    if (!toLocationId) return; // no eligible reserve bin right now — skip this cycle, try again next run
    await this.prisma.pickFaceTask.create({
      data: {
        warehouseId,
        skuId,
        fromLocationId,
        toLocationId,
        quantity: qty,
        reason: 'EVICTION',
      },
    });
  }
}
