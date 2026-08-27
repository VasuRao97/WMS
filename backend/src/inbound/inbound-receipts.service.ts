import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { companyFilter, ownWarehouseIds, INBOUND_SCOPED_ROLES } from '../common/tenant.util';

const RECEIPT_INCLUDE = {
  warehouse: { select: { id: true, code: true, name: true, companyId: true } },
  createdBy: { select: { id: true, name: true } },
  lines: { include: { sku: { select: { id: true, code: true, description: true } }, stagingLocation: { select: { id: true, code: true } } } },
  stagingLocation: { select: { id: true, code: true } },
  gateEntry: { select: { id: true, vehicle: { select: { vehicleNumber: true } }, dockedInAt: true, gateOutAt: true } },
};

const SCAN_INCLUDE = {
  sku: { select: { id: true, code: true, description: true } },
  receiptLine: true,
  scannedBy: { select: { id: true, name: true } },
  reviewedBy: { select: { id: true, name: true } },
  receipt: { select: { id: true, warehouseId: true, stagingLocationId: true, warehouse: { select: { companyId: true } } } },
};

// Inbound receiving — the manual "order maker" (2026-08-27, see CLAUDE.md's
// "Inbound receiving" section for the full design conversation). Creates
// the InboundReceipt/InboundReceiptLine rows that VehicleGateEntry.
// matchReceipt() (GateEntriesService) later resolves against, and owns the
// Supervisor-facing approve/reject actions on a BLOCKED InboundReceiptScan
// (the scan itself is created by GateEntriesService.scan(), tied to the
// gate-entry "session" it happens during — this service only handles what
// comes before scanning starts and what resolves a scan afterward).
// ERP push (Company.allowErpInboundPush) is NOT built yet — this is the
// manual path only, per the client's own build-order call (manual first,
// ERP push reuses this same create() logic later with a company API key
// and erpCode-based SKU/warehouse resolution instead).
@Injectable()
export class InboundReceiptsService {
  constructor(private prisma: PrismaService) {}

  private async assertWarehouseAccess(warehouseId: string, user: any, errors: string[]) {
    const warehouse = await this.prisma.warehouse.findUnique({ where: { id: warehouseId } });
    if (!warehouse) {
      errors.push('Warehouse not found.');
      return;
    }
    if (user.role !== 'SUPER_ADMIN' && warehouse.companyId !== user.companyId) {
      errors.push('You do not have access to this warehouse.');
      return;
    }
    if (INBOUND_SCOPED_ROLES.includes(user.role)) {
      const ids = await ownWarehouseIds(this.prisma, user.userId);
      if (!ids.includes(warehouseId)) errors.push('You can only create orders for your own assigned warehouse(s).');
    }
  }

  // Same shape as LocationsService's resolveWarehouseCodeToId — used only
  // by the Excel import path (the manual order maker already gets a real
  // warehouseId from a dropdown, not a typed code).
  private async resolveWarehouseCodeToId(code: any, user: any, errors: string[]): Promise<string | undefined> {
    const codeStr = code ? String(code).trim().toUpperCase() : '';
    if (!codeStr) {
      errors.push('Warehouse Code is required.');
      return undefined;
    }
    const warehouse = await this.prisma.warehouse.findUnique({ where: { companyId_code: { companyId: user.companyId, code: codeStr } } });
    if (!warehouse) {
      errors.push(`Warehouse Code "${codeStr}" not found.`);
      return undefined;
    }
    if (INBOUND_SCOPED_ROLES.includes(user.role)) {
      const ids = await ownWarehouseIds(this.prisma, user.userId);
      if (!ids.includes(warehouse.id)) {
        errors.push(`You can only create orders for your own assigned warehouse(s) — no access to "${codeStr}".`);
        return undefined;
      }
    }
    return warehouse.id;
  }

