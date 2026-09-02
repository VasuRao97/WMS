import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { companyFilter, ownWarehouseIds, WAREHOUSE_SCOPED_ROLES } from '../common/tenant.util';
import { PutawayTasksService } from '../putaway/putaway-tasks.service';
import * as bwipjs from 'bwip-js';
import { ZipArchive } from 'archiver';

// Pallet consolidation ("marrying" loose cases onto a pallet before Putaway)
// — 2026-09-01, see [[wms-putaway-design]] in memory for the full design
// conversation this comes out of, and schema.prisma's own comment above
// `model Pallet` for the NOT-the-same-thing-as-SkuStorageUnit.unitType's
// "PALLET" value disambiguation.
//
// Two real physical assets, mirroring Vehicle/VehicleGateEntry's own shape:
// Pallet (registered master, warehouse-scoped, reusable) and PalletLoad (one
// row per load cycle, single-SKU, quantity always derived from the ledger).
// This service owns Pallet's own master CRUD/generator/labels (same shape
// as LocationsService) PLUS the "marrying" mechanism that GateEntriesService.
// scan()/InboundReceiptsService.approveScan() call into directly — the
// client's own explicit choice (2026-09-01) was to fold marrying into the
// existing scan rather than add a second scanning layer: "we are just
// adding one more scanning layer from which we would loose time."

const MAX_GENERATE_BATCH = 2000;

