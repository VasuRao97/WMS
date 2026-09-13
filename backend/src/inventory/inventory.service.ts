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
  WAREHOUSE_SCOPED_ROLES,
} from '../common/tenant.util';
import { displayCode } from '../common/rack-name.util';

// Human-readable Excel labels for the ledger export below — Excel-only
// (the frontend Ledger tab uses its own display-side label map, same
// "backend validation labels vs. frontend display labels" split this
// codebase already has for e.g. STORAGE_TYPE_LABELS vs. STORAGE_TYPE_OPTIONS)
// since an exported file leaves the app and can't rely on frontend code.
const MOVEMENT_TYPE_LABELS: Record<string, string> = {
  RECEIPT: 'Receipt',
  PUTAWAY_OUT: 'Putaway Out',
  PUTAWAY_IN: 'Putaway In',
  PICK: 'Pick',
  DISPATCH: 'Dispatch',
  RETURN_IN: 'Return In',
  ADJUSTMENT: 'Adjustment',
  PICK_FACE_REPLENISH_OUT: 'Pick Face Replenish Out',
  PICK_FACE_REPLENISH_IN: 'Pick Face Replenish In',
};

// Inventory — the first real "what's on hand" screen this app has ever had
// (2026-09-13). Every other page derives on-hand from the StockMovement
// ledger already (same "always derive, never store a counter" philosophy
// this whole codebase follows); this module is the first one whose entire
// purpose IS that derivation, at two granularities the client asked for
// directly, sample sheet in hand: line-item (one row per bin/pallet) and a
// SKU-level rollup. Scoped per warehouse, confirmed directly — matches
// every other page (Insights/Analytics/Storage Utilization all are), and
// ABC/FMS classification itself is already warehouse-scoped
// (SkuWarehouseClass), so a company-wide rollup would have nowhere honest
// to source a single ABC/FMS value from anyway.
@Injectable()
export class InventoryService {
  constructor(private prisma: PrismaService) {}

  private async assertWarehouseAccess(warehouseId: string, user: AuthUser) {
    if (!warehouseId) throw new BadRequestException('warehouseId is required.');
    const warehouse = await this.prisma.warehouse.findUnique({
      where: { id: warehouseId },
    });
    if (!warehouse) throw new NotFoundException('Warehouse not found.');
    if (user.role !== 'SUPER_ADMIN' && warehouse.companyId !== user.companyId) {
      throw new ForbiddenException('You do not have access to this warehouse.');
    }
    // An explicit warehouseId is checked against the caller's own accessible
    // set before being trusted — same real bug class YardService.tracker()/
    // Vehicle/DriverService/InsightsService already had to fix once,
    // avoided proactively here.
    if (WAREHOUSE_SCOPED_ROLES.includes(user.role)) {
      const ids = await ownWarehouseIds(this.prisma, user.userId);
      if (!ids.includes(warehouseId))
        throw new ForbiddenException(
          'You do not have access to this warehouse.',
        );
    }
  }