  // Staging location is deliberately NOT required here (2026-08-27, a real
  // gap the client caught) — at order-creation time nobody can know where a
  // delivery will physically be staged; that's only knowable once the
  // vehicle is actually at the dock. See InboundReceipt.stagingLocationId's
  // schema comment. A line MAY still carry its own override if genuinely
  // needed, but the order maker itself never requires one.
  private async validateLines(warehouseId: string, input: any, errors: string[]) {
    if (!Array.isArray(input) || input.length === 0) {
      errors.push('At least one SKU line is required.');
      return [];
    }
    const result: { skuId: string; expectedQty: number; stagingLocationId?: string }[] = [];
    for (const [i, row] of input.entries()) {
      const skuId = row?.skuId;
      const expectedQty = Number(row?.expectedQty);
      const stagingLocationId = row?.stagingLocationId || undefined;
      if (!skuId) {
        errors.push(`Line ${i + 1}: SKU is required.`);
        continue;
      }
      if (!Number.isFinite(expectedQty) || expectedQty <= 0) {
        errors.push(`Line ${i + 1}: Expected Quantity must be a positive number.`);
        continue;
      }
      const sku = await this.prisma.sku.findUnique({ where: { id: skuId } });
      if (!sku) {
        errors.push(`Line ${i + 1}: SKU not found.`);
        continue;
      }
      if (stagingLocationId) {
        const location = await this.prisma.location.findUnique({ where: { id: stagingLocationId } });
        if (!location) errors.push(`Line ${i + 1}: Staging Location not found.`);
        else if (location.warehouseId !== warehouseId) errors.push(`Line ${i + 1}: Staging Location does not belong to the selected warehouse.`);
        else result.push({ skuId, expectedQty, stagingLocationId });
        continue;
      }
      result.push({ skuId, expectedQty });
    }
    return result;
  }

  // Shared by the manual order maker (create()) and the Excel bulk import
  // below — same "one function, two callers" convention as
  // SkusService.validateSkuData, so the two paths can't drift apart. Returns
  // errors instead of throwing so a batch import can report per-row results
  // rather than failing the whole file on the first bad order.
  private async prepareReceipt(data: any, user: any, errors: string[]) {
    const warehouseId = data.warehouseId;
    if (!warehouseId) errors.push('Warehouse is required.');
    else await this.assertWarehouseAccess(warehouseId, user, errors);

    const referenceNo = data.referenceNo ? String(data.referenceNo).trim() : '';
    if (!referenceNo) errors.push('PO/Reference number is required.');
    else if (warehouseId) {
      const existing = await this.prisma.inboundReceipt.findFirst({ where: { warehouseId, referenceNo } });
      if (existing) errors.push(`An order with reference "${referenceNo}" already exists for this warehouse.`);
    }

    const lines = warehouseId ? await this.validateLines(warehouseId, data.lines, errors) : [];

    return { warehouseId, referenceNo, supplierName: data.supplierName ? String(data.supplierName).trim() : undefined, lines };
  }

  async create(data: any, user: any) {
    if (!user.companyId) throw new ForbiddenException('Super admin accounts cannot create orders directly — log in as a company admin instead.');
    const errors: string[] = [];
    const prepared = await this.prepareReceipt(data, user, errors);
    if (errors.length > 0) throw new BadRequestException(errors);

    return this.prisma.inboundReceipt.create({
      data: {
        warehouse: { connect: { id: prepared.warehouseId } },
        referenceNo: prepared.referenceNo,
        supplierName: prepared.supplierName,
        createdBy: { connect: { id: user.userId } },
        lines: { create: prepared.lines.map((l) => ({ skuId: l.skuId, expectedQty: l.expectedQty, stagingLocationId: l.stagingLocationId })) },
      },
      include: RECEIPT_INCLUDE,
    });
  }

  private async resolveSkuCodeToId(code: any, user: any, errors: string[]): Promise<string | undefined> {
    const codeStr = code ? String(code).trim().toUpperCase() : '';
    if (!codeStr) {
      errors.push('SKU Code is required.');
      return undefined;
    }
    const sku = await this.prisma.sku.findUnique({ where: { companyId_code: { companyId: user.companyId, code: codeStr } } });
    if (!sku) {
      errors.push(`SKU Code "${codeStr}" not found.`);
      return undefined;
    }
    return sku.id;
  }