// Same range-expansion helper as LocationsService.expandRange() — kept as
// its own small copy rather than a cross-module import, since Pallet's
// generator is genuinely simpler (one field, no aisle/rack/level grouping)
// and importing LocationsService wholesale for one helper would be a bigger
// coupling than duplicating ~15 lines.
function expandRange(input: any): string[] {
  const str = String(input ?? '').trim();
  if (!str) return [];
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
export class PalletsService {
  constructor(
    private prisma: PrismaService,
    private putawayTasks: PutawayTasksService,
  ) {}

  private async assertWarehouseAccess(warehouseId: string, user: any) {
    const warehouse = await this.prisma.warehouse.findUnique({ where: { id: warehouseId } });
    if (!warehouse || (user.role !== 'SUPER_ADMIN' && warehouse.companyId !== user.companyId)) {
      throw new BadRequestException('Warehouse not found.');
    }
    if (WAREHOUSE_SCOPED_ROLES.includes(user.role)) {
      const ids = await ownWarehouseIds(this.prisma, user.userId);
      if (!ids.includes(warehouseId)) throw new ForbiddenException('You do not have access to this warehouse.');
    }
    return warehouse;
  }

  // ------------------------------------------------------------
  // Master CRUD — same shape as LocationsService
  // ------------------------------------------------------------

  async findAll(user: any, warehouseId?: string, status?: string) {
    const where: any = { warehouse: { ...companyFilter(user) } };
    if (WAREHOUSE_SCOPED_ROLES.includes(user.role)) {
      where.warehouseId = { in: await ownWarehouseIds(this.prisma, user.userId) };
    }
    if (warehouseId) where.warehouseId = warehouseId;
    if (status) where.status = status;
    return this.prisma.pallet.findMany({
      where,
      include: { loads: { where: { status: 'OPEN' }, include: { sku: { select: { id: true, code: true, description: true } } } } },
      orderBy: { code: 'asc' },
    });
  }

  // Loadable pallets for the Receiving modal's picker (2026-09-01) —
  // AVAILABLE ones (start a fresh load) plus any IN_USE pallet that still
  // has an OPEN load of ANY SKU (resume/continue scanning onto it).
  // Deliberately NOT pre-filtered by SKU — the SKU isn't known until a
  // barcode actually scans, so staff pick the physical pallet in front of
  // them by code/current-contents instead; a scan that doesn't match the
  // picked pallet's existing single-SKU load is rejected by
  // resolveLoadForScan() with a clear message, same as picking the wrong
  // physical pallet in real life. An optional skuId narrows the list
  // anyway, for a future caller that DOES know the SKU up front.
  async findLoadable(user: any, warehouseId: string, skuId?: string) {
    await this.assertWarehouseAccess(warehouseId, user);
    const pallets = await this.prisma.pallet.findMany({
      where: { warehouseId, isActive: true, OR: [{ status: 'AVAILABLE' }, { loads: { some: { status: 'OPEN', ...(skuId ? { skuId } : {}) } } }] },
      include: { loads: { where: { status: 'OPEN' }, include: { sku: { select: { id: true, code: true } } } } },
      orderBy: { code: 'asc' },
    });
    return pallets.map((p) => {
      const openLoad = p.loads[0];
      return {
        id: p.id,
        code: p.code,
        status: p.status,
        activeLoad: openLoad ? { id: openLoad.id, skuId: openLoad.sku.id, skuCode: openLoad.sku.code } : null,
      };
    });
  }

  async generate(data: any, user: any) {
    const warehouseId = data?.warehouseId;
    if (!warehouseId) throw new BadRequestException('A warehouse is required.');
    await this.assertWarehouseAccess(warehouseId, user);

    const prefix = data?.codePrefix ? String(data.codePrefix).trim().toUpperCase() : 'PLT';
    const numbers = expandRange(data?.range);
    if (numbers.length === 0) throw new BadRequestException('A number or range is required (e.g. "0001-0100").');
    if (numbers.length > MAX_GENERATE_BATCH) {
      throw new BadRequestException(`This range would generate ${numbers.length} pallets in one batch — narrow it down (max ${MAX_GENERATE_BATCH} per generation).`);
    }

    const results: { id?: string; code: string; status: 'success' | 'error'; errors?: string[] }[] = [];
    const codesSeen = new Set<string>();
    for (const n of numbers) {
      const code = `${prefix}-${n}`;
      if (codesSeen.has(code)) {
        results.push({ code, status: 'error', errors: ['Duplicate within this generation batch.'] });
        continue;
      }
      codesSeen.add(code);
      const existing = await this.prisma.pallet.findUnique({ where: { warehouseId_code: { warehouseId, code } } });
      if (existing) {
        results.push({ code, status: 'error', errors: ['A pallet with this code already exists in this warehouse.'] });
        continue;
      }
      const created = await this.prisma.pallet.create({ data: { warehouseId, code } });
      results.push({ id: created.id, code, status: 'success' });
    }
    return results;
  }

  private async assertAccess(id: string, user: any) {
    const pallet = await this.prisma.pallet.findUnique({ where: { id }, include: { warehouse: true } });
    if (!pallet) throw new NotFoundException('Pallet not found.');
    if (user.role !== 'SUPER_ADMIN' && pallet.warehouse.companyId !== user.companyId) throw new ForbiddenException('You do not have access to this pallet.');
    if (WAREHOUSE_SCOPED_ROLES.includes(user.role)) {
      const ids = await ownWarehouseIds(this.prisma, user.userId);
      if (!ids.includes(pallet.warehouseId)) throw new ForbiddenException('You do not have access to this pallet.');
    }
    return pallet;
  }

  async deactivate(id: string, isActive: boolean, user: any) {
    await this.assertAccess(id, user);
    return this.prisma.pallet.update({ where: { id }, data: { isActive } });
  }

  async removeAll(user: any) {
    const pallets = await this.prisma.pallet.findMany({
      where: { warehouse: { ...companyFilter(user) } },
      select: { id: true, code: true, _count: { select: { loads: true } } },
    });
    const deletable = pallets.filter((p) => p._count.loads === 0).map((p) => p.id);
    const blocked = pallets.filter((p) => p._count.loads > 0).map((p) => p.code);
    if (deletable.length > 0) {
      await this.prisma.pallet.deleteMany({ where: { id: { in: deletable } } });
    }
    return { deletedCount: deletable.length, blockedCount: blocked.length, blockedCodes: blocked };
  }

  // ------------------------------------------------------------
  // Labels — identical mechanism to Location Labels (bwip-js + archiver),
  // one-time at registration per the design ("a real barcode goes on the
  // physical pallet once, at registration, never reprinted per load").
  // ------------------------------------------------------------

  async buildLabelsZip(palletIds: string[], user: any): Promise<Buffer> {
    if (!palletIds || palletIds.length === 0) throw new BadRequestException('No pallets given.');
    if (palletIds.length > MAX_GENERATE_BATCH) {
      throw new BadRequestException(`Too many pallets at once — narrow it down (max ${MAX_GENERATE_BATCH} per label batch).`);
    }
    const where: any = { id: { in: palletIds }, warehouse: { ...companyFilter(user) } };
    if (WAREHOUSE_SCOPED_ROLES.includes(user.role)) {
      where.warehouseId = { in: await ownWarehouseIds(this.prisma, user.userId) };
    }
    const pallets = await this.prisma.pallet.findMany({ where });
    if (pallets.length === 0) throw new BadRequestException('None of the given pallets were found, or you do not have access to them.');

    return new Promise((resolve, reject) => {
      const archive = new ZipArchive({ zlib: { level: 9 } });
      const chunks: Buffer[] = [];
      archive.on('data', (chunk: Buffer) => chunks.push(chunk));
      archive.on('error', reject);
      archive.on('end', () => resolve(Buffer.concat(chunks)));

      Promise.all(
        pallets.map(async (p) => {
          const png = await bwipjs.toBuffer({ bcid: 'code128', text: p.code, scale: 3, height: 12, includetext: true, textxalign: 'center' });
          archive.append(png, { name: `${p.code}.png` });
        }),
      )
        .then(() => archive.finalize())
        .catch(reject);
    });
  }

  // ------------------------------------------------------------
  // Marrying — the scan-time hook (2026-09-01)
  // ------------------------------------------------------------

  // Called from inside GateEntriesService.scan()'s / InboundReceiptsService.
  // approveScan()'s own transaction, right before the RECEIPT StockMovement
  // is created, so that movement can carry palletLoadId in the same insert
  // — "the scan IS the marrying action," confirmed 2026-09-01 rather than a
  // separate consolidation screen. Resolves (or opens) the OPEN PalletLoad
  // for this pallet, enforcing single-SKU-per-pallet.
  async resolveLoadForScan(tx: any, params: { warehouseId: string; skuId: string; palletId: string; receiptLineId: string }): Promise<string> {
    const { warehouseId, skuId, palletId, receiptLineId } = params;
    const pallet = await tx.pallet.findUnique({ where: { id: palletId } });
    if (!pallet || pallet.warehouseId !== warehouseId) throw new BadRequestException('Pallet not found in this warehouse.');
    if (!pallet.isActive) throw new BadRequestException(`Pallet "${pallet.code}" is inactive.`);

    let load = await tx.palletLoad.findFirst({ where: { palletId, status: 'OPEN' } });
    if (load) {
      if (load.skuId !== skuId) {
        const existingSku = await tx.sku.findUnique({ where: { id: load.skuId }, select: { code: true } });
        throw new BadRequestException(`Pallet "${pallet.code}" already has ${existingSku?.code ?? 'a different SKU'} loaded onto it — single-SKU pallets only.`);
      }
      return load.id;
    }

    if (pallet.status !== 'AVAILABLE') {
      throw new BadRequestException(`Pallet "${pallet.code}" is not available — it may already be in use, or awaiting Putaway.`);
    }
    load = await tx.palletLoad.create({ data: { palletId, skuId, receiptLineId } });
    await tx.pallet.update({ where: { id: palletId }, data: { status: 'IN_USE' } });
    return load.id;
  }

  // Called right after the caller writes the RECEIPT StockMovement carrying
  // this palletLoadId — checks whether the load has now hit its effective
  // max-cases cap (Sku.maxCasesPerPallet ?? Company.defaultMaxCasesPerPallet)
  // and auto-closes it if so. A load with no effective cap configured at
  // all (both unset) never auto-closes — only a manual short-close can end
  // it, per the design ("closed either by hitting a max-cases number... or
  // an operator's manual short-close").
  async maybeAutoCloseLoad(tx: any, loadId: string) {
    const load = await tx.palletLoad.findUnique({ where: { id: loadId }, include: { sku: { select: { maxCasesPerPallet: true, companyId: true } } } });
    if (!load || load.status !== 'OPEN') return;
    const company = await tx.company.findUnique({ where: { id: load.sku.companyId }, select: { defaultMaxCasesPerPallet: true } });
    const effectiveMax = load.sku.maxCasesPerPallet ?? company?.defaultMaxCasesPerPallet ?? null;
    if (effectiveMax == null) return;

    const agg = await tx.stockMovement.aggregate({ where: { palletLoadId: loadId }, _sum: { quantity: true } });
    const qty = Number(agg._sum.quantity || 0);
    if (qty >= Number(effectiveMax)) {
      await this.closeLoad(tx, loadId, 'CASES_FULL', null);
    }
  }

  private async closeLoad(tx: any, loadId: string, reason: string, closedById: string | null) {
    await tx.palletLoad.update({ where: { id: loadId }, data: { status: 'CLOSED', closeReason: reason, closedAt: new Date(), closedById: closedById ?? undefined } });
    await this.putawayTasks.createTaskForClosedPallet(tx, loadId);
  }

  // Manual short-close (2026-09-01) — "an operator's manual short-close
  // (that SKU's remaining quantity ran out first)." Any OPEN load with at
  // least some real quantity on it can be closed early; an empty load
  // (nothing ever scanned onto it) is closed too but produces no Putaway
  // task (createTaskForClosedPallet is a no-op on zero quantity) and simply
  // frees the pallet back to AVAILABLE.
  async manualShortClose(loadId: string, user: any) {
    const load = await this.prisma.palletLoad.findUnique({ where: { id: loadId }, include: { pallet: { include: { warehouse: true } } } });
    if (!load) throw new NotFoundException('Pallet load not found.');
    if (user.role !== 'SUPER_ADMIN' && load.pallet.warehouse.companyId !== user.companyId) throw new ForbiddenException('You do not have access to this pallet.');
    if (WAREHOUSE_SCOPED_ROLES.includes(user.role)) {
      const ids = await ownWarehouseIds(this.prisma, user.userId);
      if (!ids.includes(load.pallet.warehouseId)) throw new ForbiddenException('You do not have access to this pallet.');
    }
    if (load.status !== 'OPEN') throw new BadRequestException('This pallet load is already closed.');

    return this.prisma.$transaction(async (tx) => {
      await this.closeLoad(tx, loadId, 'MANUAL_SHORT_CLOSE', user.userId);
      // A pallet whose just-closed load turned out genuinely empty (short-
      // closed with nothing ever scanned onto it) frees back up immediately
      // — nothing for Putaway to do, no reason to keep it IN_USE.
      const agg = await tx.stockMovement.aggregate({ where: { palletLoadId: loadId }, _sum: { quantity: true } });
      if (Number(agg._sum.quantity || 0) <= 0) {
        await tx.pallet.update({ where: { id: load.palletId }, data: { status: 'AVAILABLE' } });
      }
      return tx.palletLoad.findUnique({ where: { id: loadId } });
    });
  }
}
