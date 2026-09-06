import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { companyFilter, ownWarehouseIds, WAREHOUSE_SCOPED_ROLES } from '../common/tenant.util';

// Monthly ABC reassessment from real dispatch velocity (2026-09-06 — see
// [[wms-abc-velocity-design]] in memory for the full design conversation).
// The client's own distrust of a manually-typed/imported Sku.abcClass ("i
// wont believe the import ABC class, as it can be a one time master
// dump"): this re-derives each SKU's class from its own actual trailing
// dispatch quantity instead — confirmed WAREHOUSE-scoped, not company-wide
// ("SKUS should be region specific... in kashmir you wont sell coke a lot?
// but its A item you might sell minute maid the most"). Sku.abcClass
// itself is never touched by this — it stays the manually-set/imported
// fallback a SKU with no computed history yet (brand new, or the feature
// is off, or this warehouse hasn't accumulated a full assessment window)
// falls back to; see SkuWarehouseClass for the real, computed result.
@Injectable()
export class AbcClassificationService {
  constructor(private prisma: PrismaService) {}

  // Real, unmodified computation — called by the monthly scheduler for
  // every opted-in company, and by the manual "Run Now" endpoint for one
  // company on demand. Company-scoped: every warehouse of this company
  // gets its own independent classification, per-category within each.
  async reassessCompany(companyId: string) {
    const company = await this.prisma.company.findUnique({ where: { id: companyId } });
    if (!company) return { warehousesProcessed: 0 };

    const windowMonths = company.abcAssessmentWindowMonths;
    const windowStart = new Date();
    windowStart.setMonth(windowStart.getMonth() - windowMonths);

    const warehouses = await this.prisma.warehouse.findMany({ where: { companyId } });
    let warehousesProcessed = 0;

    for (const warehouse of warehouses) {
      await this.reassessWarehouse(warehouse.id, company, windowStart);
      warehousesProcessed++;
    }
    return { warehousesProcessed };
  }