  // Excel bulk import (2026-08-27, Inbound deep-dive) — an alternative to
  // the still-unbuilt ERP push (Company.allowErpInboundPush), per the
  // client's own framing. One file can create MULTIPLE orders in one call —
  // rows are grouped by (Warehouse Code, Reference No) in the controller
  // (same repeated-key grouping pattern as Warehouse Storage Types/Customer
  // Ship-tos), each distinct group becomes its own InboundReceipt with its
  // SKU lines. Deliberately mirrors the manual order maker's own fields
  // exactly — no staging location column, same reasoning as create(): it
  // isn't knowable until the vehicle is actually at the dock (Match Order).
  async bulkImport(rows: any[], user: any) {
    if (!user.companyId) throw new ForbiddenException('Super admin accounts cannot import orders directly — log in as a company admin instead.');
    const results: any[] = [];
    let successCount = 0;

    for (const row of rows) {
      const errors: string[] = [];
      const warehouseId = await this.resolveWarehouseCodeToId(row.warehouseCode, user, errors);

      const skuLines: { skuId: string; expectedQty: number }[] = [];
      if (warehouseId) {
        for (const [i, line] of (row.lines || []).entries()) {
          const skuId = await this.resolveSkuCodeToId(line.skuCode, user, errors);
          const expectedQty = Number(line.expectedQty);
          if (!Number.isFinite(expectedQty) || expectedQty <= 0) {
            errors.push(`Line ${i + 1} (${line.skuCode || '?'}): Expected Quantity must be a positive number.`);
            continue;
          }
          if (skuId) skuLines.push({ skuId, expectedQty });
        }
      }
      if (skuLines.length === 0 && errors.length === 0) errors.push('At least one SKU line is required.');

      const prepared = warehouseId
        ? await this.prepareReceipt({ warehouseId, referenceNo: row.referenceNo, supplierName: row.supplierName, lines: skuLines }, user, errors)
        : null;

      if (errors.length > 0) {
        results.push({ referenceNo: row.referenceNo || '(blank)', warehouseCode: row.warehouseCode, status: 'error', errors });
        continue;
      }

      await this.prisma.inboundReceipt.create({
        data: {
          warehouse: { connect: { id: prepared!.warehouseId } },
          referenceNo: prepared!.referenceNo,
          supplierName: prepared!.supplierName,
          createdBy: { connect: { id: user.userId } },
          lines: { create: prepared!.lines.map((l) => ({ skuId: l.skuId, expectedQty: l.expectedQty })) },
        },
      });
      successCount++;
      results.push({ referenceNo: row.referenceNo, warehouseCode: row.warehouseCode, status: 'success' });
    }

    return { totalOrders: rows.length, successCount, failCount: rows.length - successCount, results };
  }

  async findAll(user: any) {
    const where: any = { warehouse: { ...companyFilter(user) } };
    if (INBOUND_SCOPED_ROLES.includes(user.role)) {
      where.warehouseId = { in: await ownWarehouseIds(this.prisma, user.userId) };
    }
    return this.prisma.inboundReceipt.findMany({ where, include: RECEIPT_INCLUDE, orderBy: { createdAt: 'desc' } });
  }

  async findOne(id: string, user: any) {
    const receipt = await this.prisma.inboundReceipt.findUnique({
      where: { id },
      include: { ...RECEIPT_INCLUDE, scans: { include: SCAN_INCLUDE, orderBy: { scannedAt: 'desc' } } },
    });
    if (!receipt) throw new NotFoundException('Order not found.');
    if (user.role !== 'SUPER_ADMIN' && receipt.warehouse.companyId !== user.companyId) throw new ForbiddenException('You do not have access to this order.');
    if (INBOUND_SCOPED_ROLES.includes(user.role)) {
      const ids = await ownWarehouseIds(this.prisma, user.userId);
      if (!ids.includes(receipt.warehouseId)) throw new ForbiddenException('You do not have access to this order.');
    }
    return receipt;
  }

  private async assertScanAccess(scanId: string, user: any) {
    const scan = await this.prisma.inboundReceiptScan.findUnique({ where: { id: scanId }, include: SCAN_INCLUDE });
    if (!scan) throw new NotFoundException('Scan not found.');
    if (user.role !== 'SUPER_ADMIN' && scan.receipt.warehouse.companyId !== user.companyId) throw new ForbiddenException('You do not have access to this scan.');
    if (INBOUND_SCOPED_ROLES.includes(user.role)) {
      const ids = await ownWarehouseIds(this.prisma, user.userId);
      if (!ids.includes(scan.receipt.warehouseId)) throw new ForbiddenException('You do not have access to this scan.');
    }
    return scan;
  }

