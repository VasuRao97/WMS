import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
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
// everywhere else in this codebase.
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

    return { marrying, putaway, abandoned };
  }
}