  private async reassessWarehouse(warehouseId: string, company: { abcClassAPercent: any; abcClassBPercent: any; abcClassCPercent: any }, windowStart: Date) {
    // In-scope SKUs — anything that has EVER had a real movement in this
    // warehouse (a broader net than "currently has stock," since a SKU
    // that's fully depleted right now is still worth classifying for the
    // next time it's received). A SKU with zero presence here at all is
    // simply not this warehouse's concern.
    const skuIds = await this.prisma.stockMovement.findMany({ where: { warehouseId }, select: { skuId: true }, distinct: ['skuId'] });
    if (skuIds.length === 0) return;

    const skus = await this.prisma.sku.findMany({ where: { id: { in: skuIds.map((s) => s.skuId) } }, select: { id: true, categoryId: true } });
    const byCategory = new Map<string, string[]>();
    for (const sku of skus) {
      if (!byCategory.has(sku.categoryId)) byCategory.set(sku.categoryId, []);
      byCategory.get(sku.categoryId)!.push(sku.id);
    }

    // One query for real trailing-window DISPATCH totals (grouped, not
    // per-SKU) — DISPATCH is stored as a negative signed quantity per
    // StockMovement's own convention, so the magnitude is what ranking
    // cares about.
    const dispatchSums = await this.prisma.stockMovement.groupBy({
      by: ['skuId'],
      where: { warehouseId, movementType: 'DISPATCH', createdAt: { gte: windowStart } },
      _sum: { quantity: true },
    });
    const dispatchBySku = new Map(dispatchSums.map((d) => [d.skuId, Math.abs(Number(d._sum.quantity || 0))]));

    // Historical bootstrap seed rows in the same window (2026-09-06 — see
    // HistoricalDispatchSeed's own schema comment for why this exists
    // separately from the real ledger rather than faking backdated
    // movements with an invented location).
    const seedSums = await this.prisma.historicalDispatchSeed.groupBy({
      by: ['skuId'],
      where: { warehouseId, month: { gte: windowStart } },
      _sum: { quantity: true },
    });
    const seedBySku = new Map(seedSums.map((s) => [s.skuId, Number(s._sum.quantity || 0)]));

    // "Has this SKU existed in this warehouse for the FULL window" — the
    // earliest of its first real movement (any type — presence, not just
    // dispatch) or its earliest historical seed month. A SKU still short
    // of the full window is left alone entirely (no row written/changed)
    // rather than unfairly flagged dead before it's had a real chance to
    // move — confirmed reasoning, not yet re-checked with the client in
    // these exact words, but matches "3 months + no sales" as the trigger,
    // which only makes sense once 3 real months have actually passed.
    const firstMovements = await this.prisma.stockMovement.groupBy({ by: ['skuId'], where: { warehouseId }, _min: { createdAt: true } });
    const firstMovementBySku = new Map(firstMovements.map((f) => [f.skuId, f._min.createdAt]));
    const firstSeeds = await this.prisma.historicalDispatchSeed.groupBy({ by: ['skuId'], where: { warehouseId }, _min: { month: true } });
    const firstSeedBySku = new Map(firstSeeds.map((f) => [f.skuId, f._min.month]));

    const hasFullWindowHistory = (skuId: string): boolean => {
      const dates = [firstMovementBySku.get(skuId), firstSeedBySku.get(skuId)].filter((d): d is Date => !!d);
      if (dates.length === 0) return false;
      const earliest = new Date(Math.min(...dates.map((d) => d.getTime())));
      return earliest <= windowStart;
    };

    const aPct = Number(company.abcClassAPercent);
    const bPct = Number(company.abcClassBPercent);

    for (const [, categorySkuIds] of byCategory) {
      const results = categorySkuIds.map((skuId) => ({
        skuId,
        qty: (dispatchBySku.get(skuId) || 0) + (seedBySku.get(skuId) || 0),
      }));

      const active = results.filter((r) => r.qty > 0);
      // Zero-qty SKUs only become D once they've genuinely had the full
      // window to prove themselves — a SKU too new to judge is skipped
      // entirely (see hasFullWindowHistory above).
      const dead = results.filter((r) => r.qty === 0 && hasFullWindowHistory(r.skuId));

      if (active.length > 0) {
        active.sort((a, b) => b.qty - a.qty);
        const totalActiveQty = active.reduce((s, r) => s + r.qty, 0);
        // Classified by cumulative % BEFORE adding this item, not after —
        // deliberately, so the single highest-volume SKU in a category
        // always lands in A regardless of how large its own share is (a
        // naive "cumulative after" check can otherwise push a single
        // dominant item straight past both cutoffs into C, which is
        // backwards from what "A = top movers" is supposed to mean). Not
        // yet re-confirmed with the client in these exact terms — flagged
        // as a real implementation judgment call, not an assumed-obvious
        // default.
        let cumulativeBefore = 0;
        for (const r of active) {
          const pctBefore = (cumulativeBefore / totalActiveQty) * 100;
          const cls = pctBefore < aPct ? 'A' : pctBefore < aPct + bPct ? 'B' : 'C';
          cumulativeBefore += r.qty;
          await this.upsertClass(r.skuId, warehouseId, cls, r.qty);
        }
      }
      for (const r of dead) {
        await this.upsertClass(r.skuId, warehouseId, 'D', 0);
      }
    }
  }

  private async upsertClass(skuId: string, warehouseId: string, abcClass: string, dispatchedQty: number) {
    await this.prisma.skuWarehouseClass.upsert({
      where: { skuId_warehouseId: { skuId, warehouseId } },
      update: { abcClass, dispatchedQty, computedAt: new Date() },
      create: { skuId, warehouseId, abcClass, dispatchedQty },
    });
  }

  // Manual "Run Now" — same computation the monthly cron runs, on demand
  // for the caller's own company. Useful both for real usability (a client
  // shouldn't have to wait for the 1st of the month to see this work) and
  // for verification.
  async runNow(user: any) {
    if (user.role === 'SUPER_ADMIN') throw new ForbiddenException('Super admin accounts have no single company to reassess.');
    const company = await this.prisma.company.findUnique({ where: { id: user.companyId } });
    if (!company?.abcReassessmentEnabled) {
      throw new BadRequestException('ABC reassessment is not enabled for this company — turn it on in Company Settings first.');
    }
    return this.reassessCompany(user.companyId);
  }