  // Shared by both views below — every StockMovement for this warehouse's
  // locations, plus everything needed to build a line-item row from it.
  // One query, not two, since the SKU-summary view is just this same data
  // rolled up one level further, not a separate source.
  private async loadRawRows(warehouseId: string) {
    const movements = await this.prisma.stockMovement.findMany({
      where: { warehouseId },
      select: {
        locationId: true,
        skuId: true,
        quantity: true,
        receivedDate: true,
        createdAt: true,
        palletLoad: { select: { pallet: { select: { code: true } } } },
      },
      orderBy: { createdAt: 'asc' },
    });
    if (movements.length === 0)
      return {
        locationById: new Map(),
        skuById: new Map(),
        classBySkuId: new Map(),
        balances: [],
      };

    // balance + last-touched + a representative receivedDate + a
    // representative pallet code, per (location, sku) — accumulated in one
    // pass over the ledger, same convention as suggestBin()'s own
    // balanceByLocSku. "Representative" receivedDate/pallet is whichever
    // the MOST RECENT positive (stock-in) movement carried — a bin can in
    // theory receive from more than one pallet/date over its life (a
    // same-SKU top-up), and the latest one is the more useful "how old is
    // what's here now" signal than the very first.
    type Row = {
      locationId: string;
      skuId: string;
      qty: number;
      lastTouchedAt: Date;
      receivedDate: Date | null;
      palletCode: string | null;
    };
    const byKey = new Map<string, Row>();
    for (const m of movements) {
      const key = `${m.locationId}|${m.skuId}`;
      const qty = Number(m.quantity);
      let row = byKey.get(key);
      if (!row) {
        row = {
          locationId: m.locationId,
          skuId: m.skuId,
          qty: 0,
          lastTouchedAt: m.createdAt,
          receivedDate: null,
          palletCode: null,
        };
        byKey.set(key, row);
      }
      row.qty += qty;
      row.lastTouchedAt = m.createdAt; // rows are in ascending createdAt order, so the last write wins
      if (qty > 0) {
        row.receivedDate = m.receivedDate ?? row.receivedDate;
        row.palletCode = m.palletLoad?.pallet?.code ?? row.palletCode;
      }
    }
    const positiveRows = [...byKey.values()].filter((r) => r.qty > 0);

    const locationIds = [...new Set(positiveRows.map((r) => r.locationId))];
    const skuIds = [...new Set(positiveRows.map((r) => r.skuId))];
    const [locations, skus, warehouseClasses] = await Promise.all([
      this.prisma.location.findMany({
        where: { id: { in: locationIds } },
        select: {
          id: true,
          code: true,
          storageType: true,
          flankNumber: true,
          rack: true,
          level: true,
          depth: true,
        },
      }),
      this.prisma.sku.findMany({
        where: { id: { in: skuIds } },
        select: {
          id: true,
          code: true,
          description: true,
          abcClass: true,
          category: { select: { name: true } },
        },
      }),
      // Per-warehouse COMPUTED class (Topic 1's real trailing-dispatch-derived
      // result) takes priority over the manually-set/imported Sku.abcClass —
      // same override-when-known chain suggestBin() itself already uses.
      // Unclassified still defaults to C, matching that same convention.
      this.prisma.skuWarehouseClass.findMany({
        where: { warehouseId, skuId: { in: skuIds } },
        select: { skuId: true, abcClass: true, fmsClass: true },
      }),
    ]);

    const locationById = new Map(locations.map((l) => [l.id, l]));
    const skuById = new Map(skus.map((s) => [s.id, s]));
    const classBySkuId = new Map(warehouseClasses.map((c) => [c.skuId, c]));

    return { locationById, skuById, classBySkuId, balances: positiveRows };
  }

  private classesFor(
    sku: { abcClass: string | null },
    classBySkuId: Map<
      string,
      { abcClass: string | null; fmsClass: string | null }
    >,
    skuId: string,
  ) {
    const computed = classBySkuId.get(skuId);
    const abcClass = (computed?.abcClass || sku.abcClass || 'C').toUpperCase();
    const fmsClass = computed?.fmsClass?.toUpperCase() || null;
    return { abcClass, fmsClass };
  }

