import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PutawayTasksService } from '../putaway/putaway-tasks.service';

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
const SKU_POOL_SIZE = 12;
const MAX_UNIT_COUNT = 200;

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

  // Finds or creates this company's one sandbox warehouse, its default SPR
  // layout, and its Simulation category + WarehouseStorageType eligibility
  // row — all lazily, on first use, so "click Run" works with zero manual
  // setup. Idempotent: calling this again once everything already exists
  // just returns the existing warehouse untouched (a user who's since
  // customized the sandbox's layout via the normal Locations page keeps
  // whatever they built).
  // Written to be safe under concurrent calls (React's StrictMode double-
  // invokes effects in dev, and nothing stops two browser tabs hitting this
  // at once either) — a real race was caught during verification: two
  // near-simultaneous first-ever calls both saw "no sandbox yet" and both
  // tried to create one, and the loser got a raw unique-constraint 500
  // instead of just quietly finding what the winner had already made.
  // `upsert`/`skipDuplicates` make "already exists" a normal, silent
  // outcome instead of an error to catch.
  async ensureSandbox(user: any) {
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

    const existingStorageType = await this.prisma.warehouseStorageType.findFirst({
      where: { warehouseId: warehouse.id, storageType: 'SPR', categoryId: category.id },
    });
    if (!existingStorageType) {
      try {
        await this.prisma.warehouseStorageType.create({
          data: { warehouseId: warehouse.id, storageType: 'SPR', categoryId: category.id, palletPositions: 1000 },
        });
      } catch {
        // A concurrent call already created the same row between our check
        // and this create — the row existing is all that matters here, not
        // which request made it.
      }
    }

    const existingLocations = await this.prisma.location.count({ where: { warehouseId: warehouse.id } });
    if (existingLocations === 0) {
      const rows: any[] = [];
      for (let aisle = 1; aisle <= DEFAULT_AISLES; aisle++) {
        for (let rack = 1; rack <= DEFAULT_RACKS; rack++) {
          for (let level = 1; level <= DEFAULT_LEVELS; level++) {
            const aisleStr = String(aisle);
            const rackStr = String(rack).padStart(2, '0');
            rows.push({
              warehouseId: warehouse.id,
              code: `${aisleStr}-R${rackStr}-L${String(level).padStart(2, '0')}-B1`,
              zoneType: 'ACTUAL_STORAGE',
              storageType: 'SPR',
              categoryId: category.id,
              aisle: aisleStr,
              rack: rackStr,
              level: String(level),
              bin: '1',
              flankNumber: aisle, // one flank per aisle — a simple single-sided default layout is enough to watch the algorithm work
            });
          }
        }
      }
      await this.prisma.location.createMany({ data: rows, skipDuplicates: true });
    }

    return warehouse;
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
  async runPutawaySimulation(user: any, unitCountRaw: number): Promise<{ warehouseId: string; steps: SimStep[] }> {
    const unitCount = Math.max(1, Math.min(MAX_UNIT_COUNT, Math.floor(Number(unitCountRaw) || 0) || 1));
    const warehouse = await this.ensureSandbox(user);
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
        rackName = location!.flankNumber != null && location!.rack && location!.level ? `R${location!.flankNumber}-${location!.rack}-L${location!.level}` : locationCode;
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