  // Current classification results — for the read-only results page.
  // Explicit warehouseId is checked against the caller's own accessible
  // warehouses before being trusted, same pattern this codebase already
  // uses everywhere else a scoped role could otherwise pass someone else's
  // warehouse id (YardService.tracker(), Vehicle/DriverService, etc.).
  async current(user: any, warehouseId?: string) {
    if (warehouseId && WAREHOUSE_SCOPED_ROLES.includes(user.role)) {
      const ids = await ownWarehouseIds(this.prisma, user.userId);
      if (!ids.includes(warehouseId)) throw new ForbiddenException('You do not have access to this warehouse.');
    }
    const where: any = { warehouse: { ...companyFilter(user) } };
    if (warehouseId) where.warehouseId = warehouseId;
    else if (WAREHOUSE_SCOPED_ROLES.includes(user.role)) {
      const ids = await ownWarehouseIds(this.prisma, user.userId);
      where.warehouseId = { in: ids };
    }

    const rows = await this.prisma.skuWarehouseClass.findMany({
      where,
      include: { sku: { select: { code: true, description: true, abcClass: true, category: { select: { name: true } } } }, warehouse: { select: { code: true, name: true } } },
      orderBy: [{ warehouse: { code: 'asc' } }, { sku: { category: { name: 'asc' } } }, { dispatchedQty: 'desc' }],
    });

    return rows.map((r) => ({
      skuCode: r.sku.code,
      skuDescription: r.sku.description,
      categoryName: r.sku.category?.name ?? null,
      warehouseCode: r.warehouse.code,
      warehouseId: r.warehouseId,
      computedClass: r.abcClass,
      manualClass: r.sku.abcClass,
      dispatchedQty: r.dispatchedQty,
      computedAt: r.computedAt,
    }));
  }

  // Historical dispatch bootstrap import (2026-09-06) — "ill upload temp
  // data file for it if needed." One row per SKU × Warehouse × Month —
  // deliberately NOT disguised as fake backdated StockMovement rows (see
  // HistoricalDispatchSeed's own schema comment for why). Same per-row
  // success/error results shape as every other bulk import in this
  // codebase (SKU/Warehouse/Customer/Location/Inbound Order).
  async importHistoricalDispatch(rows: any[], user: any) {
    const results: { row: number; skuCode: string; warehouseCode: string; status: 'success' | 'error'; errors?: string[] }[] = [];
    let successCount = 0;

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const skuCode = r['SKU Code'] ? String(r['SKU Code']).trim() : '';
      const warehouseCode = r['Warehouse Code'] ? String(r['Warehouse Code']).trim() : '';
      const errors: string[] = [];

      if (!skuCode) errors.push('SKU Code is required.');
      if (!warehouseCode) errors.push('Warehouse Code is required.');
      const qty = Number(r['Quantity']);
      if (!r['Quantity'] || isNaN(qty) || qty < 0) errors.push('Quantity must be a non-negative number.');

      // "Month" accepts either a real Excel date/date-string or a plain
      // "YYYY-MM" string — normalized to the 1st of that month either way,
      // since a historical total only ever honestly claims to know the
      // month, never a specific day.
      let month: Date | null = null;
      const rawMonth = r['Month'];
      if (!rawMonth) {
        errors.push('Month is required (e.g. "2026-06" or a date within the month).');
      } else {
        const asDate = rawMonth instanceof Date ? rawMonth : new Date(rawMonth);
        if (isNaN(asDate.getTime())) errors.push(`"${rawMonth}" isn't a recognizable month/date.`);
        else month = new Date(asDate.getFullYear(), asDate.getMonth(), 1);
      }

      if (errors.length > 0) {
        results.push({ row: i + 2, skuCode, warehouseCode, status: 'error', errors });
        continue;
      }

      const sku = await this.prisma.sku.findFirst({ where: { companyId: user.companyId, code: skuCode } });
      if (!sku) {
        results.push({ row: i + 2, skuCode, warehouseCode, status: 'error', errors: [`SKU Code "${skuCode}" not found.`] });
        continue;
      }
      const warehouse = await this.prisma.warehouse.findFirst({ where: { companyId: user.companyId, code: warehouseCode } });
      if (!warehouse) {
        results.push({ row: i + 2, skuCode, warehouseCode, status: 'error', errors: [`Warehouse Code "${warehouseCode}" not found.`] });
        continue;
      }
      if (WAREHOUSE_SCOPED_ROLES.includes(user.role)) {
        const ids = await ownWarehouseIds(this.prisma, user.userId);
        if (!ids.includes(warehouse.id)) {
          results.push({ row: i + 2, skuCode, warehouseCode, status: 'error', errors: [`You do not have access to warehouse "${warehouseCode}".`] });
          continue;
        }
      }

      await this.prisma.historicalDispatchSeed.upsert({
        where: { skuId_warehouseId_month: { skuId: sku.id, warehouseId: warehouse.id, month: month! } },
        update: { quantity: qty, importedById: user.userId, importedAt: new Date() },
        create: { skuId: sku.id, warehouseId: warehouse.id, month: month!, quantity: qty, importedById: user.userId },
      });
      successCount++;
      results.push({ row: i + 2, skuCode, warehouseCode, status: 'success' });
    }

    return { totalRows: rows.length, successCount, failCount: rows.length - successCount, results };
  }
}