  // Line-item view — one row per (bin, SKU) currently holding real stock.
  // "SL" (serial number) is left to the frontend to number rows as
  // displayed, same as every other list page in this app.
  async lineItems(user: AuthUser, warehouseId: string) {
    await this.assertWarehouseAccess(warehouseId, user);
    const { locationById, skuById, classBySkuId, balances } =
      await this.loadRawRows(warehouseId);

    const now = Date.now();
    const rows = balances
      .map((r) => {
        const location = locationById.get(r.locationId);
        const sku = skuById.get(r.skuId);
        if (!location || !sku) return null; // defensive — shouldn't happen, both were just fetched by these exact ids
        const { abcClass, fmsClass } = this.classesFor(
          sku,
          classBySkuId,
          r.skuId,
        );
        const agingDays = r.receivedDate
          ? Math.floor((now - r.receivedDate.getTime()) / 86400000)
          : null;
        return {
          skuCode: sku.code,
          description: sku.description,
          quantity: r.qty,
          agingDays,
          storageType: location.storageType,
          palletCode: r.palletCode,
          binCode: displayCode(location),
          category: sku.category?.name || null,
          lastTouchedAt: r.lastTouchedAt,
          abcClass,
          fmsClass,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    // Deterministic default order — SKU code, then bin — same "stable
    // processing order" convention several other reports in this codebase
    // already use (e.g. Pick Face's own sortedLocations).
    rows.sort(
      (a, b) =>
        a.skuCode.localeCompare(b.skuCode) ||
        a.binCode.localeCompare(b.binCode),
    );
    return rows;
  }

  // SKU-level summary — one row per SKU, rolled up across every bin/pallet
  // in this warehouse. "aging" here is the OLDEST receivedDate found across
  // all of this SKU's current stock — the more operationally meaningful
  // signal at a rollup level (worst case, not an average that could hide a
  // genuinely stale lot sitting behind newer ones) — flagged as a judgment
  // call, not explicitly confirmed in these exact words.
  async skuSummary(user: AuthUser, warehouseId: string) {
    await this.assertWarehouseAccess(warehouseId, user);
    const { skuById, classBySkuId, balances } =
      await this.loadRawRows(warehouseId);

    type Agg = {
      qty: number;
      oldestReceivedDate: Date | null;
      lastTouchedAt: Date;
      binCount: number;
    };
    const bySku = new Map<string, Agg>();
    for (const r of balances) {
      let agg = bySku.get(r.skuId);
      if (!agg) {
        agg = {
          qty: 0,
          oldestReceivedDate: null,
          lastTouchedAt: r.lastTouchedAt,
          binCount: 0,
        };
        bySku.set(r.skuId, agg);
      }
      agg.qty += r.qty;
      agg.binCount += 1;
      if (
        r.receivedDate &&
        (!agg.oldestReceivedDate || r.receivedDate < agg.oldestReceivedDate)
      )
        agg.oldestReceivedDate = r.receivedDate;
      if (r.lastTouchedAt > agg.lastTouchedAt)
        agg.lastTouchedAt = r.lastTouchedAt;
    }

    const now = Date.now();
    const rows = [...bySku.entries()]
      .map(([skuId, agg]) => {
        const sku = skuById.get(skuId);
        if (!sku) return null;
        const { abcClass, fmsClass } = this.classesFor(
          sku,
          classBySkuId,
          skuId,
        );
        const agingDays = agg.oldestReceivedDate
          ? Math.floor((now - agg.oldestReceivedDate.getTime()) / 86400000)
          : null;
        return {
          skuCode: sku.code,
          description: sku.description,
          quantity: agg.qty,
          agingDays,
          category: sku.category?.name || null,
          binCount: agg.binCount,
          lastTouchedAt: agg.lastTouchedAt,
          abcClass,
          fmsClass,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    rows.sort((a, b) => a.skuCode.localeCompare(b.skuCode));
    return rows;
  }

  // Transaction-level ledger — every individual inward/outward StockMovement
  // row, unsummed (2026-09-13 follow-on ask, right after Line Items/SKU
  // Summary shipped — see [[wms-inventory-design]]). A genuinely different
  // report from the two balance-snapshot views above: raw rows only, no
  // running balance (confirmed directly, not assumed).
  //
  // warehouseId is OPTIONAL here — unlike lineItems/skuSummary above, which
  // always require one (ABC/FMS has nowhere honest to source a single value
  // from company-wide). Omitting it means a company-wide dump, but only for
  // COMPANY_ADMIN/SUPER_ADMIN (confirmed directly) — same convention as
  // AnalyticsService.operatorProductivity's own optional warehouseId. A
  // WAREHOUSE_SCOPED_ROLES caller (Manager/Supervisor) must always narrow to
  // one of their own warehouses, same as everywhere else in this codebase.
  private async ledgerWhere(
    user: AuthUser,
    warehouseId?: string,
    from?: string,
    to?: string,
  ) {
    if (warehouseId) {
      await this.assertWarehouseAccess(warehouseId, user);
    } else if (WAREHOUSE_SCOPED_ROLES.includes(user.role)) {
      throw new BadRequestException('Select a warehouse.');
    }
    const where: any = warehouseId
      ? { warehouseId }
      : { warehouse: companyFilter(user) };
    // Date range filters on createdAt — the actual transaction timestamp,
    // not receivedDate (which is carried forward from the original receipt
    // and doesn't move with the ledger). "to" is inclusive of the whole day,
    // so a single day is just from === to. Confirmed directly: no forced
    // default range — omitting both means the entire history.
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = new Date(`${from}T00:00:00.000Z`);
      if (to) where.createdAt.lte = new Date(`${to}T23:59:59.999Z`);
    }
    return where;
  }

  // Movement types that come as a genuine OUT+IN pair sharing one
  // referenceId (a single Putaway/Pick-Face trip, written together in one
  // transaction at trip completion — see PutawayTasksService/
  // PickFaceTasksService) — keyed both directions so either leg can look up
  // its partner's type. 2026-09-13, "From/To Location" follow-on ask.
  private static readonly PAIRED_PARTNER_TYPE: Record<string, string> = {
    PUTAWAY_OUT: 'PUTAWAY_IN',
    PUTAWAY_IN: 'PUTAWAY_OUT',
    PICK_FACE_REPLENISH_OUT: 'PICK_FACE_REPLENISH_IN',
    PICK_FACE_REPLENISH_IN: 'PICK_FACE_REPLENISH_OUT',
  };

  // Shared by the JSON (Ledger tab) and Excel (export) paths below — one
  // query, formatted two different ways, same "derive once" convention
  // loadRawRows() above already follows.
  private async loadLedgerRows(
    user: AuthUser,
    warehouseId?: string,
    from?: string,
    to?: string,
  ) {
    const where = await this.ledgerWhere(user, warehouseId, from, to);
    const movements = await this.prisma.stockMovement.findMany({
      where,
      select: {
        createdAt: true,
        movementType: true,
        quantity: true,
        referenceType: true,
        referenceId: true,
        notes: true,
        receivedDate: true,
        warehouse: { select: { code: true } },
        location: {
          select: {
            code: true,
            storageType: true,
            flankNumber: true,
            rack: true,
            level: true,
            depth: true,
          },
        },
        sku: { select: { code: true, description: true } },
        createdBy: { select: { name: true } },
        palletLoad: { select: { pallet: { select: { code: true } } } },
      },
      orderBy: { createdAt: 'asc' },
    });

    // Paired trips (Putaway/Pick-Face replenish) share one referenceId —
    // this indexes each already-fetched row's own bin code by
    // (referenceType, referenceId, movementType) so its partner leg can look
    // it up without a second query. Only paired types are ever inserted.
    const binByReference = new Map<string, Map<string, string>>();
    for (const m of movements) {
      if (!(m.movementType in InventoryService.PAIRED_PARTNER_TYPE)) continue;
      const key = `${m.referenceType}|${m.referenceId}`;
      if (!binByReference.has(key)) binByReference.set(key, new Map());
      binByReference.get(key)!.set(m.movementType, displayCode(m.location));
    }

    return movements.map((m) => {
      const ownBinCode = displayCode(m.location);
      const partnerType = InventoryService.PAIRED_PARTNER_TYPE[m.movementType];
      let fromLocation: string | null = null;
      let toLocation: string | null = null;
      if (partnerType) {
        // A real transfer — both legs get both endpoints (the OUT leg's own
        // bin IS the "from"; its partner IN leg's bin is the "to," and vice
        // versa), confirmed directly rather than collapsing the pair into
        // one row (keeps the "raw StockMovement row" grain unchanged).
        const partnerBinCode =
          binByReference
            .get(`${m.referenceType}|${m.referenceId}`)
            ?.get(partnerType) ?? null;
        const isOutLeg = m.movementType.endsWith('_OUT');
        fromLocation = isOutLeg ? ownBinCode : partnerBinCode;
        toLocation = isOutLeg ? partnerBinCode : ownBinCode;
      } else {
        // Every other movement type (Receipt, Pick, Dispatch, Return In,
        // Adjustment) has no tracked partner location — its own bin fills
        // whichever side the signed quantity implies (stock arriving here
        // vs. leaving here), same convention as the quantity column itself.
        // Adjustment gets this too (by its own sign) rather than showing
        // neither — its location would otherwise vanish from the ledger
        // entirely, a real regression from today's single "Bin/Location"
        // column this replaces.
        if (Number(m.quantity) >= 0) toLocation = ownBinCode;
        else fromLocation = ownBinCode;
      }
      return {
        createdAt: m.createdAt,
        movementType: m.movementType,
        quantity: Number(m.quantity),
        referenceType: m.referenceType,
        referenceId: m.referenceId,
        notes: m.notes,
        receivedDate: m.receivedDate,
        warehouseCode: m.warehouse.code,
        skuCode: m.sku.code,
        skuDescription: m.sku.description,
        fromLocation,
        toLocation,
        storageType: m.location.storageType,
        palletCode: m.palletLoad?.pallet?.code ?? null,
        createdByName: m.createdBy?.name || '',
      };
    });
  }

  // JSON for the frontend's Ledger tab — raw movementType/etc left
  // unformatted, same convention as lineItems/skuSummary above (the
  // frontend applies its own display-side label maps).
  async ledger(
    user: AuthUser,
    warehouseId?: string,
    from?: string,
    to?: string,
  ) {
    return this.loadLedgerRows(user, warehouseId, from, to);
  }

  // Excel export of the exact same rows — human-readable movement-type
  // labels baked in server-side, same convention as
  // GateEntriesService.exportRows (the file leaves the app, so it can't
  // depend on the frontend's own label map).
  async exportLedgerRows(
    user: AuthUser,
    warehouseId?: string,
    from?: string,
    to?: string,
  ) {
    const rows = await this.loadLedgerRows(user, warehouseId, from, to);
    return rows.map((r) => ({
      'Date/Time': r.createdAt.toISOString(),
      Warehouse: r.warehouseCode,
      'SKU Code': r.skuCode,
      'Material Desc': r.skuDescription,
      'Movement Type': MOVEMENT_TYPE_LABELS[r.movementType] || r.movementType,
      Quantity: r.quantity,
      'From Location': r.fromLocation || '',
      'To Location': r.toLocation || '',
      'Pallet No': r.palletCode || '',
      'Reference Type': r.referenceType,
      'Reference ID': r.referenceId,
      'Received Date': r.receivedDate ? r.receivedDate.toISOString() : '',
      'Created By': r.createdByName,
      Notes: r.notes || '',
    }));
  }
}
