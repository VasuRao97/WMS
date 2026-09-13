import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { MovementType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { companyFilter, ownWarehouseIds, WAREHOUSE_SCOPED_ROLES } from '../common/tenant.util';

// Analytics — the real, final module in the build order, deliberately
// separate from the earlier one-off Insights page (2026-08-29 — "not the
// same as the eventual full Analytics module"). Started with operator
// productivity at the Pallet level (2026-09-02, see [[wms-putaway-design]]
// and CLAUDE.md's matching section): "for each operator whats the time for
// him/her at a pallet level, we then get to know the productivity stuff" —
// the client's own explicit call to START PUBLISHING this, not just leave
// it derivable-in-theory. Two phases, always reported separately per
// operator (never blended into one combined number, per the client's own
// framing): marrying (loading cases onto a pallet, from StockMovement) and
// putaway (moving the closed pallet to its bin, from PutawayTrip) — both
// entirely derived from data already being written elsewhere, no new
// schema, same "always derive, never store a counter" philosophy as
// everywhere else in this codebase. A third metric, Pick Face trip time,
// was added 2026-09-05 the same session Pick Face itself shipped (see
// [[wms-putaway-design]]) — NOT pallet-level like the two above, grouped by
// task instead since a PickFaceTask has no palletLoadId at all.
@Injectable()
export class AnalyticsService {
  constructor(private prisma: PrismaService) {}

  private async assertWarehouseAccess(warehouseId: string, user: any) {
    const warehouse = await this.prisma.warehouse.findUnique({ where: { id: warehouseId } });
    if (!warehouse) throw new NotFoundException('Warehouse not found.');
    if (user.role !== 'SUPER_ADMIN' && warehouse.companyId !== user.companyId) {
      throw new ForbiddenException('You do not have access to this warehouse.');
    }
    if (WAREHOUSE_SCOPED_ROLES.includes(user.role)) {
      const ids = await ownWarehouseIds(this.prisma, user.userId);
      if (!ids.includes(warehouseId)) throw new ForbiddenException('You do not have access to this warehouse.');
    }
  }

  // Operator productivity at the Pallet level — marrying + putaway,
  // reported separately, plus abandoned-claim flags. warehouseId is
  // optional (company-wide when omitted, for COMPANY_ADMIN/SUPER_ADMIN
  // only — a warehouse-scoped role must always narrow to one of their
  // own, enforced below same as every other scoped read in this codebase).
  async operatorProductivity(user: any, warehouseId?: string) {
    if (warehouseId) {
      await this.assertWarehouseAccess(warehouseId, user);
    } else if (WAREHOUSE_SCOPED_ROLES.includes(user.role)) {
      throw new BadRequestException('Select a warehouse.');
    }

    const warehouseFilter = { ...companyFilter(user), ...(warehouseId ? { id: warehouseId } : {}) };

    // ------------------------------------------------------------
    // Marrying — every RECEIPT StockMovement tagged with a palletLoadId
    // is one case scanned onto a pallet. Grouped by (palletLoadId,
    // createdById) so two operators sharing one pallet's loading each get
    // their own window, never blended (the client's own explicit ask).
    // ------------------------------------------------------------
    const receiptScans = await this.prisma.stockMovement.findMany({
      where: { palletLoadId: { not: null }, movementType: 'RECEIPT', warehouse: warehouseFilter },
      select: {
        palletLoadId: true,
        createdById: true,
        createdAt: true,
        createdBy: { select: { id: true, name: true } },
        palletLoad: { select: { pallet: { select: { code: true } }, sku: { select: { code: true } } } },
      },
      orderBy: { createdAt: 'asc' },
    });

    type Bucket = { operatorId: string; operatorName: string; palletLoadId: string; palletCode: string; skuCode: string; start: Date; end: Date; scanCount: number };
    const marryingBuckets = new Map<string, Bucket>();
    for (const m of receiptScans) {
      const key = `${m.palletLoadId}|${m.createdById}`;
      const existing = marryingBuckets.get(key);
      if (existing) {
        existing.end = m.createdAt;
        existing.scanCount += 1;
      } else {
        marryingBuckets.set(key, {
          operatorId: m.createdById,
          operatorName: m.createdBy.name,
          palletLoadId: m.palletLoadId!,
          palletCode: m.palletLoad!.pallet.code,
          skuCode: m.palletLoad!.sku.code,
          start: m.createdAt,
          end: m.createdAt,
          scanCount: 1,
        });
      }
    }
    const marrying = [...marryingBuckets.values()].map((b) => ({
      operatorId: b.operatorId,
      operatorName: b.operatorName,
      palletCode: b.palletCode,
      skuCode: b.skuCode,
      scanCount: b.scanCount,
      startedAt: b.start,
      endedAt: b.end,
      durationMinutes: Math.round(((b.end.getTime() - b.start.getTime()) / 60000) * 10) / 10,
    }));

    // ------------------------------------------------------------
    // Putaway — every COMPLETED PutawayTrip on a task tied to a
    // palletLoadId. A multi-trip task split across operators produces
    // one row per operator, summed if that operator claimed more than
    // one trip on the same pallet.
    // ------------------------------------------------------------
    const trips = await this.prisma.putawayTrip.findMany({
      where: {
        status: 'COMPLETED',
        task: { palletLoadId: { not: null }, receiptLine: { receipt: { warehouse: warehouseFilter } } },
      },
      select: {
        claimedAt: true,
        completedAt: true,
        claimedById: true,
        claimedBy: { select: { id: true, name: true } },
        task: { select: { palletLoad: { select: { id: true, pallet: { select: { code: true } }, sku: { select: { code: true } } } } } },
      },
    });

    type PutawayBucket = { operatorId: string; operatorName: string; palletLoadId: string; palletCode: string; skuCode: string; totalMinutes: number; tripCount: number };
    const putawayBuckets = new Map<string, PutawayBucket>();
    for (const t of trips) {
      if (!t.completedAt || !t.task.palletLoad) continue;
      const key = `${t.task.palletLoad.id}|${t.claimedById}`;
      const minutes = (t.completedAt.getTime() - t.claimedAt.getTime()) / 60000;
      const existing = putawayBuckets.get(key);
      if (existing) {
        existing.totalMinutes += minutes;
        existing.tripCount += 1;
      } else {
        putawayBuckets.set(key, {
          operatorId: t.claimedById,
          operatorName: t.claimedBy.name,
          palletLoadId: t.task.palletLoad.id,
          palletCode: t.task.palletLoad.pallet.code,
          skuCode: t.task.palletLoad.sku.code,
          totalMinutes: minutes,
          tripCount: 1,
        });
      }
    }
    const putaway = [...putawayBuckets.values()].map((b) => ({
      operatorId: b.operatorId,
      operatorName: b.operatorName,
      palletCode: b.palletCode,
      skuCode: b.skuCode,
      tripCount: b.tripCount,
      durationMinutes: Math.round(b.totalMinutes * 10) / 10,
    }));

    // ------------------------------------------------------------
    // Abandoned claims — flagged against the operator who claimed the
    // trip and never completed it (2026-09-02, the client's own explicit
    // call: "that should be flagged against that first operator, we will
    // then ask him/her why they didnt pick it up"). No completedAt exists
    // for an ABANDONED trip — PutawayClaimExpiryScheduler only ever sets
    // status, so "how long it sat claimed" is only known as "at least the
    // 30-minute timeout," not an exact figure; shown as claimedAt only,
    // not a duration, to avoid implying false precision.
    // ------------------------------------------------------------
    const abandonedTrips = await this.prisma.putawayTrip.findMany({
      where: {
        status: 'ABANDONED',
        task: { palletLoadId: { not: null }, receiptLine: { receipt: { warehouse: warehouseFilter } } },
      },
      select: {
        claimedAt: true,
        claimedById: true,
        claimedBy: { select: { id: true, name: true } },
        task: { select: { palletLoad: { select: { pallet: { select: { code: true } }, sku: { select: { code: true } } } } } },
      },
      orderBy: { claimedAt: 'desc' },
    });
    const abandoned = abandonedTrips
      .filter((t) => t.task.palletLoad)
      .map((t) => ({
        operatorId: t.claimedById,
        operatorName: t.claimedBy.name,
        palletCode: t.task.palletLoad!.pallet.code,
        skuCode: t.task.palletLoad!.sku.code,
        claimedAt: t.claimedAt,
      }));

    // ------------------------------------------------------------
    // Pick Face (2026-09-05, see [[wms-putaway-design]]) — a third,
    // separately-reported metric, added the same session Pick Face itself
    // shipped, per the client's own explicit call ("add Pick Face time as a
    // third metric"). NOT pallet-level like the two reports above — a
    // PickFaceTask has no palletLoadId at all (it's a plain reserve<->pick-
    // face SKU move, not a Pallet consolidation concept), so this groups by
    // (taskId, claimedById) instead — the same "sum every trip an operator
    // ran against one unit of work" shape, just keyed by task rather than
    // by pallet. No abandoned-claim equivalent exists yet: PickFaceTrip has
    // no ABANDONED status/claim-expiry (see [[wms-putaway-design]]'s
    // still-open list), so there's nothing to flag here today.
    // ------------------------------------------------------------
    const pickFaceTrips = await this.prisma.pickFaceTrip.findMany({
      where: { status: 'COMPLETED', task: { warehouse: warehouseFilter } },
      select: {
        claimedAt: true,
        completedAt: true,
        claimedById: true,
        claimedBy: { select: { id: true, name: true } },
        task: {
          select: {
            id: true,
            reason: true,
            sku: { select: { code: true } },
            fromLocation: { select: { code: true } },
            toLocation: { select: { code: true } },
          },
        },
      },
    });

    type PickFaceBucket = {
      operatorId: string; operatorName: string; taskId: string; reason: string; skuCode: string;
      fromCode: string; toCode: string; totalMinutes: number; tripCount: number;
    };
    const pickFaceBuckets = new Map<string, PickFaceBucket>();
    for (const t of pickFaceTrips) {
      if (!t.completedAt) continue;
      const key = `${t.task.id}|${t.claimedById}`;
      const minutes = (t.completedAt.getTime() - t.claimedAt.getTime()) / 60000;
      const existing = pickFaceBuckets.get(key);
      if (existing) {
        existing.totalMinutes += minutes;
        existing.tripCount += 1;
      } else {
        pickFaceBuckets.set(key, {
          operatorId: t.claimedById,
          operatorName: t.claimedBy.name,
          taskId: t.task.id,
          reason: t.task.reason,
          skuCode: t.task.sku.code,
          fromCode: t.task.fromLocation.code,
          toCode: t.task.toLocation.code,
          totalMinutes: minutes,
          tripCount: 1,
        });
      }
    }
    const pickFace = [...pickFaceBuckets.values()].map((b) => ({
      operatorId: b.operatorId,
      operatorName: b.operatorName,
      reason: b.reason,
      skuCode: b.skuCode,
      fromCode: b.fromCode,
      toCode: b.toCode,
      tripCount: b.tripCount,
      durationMinutes: Math.round(b.totalMinutes * 10) / 10,
    }));

    return { marrying, putaway, abandoned, pickFace };
  }

  // Movement types that represent stock genuinely NEW to the warehouse
  // boundary — RECEIPT (a fresh inbound receipt) and RETURN_IN (a customer
  // return coming back). Deliberately EXCLUDES PUTAWAY_IN/
  // PICK_FACE_REPLENISH_IN even though both are positive movements: those
  // are purely INTERNAL transfers of stock that already arrived via
  // RECEIPT, so summing them in here would double-count every unit that
  // ever got put away (once as RECEIPT into staging, again as PUTAWAY_IN
  // into storage). A real correctness point, flagged rather than silently
  // assumed — see [[wms-inventory-design]] in memory.
  private static readonly GENUINE_INWARD_TYPES: MovementType[] = ['RECEIPT', 'RETURN_IN'];

  // Daily inward volume — units AND distinct pallets, per day, over a date
  // range (default: the last 30 days ending today). 2026-09-13 follow-on
  // ask from the Inventory ledger-export conversation. OUTWARD IS
  // DELIBERATELY NOT INCLUDED — PICK/DISPATCH movements are schema-only
  // today (no module writes them yet), so "outward" has nothing genuine to
  // show; confirmed directly with the client to build inward-only now
  // rather than hold the whole dashboard. Adding outward later needs zero
  // changes here — just a second parallel query once Picking/Dispatch are
  // real. "Pallets" is a real COUNT of distinct palletLoadId among that
  // day's inward movements — zero on a day with no palletized activity,
  // not a fabricated stand-in for non-palletized stock (confirmed
  // directly: no invented proxy metric for the common non-palletized case).
  //
  // warehouseId is optional — company-wide when omitted, COMPANY_ADMIN/
  // SUPER_ADMIN only, same convention as operatorProductivity above and the
  // Inventory ledger export.
  async dailyInward(user: any, warehouseId?: string, from?: string, to?: string) {
    if (warehouseId) {
      await this.assertWarehouseAccess(warehouseId, user);
    } else if (WAREHOUSE_SCOPED_ROLES.includes(user.role)) {
      throw new BadRequestException('Select a warehouse.');
    }

    // Default window: the last 30 days ending today — a dashboard needs
    // SOME bounded default (unlike the Ledger export's "blank = whole
    // history," fine for a one-off dump but unreadable as a daily trend
    // chart over years of flat history). Still overridable via explicit
    // from/to, same date-input UX as the Ledger tab.
    const toDate = to ? new Date(`${to}T23:59:59.999Z`) : new Date();
    const fromDate = from ? new Date(`${from}T00:00:00.000Z`) : new Date(toDate.getTime() - 29 * 86400000);

    const warehouseFilter = warehouseId ? { id: warehouseId } : companyFilter(user);
    const movements = await this.prisma.stockMovement.findMany({
      where: {
        movementType: { in: AnalyticsService.GENUINE_INWARD_TYPES },
        warehouse: warehouseFilter,
        createdAt: { gte: fromDate, lte: toDate },
      },
      select: { createdAt: true, quantity: true, palletLoadId: true },
    });

    // Zero-fill every day in the range — a day with no receiving activity
    // is a real, meaningful zero, not a gap to skip (a bar chart that
    // silently omits down days misrepresents the trend).
    const byDay = new Map<string, { units: number; pallets: Set<string> }>();
    for (const d = new Date(fromDate); d <= toDate; d.setUTCDate(d.getUTCDate() + 1)) {
      byDay.set(d.toISOString().slice(0, 10), { units: 0, pallets: new Set() });
    }
    for (const m of movements) {
      const key = m.createdAt.toISOString().slice(0, 10);
      const bucket = byDay.get(key);
      if (!bucket) continue; // defensive — shouldn't happen, the range covers every movement queried
      bucket.units += Number(m.quantity);
      if (m.palletLoadId) bucket.pallets.add(m.palletLoadId);
    }

    return [...byDay.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, b]) => ({ date, units: b.units, pallets: b.pallets.size }));
  }
}
