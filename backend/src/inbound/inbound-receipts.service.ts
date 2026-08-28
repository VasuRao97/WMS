import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { companyFilter, ownWarehouseIds, INBOUND_SCOPED_ROLES } from '../common/tenant.util';
import { PutawayTasksService } from '../putaway/putaway-tasks.service';

const RECEIPT_INCLUDE = {
  warehouse: { select: { id: true, code: true, name: true, companyId: true } },
  createdBy: { select: { id: true, name: true } },
  lines: { include: { sku: { select: { id: true, code: true, description: true } }, stagingLocation: { select: { id: true, code: true } } } },
  stagingLocation: { select: { id: true, code: true } },
  // The order's own expected vehicle (2026-08-27, the 1:1-mapping
  // follow-up) — distinct from gateEntry.vehicle below, which is whichever
  // real gate visit ended up matched to this receipt (should always be the
  // same vehicle once matched, but this is the order's own declared intent,
  // visible even before any vehicle has arrived).
  vehicle: { select: { id: true, vehicleNumber: true } },
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
// ERP push (2026-08-27, ErpInboundController + erpPush() below) is a real
// third creation path alongside this and Excel import — same
// prepareReceipt()/validateLines() underneath, just authenticated by a
// per-company API key (ApiKeyGuard) instead of a JWT user, and resolved by
// SKU/Warehouse's normal internal Code (erpCode exists on those models but
// is completely unwired anywhere yet — no form sets it, so using it here
// would just be a second unpopulated dependency). Deliberately does NOT
// require a Vehicle — the client's own framing: "ERP will never know
// about vehicle type etc, its completely a WMS thing" — see
// assignVehicle() below for how a vehicle gets attached later.
@Injectable()
export class InboundReceiptsService {
  constructor(
    private prisma: PrismaService,
    private putawayTasks: PutawayTasksService,
  ) {}

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

  // Enforces the real 1:1 vehicle<->order mapping (2026-08-27, a follow-up
  // gap the client caught: Match Order used to trust a typed PO/Invoice
  // number with no check it was even the right vehicle). Every new order —
  // manual or imported — must name a real, company-owned Vehicle, and that
  // Vehicle must not already have another unmatched order sitting open. A
  // vehicle can make many trips over its life, just never two open orders
  // at once — an order stops being "open" the moment GateEntriesService.
  // matchReceipt() claims it (gateEntry becomes non-null), so a finished or
  // already-matched trip never blocks the vehicle's next one. Scoped
  // company-wide, not per-warehouse: a vehicle can only physically be in
  // one place at a time, so a second open order for it at a DIFFERENT
  // warehouse is exactly as invalid as one at the same warehouse.
  private async resolveVehicleForReceipt(vehicleId: any, user: any, errors: string[], requireVehicle = true): Promise<string | undefined> {
    if (!vehicleId) {
      // requireVehicle: false (2026-08-27, ERP push follow-up) — an
      // ERP-pushed order legitimately has no vehicle yet, by design: "ERP
      // will never know about vehicle type etc, its completely a WMS
      // thing" (the client's own framing). Manual create() and bulkImport()
      // both still call this with the default true, unchanged.
      if (requireVehicle) errors.push('Vehicle is required.');
      return undefined;
    }
    const vehicle = await this.prisma.vehicle.findUnique({ where: { id: vehicleId } });
    if (!vehicle) {
      errors.push('Vehicle not found.');
      return undefined;
    }
    if (user.role !== 'SUPER_ADMIN' && vehicle.companyId !== user.companyId) {
      errors.push('You do not have access to this vehicle.');
      return undefined;
    }
    const openOrder = await this.prisma.inboundReceipt.findFirst({ where: { vehicleId: vehicle.id, gateEntry: null } });
    if (openOrder) {
      errors.push(`Vehicle "${vehicle.vehicleNumber}" already has an unmatched order ("${openOrder.referenceNo}") — match or resolve it before creating another.`);
      return undefined;
    }
    return vehicle.id;
  }

  // Same shape as resolveWarehouseCodeToId/resolveSkuCodeToId — used only
  // by the Excel import path (the manual order maker gets a real vehicleId
  // from a dropdown, not a typed Vehicle Number).
  private async resolveVehicleNumberToId(vehicleNumber: any, user: any, errors: string[]): Promise<string | undefined> {
    const numStr = vehicleNumber ? String(vehicleNumber).trim().toUpperCase() : '';
    if (!numStr) {
      errors.push('Vehicle Number is required.');
      return undefined;
    }
    const vehicle = await this.prisma.vehicle.findUnique({ where: { companyId_vehicleNumber: { companyId: user.companyId, vehicleNumber: numStr } } });
    if (!vehicle) {
      errors.push(`Vehicle Number "${numStr}" not found — register it first.`);
      return undefined;
    }
    return vehicle.id;
  }

  // Shared by the manual order maker (create()) and the Excel bulk import
  // below — same "one function, two callers" convention as
  // SkusService.validateSkuData, so the two paths can't drift apart. Returns
  // errors instead of throwing so a batch import can report per-row results
  // rather than failing the whole file on the first bad order.
  private async prepareReceipt(data: any, user: any, errors: string[], requireVehicle = true) {
    const warehouseId = data.warehouseId;
    if (!warehouseId) errors.push('Warehouse is required.');
    else await this.assertWarehouseAccess(warehouseId, user, errors);

    const referenceNo = data.referenceNo ? String(data.referenceNo).trim() : '';
    if (!referenceNo) errors.push('PO/Reference number is required.');
    else if (warehouseId) {
      const existing = await this.prisma.inboundReceipt.findFirst({ where: { warehouseId, referenceNo } });
      if (existing) errors.push(`An order with reference "${referenceNo}" already exists for this warehouse.`);
    }

    const vehicleId = await this.resolveVehicleForReceipt(data.vehicleId, user, errors, requireVehicle);

    const lines = warehouseId ? await this.validateLines(warehouseId, data.lines, errors) : [];

    return { warehouseId, referenceNo, vehicleId, supplierName: data.supplierName ? String(data.supplierName).trim() : undefined, lines };
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
        vehicle: { connect: { id: prepared.vehicleId! } },
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
      const vehicleId = await this.resolveVehicleNumberToId(row.vehicleNumber, user, errors);

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
        ? await this.prepareReceipt({ warehouseId, referenceNo: row.referenceNo, supplierName: row.supplierName, vehicleId, lines: skuLines }, user, errors)
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
          vehicle: { connect: { id: prepared!.vehicleId! } },
          createdBy: { connect: { id: user.userId } },
          lines: { create: prepared!.lines.map((l) => ({ skuId: l.skuId, expectedQty: l.expectedQty })) },
        },
      });
      successCount++;
      results.push({ referenceNo: row.referenceNo, warehouseCode: row.warehouseCode, status: 'success' });
    }

    return { totalOrders: rows.length, successCount, failCount: rows.length - successCount, results };
  }

  // ERP push (2026-08-27) — see this class's own comment above. One order
  // per call (unlike bulkImport's many-rows-per-file shape — a REST push
  // is naturally one resource per request, not a spreadsheet). Reuses
  // prepareReceipt() with requireVehicle: false via a synthetic
  // "user"-shaped object standing in for the missing human — role
  // COMPANY_ADMIN specifically so assertWarehouseAccess/
  // resolveVehicleForReceipt's INBOUND_SCOPED_ROLES branch never triggers
  // (an ERP push is company-wide, not scoped to one Manager's assigned
  // warehouses — there's no Manager here at all). Throws a normal
  // BadRequestException with the same error array shape as create() — a
  // machine caller gets one clear pass/fail per call, not a results array.
  async erpPush(data: any, companyId: string) {
    const pseudoUser = { companyId, role: 'COMPANY_ADMIN', userId: undefined };
    const errors: string[] = [];
    const warehouseId = await this.resolveWarehouseCodeToId(data.warehouseCode, pseudoUser, errors);

    const skuLines: { skuId: string; expectedQty: number }[] = [];
    if (warehouseId) {
      for (const [i, line] of (data.lines || []).entries()) {
        const skuId = await this.resolveSkuCodeToId(line.skuCode, pseudoUser, errors);
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
      ? await this.prepareReceipt({ warehouseId, referenceNo: data.referenceNo, supplierName: data.supplierName, lines: skuLines }, pseudoUser, errors, false)
      : null;
    if (errors.length > 0) throw new BadRequestException(errors);

    return this.prisma.inboundReceipt.create({
      data: {
        warehouse: { connect: { id: prepared!.warehouseId } },
        referenceNo: prepared!.referenceNo,
        supplierName: prepared!.supplierName,
        createdViaErpPush: true,
        lines: { create: prepared!.lines.map((l) => ({ skuId: l.skuId, expectedQty: l.expectedQty })) },
      },
      include: RECEIPT_INCLUDE,
    });
  }

  // Completes an order that was created without a Vehicle — today that's
  // only ever an ERP-pushed one (create()/bulkImport() both still require
  // one up front), but this doesn't assume that; it just requires the
  // order to not already have one. Runs the exact same
  // resolveVehicleForReceipt() check as creation (exists, company-owned,
  // no other open order) — the 1:1 mapping is enforced identically
  // whenever a vehicle actually gets attached, not just at creation time.
  async assignVehicle(id: string, vehicleId: any, user: any) {
    const receipt = await this.prisma.inboundReceipt.findUnique({ where: { id }, include: { warehouse: { select: { companyId: true } } } });
    if (!receipt) throw new NotFoundException('Order not found.');
    if (user.role !== 'SUPER_ADMIN' && receipt.warehouse.companyId !== user.companyId) throw new ForbiddenException('You do not have access to this order.');
    if (INBOUND_SCOPED_ROLES.includes(user.role)) {
      const ids = await ownWarehouseIds(this.prisma, user.userId);
      if (!ids.includes(receipt.warehouseId)) throw new ForbiddenException('You do not have access to this order.');
    }
    if (receipt.vehicleId) throw new BadRequestException('This order already has a vehicle assigned.');

    const errors: string[] = [];
    const resolvedVehicleId = await this.resolveVehicleForReceipt(vehicleId, user, errors, true);
    if (errors.length > 0) throw new BadRequestException(errors);

    return this.prisma.inboundReceipt.update({
      where: { id },
      data: { vehicle: { connect: { id: resolvedVehicleId! } } },
      include: RECEIPT_INCLUDE,
    });
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
    const before = await tx.inboundReceipt.findUnique({ where: { id: receiptId }, select: { status: true, warehouse: { select: { companyId: true } } } });
    const lines = await tx.inboundReceiptLine.findMany({ where: { receiptId } });
    const allReceived = lines.length > 0 && lines.every((l: any) => Number(l.receivedQty) >= Number(l.expectedQty));
    const anyReceived = lines.some((l: any) => Number(l.receivedQty) > 0);
    const status = allReceived ? 'RECEIVED' : anyReceived ? 'PARTIALLY_RECEIVED' : 'PENDING';
    await tx.inboundReceipt.update({ where: { id: receiptId }, data: { status } });

    // BATCH putaway trigger mode — see GateEntriesService.recomputeReceiptStatus's
    // identical comment; duplicated here for the same reason this whole
    // method is duplicated (each module queries Prisma directly).
    if (before && before.status !== 'RECEIVED' && status === 'RECEIVED') {
      const company = await tx.company.findUnique({ where: { id: before.warehouse.companyId }, select: { putawayTriggerMode: true } });
      if (company?.putawayTriggerMode === 'BATCH') {
        await this.putawayTasks.createBatchTasksForReceipt(tx, receiptId);
      }
    }
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
  //
  // Barcode-vs-approval hard block (2026-08-27, live-testing follow-up) —
  // a real gap caught testing: a barcode already registered to SKU A (e.g.
  // it kept auto-ACCEPTING as CHOC-017 until that line filled up, then
  // correctly BLOCKED) could be approved against a totally unrelated SKU B
  // with zero cross-check. Now: if the scanned barcode has ANY registered
  // SkuBarcode row(s) at all, the chosen line's SKU must be one of them —
  // hard block otherwise. A barcode with ZERO registered rows (a genuinely
  // unrecognized code — composite GS1, a unique per-item serial, "Reading
  // B" territory) still allows a free Supervisor override, unrestricted,
  // exactly as before — that's the one case this override tier exists for.
  // The client's own call, "hard block, we will make a policy about this
  // in next session" — a fuller policy (e.g. requiring a reason code, or a
  // softer warn-not-block mode) is still open for a future pass.
  async approveScan(scanId: string, data: any, user: any) {
    const scan = await this.assertScanAccess(scanId, user);
    if (scan.status !== 'BLOCKED') throw new BadRequestException('Only a blocked scan can be approved.');

    const receiptLineId = data?.receiptLineId || scan.receiptLineId;
    const quantity = data?.quantity !== undefined && data.quantity !== null && data.quantity !== '' ? Number(data.quantity) : scan.quantity != null ? Number(scan.quantity) : undefined;
    if (!receiptLineId || quantity === undefined || !Number.isFinite(quantity) || quantity <= 0) {
      throw new BadRequestException('An expected line and a positive quantity are required to approve this scan.');
    }
    const line = await this.prisma.inboundReceiptLine.findUnique({ where: { id: receiptLineId }, include: { sku: { select: { code: true } } } });
    if (!line || line.receiptId !== scan.receiptId) throw new BadRequestException('That line does not belong to this order.');
    const skuId = line.skuId;

    const registeredBarcodes = await this.prisma.skuBarcode.findMany({
      where: { barcode: scan.barcodeScanned, sku: { companyId: scan.receipt.warehouse.companyId } },
      include: { sku: { select: { code: true } } },
    });
    if (registeredBarcodes.length > 0 && !registeredBarcodes.some((bc) => bc.skuId === skuId)) {
      const knownFor = registeredBarcodes.map((bc) => bc.sku.code).join(', ');
      throw new BadRequestException(`Barcode "${scan.barcodeScanned}" is already registered to ${knownFor}, not ${line.sku.code} — cannot approve this scan against a different SKU.`);
    }
    // Line override first, falling back to the receipt's own staging spot
    // (set at Match Order) — see schema.prisma's comment on
    // InboundReceipt.stagingLocationId.
    const locationId = line.stagingLocationId ?? scan.receipt.stagingLocationId;
    if (!locationId) throw new BadRequestException('This order has no staging location set — match it to a dock/staging spot before approving scans.');

    const receivedDate = await this.putawayTasks.resolveReceivedDate(this.prisma, scan.receiptId);

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
          receivedDate,
        },
      });
      await this.recomputeReceiptStatus(tx, scan.receiptId);
      // IMMEDIATE putaway trigger mode only — see GateEntriesService.scan()'s
      // identical hook for the full comment.
      await this.putawayTasks.handleAcceptedScan(tx, {
        receiptLineId,
        skuId,
        quantity,
        locationId,
        warehouseId: scan.receipt.warehouseId,
        receiptId: scan.receiptId,
      });
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