  // recomputeReceiptStatus is duplicated from GateEntriesService rather
  // than imported cross-module — see that method's own comment for why.
  private async recomputeReceiptStatus(tx: any, receiptId: string) {
    const lines = await tx.inboundReceiptLine.findMany({ where: { receiptId } });
    const allReceived = lines.length > 0 && lines.every((l: any) => Number(l.receivedQty) >= Number(l.expectedQty));
    const anyReceived = lines.some((l: any) => Number(l.receivedQty) > 0);
    const status = allReceived ? 'RECEIVED' : anyReceived ? 'PARTIALLY_RECEIVED' : 'PENDING';
    await tx.inboundReceipt.update({ where: { id: receiptId }, data: { status } });
  }

  // A Supervisor confirms what a BLOCKED scan actually is — never the
  // operator who scanned it (enforced by role gating in the controller,
  // INBOUND_APPROVE_ROLES excludes OPERATOR). Only receiptLineId/quantity
  // are ever taken from the request — skuId is always DERIVED from the
  // chosen line, never accepted separately, since a line already
  // determines its SKU unambiguously; asking the client to also supply a
  // matching skuId was a real redundant-and-forgettable requirement (caught
  // live: the Receiving UI's approve form only ever collects a line +
  // quantity, so skuId was always missing from the request body and every
  // approval 400'd until this was fixed, 2026-08-27).
  async approveScan(scanId: string, data: any, user: any) {
    const scan = await this.assertScanAccess(scanId, user);
    if (scan.status !== 'BLOCKED') throw new BadRequestException('Only a blocked scan can be approved.');

    const receiptLineId = data?.receiptLineId || scan.receiptLineId;
    const quantity = data?.quantity !== undefined && data.quantity !== null && data.quantity !== '' ? Number(data.quantity) : scan.quantity != null ? Number(scan.quantity) : undefined;
    if (!receiptLineId || quantity === undefined || !Number.isFinite(quantity) || quantity <= 0) {
      throw new BadRequestException('An expected line and a positive quantity are required to approve this scan.');
    }
    const line = await this.prisma.inboundReceiptLine.findUnique({ where: { id: receiptLineId } });
    if (!line || line.receiptId !== scan.receiptId) throw new BadRequestException('That line does not belong to this order.');
    const skuId = line.skuId;
    // Line override first, falling back to the receipt's own staging spot
    // (set at Match Order) — see schema.prisma's comment on
    // InboundReceipt.stagingLocationId.
    const locationId = line.stagingLocationId ?? scan.receipt.stagingLocationId;
    if (!locationId) throw new BadRequestException('This order has no staging location set — match it to a dock/staging spot before approving scans.');

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.inboundReceiptScan.update({
        where: { id: scanId },
        data: { status: 'APPROVED', skuId, receiptLineId, quantity, reviewedById: user.userId, reviewedAt: new Date() },
        include: SCAN_INCLUDE,
      });
      await tx.inboundReceiptLine.update({ where: { id: receiptLineId }, data: { receivedQty: { increment: quantity } } });
      await tx.stockMovement.create({
        data: {
          warehouseId: scan.receipt.warehouseId,
          skuId,
          locationId,
          quantity,
          movementType: 'RECEIPT',
          referenceType: 'InboundReceiptScan',
          referenceId: scanId,
          createdById: user.userId,
          notes: 'Supervisor-approved override of a blocked scan.',
        },
      });
      await this.recomputeReceiptStatus(tx, scan.receiptId);
      return updated;
    });
  }

  // Discards a blocked scan as a genuine mistake (mis-scan, duplicate) — no
  // stock impact, stays in the log for audit rather than being deleted.
  async rejectScan(scanId: string, user: any) {
    const scan = await this.assertScanAccess(scanId, user);
    if (scan.status !== 'BLOCKED') throw new BadRequestException('Only a blocked scan can be rejected.');
    return this.prisma.inboundReceiptScan.update({
      where: { id: scanId },
      data: { status: 'REJECTED', reviewedById: user.userId, reviewedAt: new Date() },
      include: SCAN_INCLUDE,
    });
  }
}
