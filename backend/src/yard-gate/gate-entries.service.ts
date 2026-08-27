import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { normalizeCode } from '../common/normalize.util';
import { assertGateAccessAllowed, companyFilter, ownWarehouseIds, GATE_YARD_SCOPED_ROLES } from '../common/tenant.util';
import { DriverNotificationService } from './driver-notification.service';
import { NotificationsService } from '../notifications/notifications.service';

// VEHICLE_ONLY (a non-cargo visit) was considered and dropped 2026-08-25 —
// no concrete real use case for it, easy to add back later if one shows up.
const PURPOSE_LABELS: Record<string, string> = {
  INBOUND_DELIVERY: 'Inbound Delivery',
  OUTBOUND_DISPATCH: 'Outbound Dispatch',
  RETURNS: 'Returns',
};
const PURPOSE_VALUES = Object.keys(PURPOSE_LABELS);

const DOCUMENT_TYPE_VALUES = ['LICENSE', 'INSURANCE', 'RC', 'PUC', 'FITNESS'];
const DOCUMENT_STATUS_VALUES = ['OK', 'FLAGGED', 'MISSING'];

const GATE_ENTRY_INCLUDE = {
  warehouse: { select: { id: true, code: true, name: true } },
  vehicle: { select: { id: true, vehicleNumber: true, maxTonnage: true, vehicleType: { select: { id: true, name: true, segment: true, maxTonnage: true } } } },
  driver: { select: { id: true, name: true, phone: true } },
  yardSlot: { select: { id: true, code: true } },
  gateInBy: { select: { id: true, name: true } },
  gateOutBy: { select: { id: true, name: true } },
  dockedInBy: { select: { id: true, name: true } },
  inwardCompletedBy: { select: { id: true, name: true } },
  documentChecks: true,
  // Inbound receiving (2026-08-27) — the matched order (if any) with its
  // expected lines, and the full scan log for this visit.
  inboundReceipt: {
    include: {
      lines: { include: { sku: { select: { id: true, code: true, description: true } } } },
      stagingLocation: { select: { id: true, code: true } },
    },
  },
  inboundScans: {
    include: {
      sku: { select: { id: true, code: true, description: true } },
      scannedBy: { select: { id: true, name: true } },
      reviewedBy: { select: { id: true, name: true } },
    },
    orderBy: { scannedAt: 'desc' as const },
  },
};

// Vehicle Gate In/Out log — foundation piece of Yard & Gate Management
// (2026-08-25), see schema.prisma's "YARD & GATE MANAGEMENT" section and
// CLAUDE.md for the full reasoning. This is an operational transaction log,
// not master data — closer in shape to LoginEvent/StockMovement (append-
// only, no delete) than to Warehouse/Location, except a GateEntry does get
// one real UPDATE path (Gate Out closes it), same as InboundReceipt getting
// updated as its status progresses. Deliberately has no link to DockDoor —
// see schema.prisma's comment on the model for why that was rejected.
@Injectable()
export class GateEntriesService {
  constructor(
    private prisma: PrismaService,
    private driverNotifications: DriverNotificationService,
    private notifications: NotificationsService,
  ) {}

  // Net weight is always derived (gross - tare) at read time, never stored —
  // same "always derived" philosophy as Location capacity / on-hand stock.
  private attachNetWeight(entry: any) {
    const netWeightKg = entry.grossWeightKg != null && entry.tareWeightKg != null ? Number(entry.grossWeightKg) - Number(entry.tareWeightKg) : undefined;
    return { ...entry, netWeightKg };
  }

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
    if (GATE_YARD_SCOPED_ROLES.includes(user.role)) {
      const ids = await ownWarehouseIds(this.prisma, user.userId);
      if (!ids.includes(warehouseId)) errors.push('You can only log gate entries for your own assigned warehouse(s).');
    }
  }

  // Gate In always picks an EXISTING registered Vehicle/Driver — no
  // inline/auto-create (confirmed with the client 2026-08-25). Both are
  // company-scoped master data, same access shape as Warehouse.
  private async resolveVehicle(vehicleId: any, user: any, errors: string[]): Promise<string | undefined> {
    if (!vehicleId) {
      errors.push('Vehicle is required — select a registered vehicle.');
      return undefined;
    }
    const vehicle = await this.prisma.vehicle.findUnique({ where: { id: vehicleId } });
    if (!vehicle) {
      errors.push('Vehicle not found — it may need to be registered first.');
      return undefined;
    }
    if (user.role !== 'SUPER_ADMIN' && vehicle.companyId !== user.companyId) {
      errors.push('You do not have access to this vehicle.');
      return undefined;
    }
    if (!vehicle.isActive) {
      errors.push('This vehicle is deactivated.');
      return undefined;
    }
    return vehicleId;
  }

  private async resolveDriver(driverId: any, user: any, errors: string[]): Promise<string | undefined> {
    if (!driverId) {
      errors.push('Driver is required — select a registered driver.');
      return undefined;
    }
    const driver = await this.prisma.driver.findUnique({ where: { id: driverId } });
    if (!driver) {
      errors.push('Driver not found — they may need to be registered first.');
      return undefined;
    }
    if (user.role !== 'SUPER_ADMIN' && driver.companyId !== user.companyId) {
      errors.push('You do not have access to this driver.');
      return undefined;
    }
    if (!driver.isActive) {
      errors.push('This driver is deactivated.');
      return undefined;
    }
    return driverId;
  }

  // Optional — documents actually checked at THIS visit (License/Insurance/
  // RC/PUC/Fitness), one row per type. See schema.prisma's comment on
  // GateEntryDocumentCheck for why this is a separate table rather than
  // fixed columns.
  private validateDocumentChecks(input: any, errors: string[]): { documentType: string; status: string; note?: string }[] {
    if (input === undefined || input === null) return [];
    if (!Array.isArray(input)) {
      errors.push('Document checks must be a list.');
      return [];
    }
    const seen = new Set<string>();
    const result: { documentType: string; status: string; note?: string }[] = [];
    for (const row of input) {
      const documentType = row?.documentType ? normalizeCode(row.documentType) : '';
      const status = row?.status ? normalizeCode(row.status) : '';
      if (!DOCUMENT_TYPE_VALUES.includes(documentType)) {
        errors.push(`Document type must be one of: ${DOCUMENT_TYPE_VALUES.join(', ')}.`);
        continue;
      }
      if (!DOCUMENT_STATUS_VALUES.includes(status)) {
        errors.push(`Document status must be one of: ${DOCUMENT_STATUS_VALUES.join(', ')}.`);
        continue;
      }
      if (seen.has(documentType)) {
        errors.push(`Duplicate document check for ${documentType}.`);
        continue;
      }
      seen.add(documentType);
      result.push({ documentType, status, note: row.note ? String(row.note).trim() : undefined });
    }
    return result;
  }

  // Yard slot auto-assignment at Gate In (2026-08-26 Yard Management pass).
  // A warehouse with zero YardSlot rows (no `yardCapacity` set at creation —
  // a small facility with no on-site parking) is a no-op here: no slot, no
  // warning, no block — Yard Management simply doesn't apply to it, but
  // Gate In/Out itself proceeds exactly as normal (confirmed with the
  // client). Only a warehouse that DOES have slots, all currently occupied,
  // triggers the "yard full" warning/block path.
  private async assignYardSlot(warehouseId: string, companyId: string, errors: string[]): Promise<{ yardSlotId?: string; yardFullWarning: boolean }> {
    const totalSlots = await this.prisma.yardSlot.count({ where: { warehouseId, isActive: true } });
    if (totalSlots === 0) return { yardFullWarning: false };

    const freeSlot = await this.prisma.yardSlot.findFirst({
      where: { warehouseId, isActive: true, status: 'AVAILABLE' },
      orderBy: { createdAt: 'asc' }, // any free slot works — which exact one doesn't matter (confirmed)
    });
    if (freeSlot) return { yardSlotId: freeSlot.id, yardFullWarning: false };

    // Yard is full — always warn; only hard-block if this company opted in.
    const company = await this.prisma.company.findUnique({ where: { id: companyId } });
    if (company?.blockGateInWhenYardFull) {
      errors.push('The yard is at full capacity — no parking slots available. This vehicle cannot be gated in until a slot frees up.');
    }
    return { yardFullWarning: true };
  }

  async create(data: any, user: any) {
    await assertGateAccessAllowed(this.prisma, user);
    if (!user.companyId) {
      throw new ForbiddenException('Super admin accounts cannot log gate entries directly — log in as a company admin instead.');
    }
    const errors: string[] = [];
    const warehouseId = data.warehouseId;
    let companyId: string | undefined;
    if (!warehouseId) errors.push('Warehouse is required.');
    else {
      await this.assertWarehouseAccess(warehouseId, user, errors);
      const warehouse = await this.prisma.warehouse.findUnique({ where: { id: warehouseId }, select: { companyId: true } });
      companyId = warehouse?.companyId;
    }

    const vehicleId = await this.resolveVehicle(data.vehicleId, user, errors);
    const driverId = await this.resolveDriver(data.driverId, user, errors);

    const purpose = data.purpose ? normalizeCode(data.purpose) : '';
    if (!purpose) errors.push('Purpose is required.');
    else if (!PURPOSE_VALUES.includes(purpose)) errors.push(`Purpose must be one of: ${Object.values(PURPOSE_LABELS).join(', ')}.`);

    let grossWeightKg: number | undefined;
    if (data.grossWeightKg !== undefined && data.grossWeightKg !== null && data.grossWeightKg !== '') {
      grossWeightKg = Number(data.grossWeightKg);
      if (!Number.isFinite(grossWeightKg) || grossWeightKg <= 0) errors.push('Gross Weight must be a positive number.');
    }

    const documentChecks = this.validateDocumentChecks(data.documentChecks, errors);
    const commodityDescription = data.commodityDescription ? String(data.commodityDescription).trim() : undefined;

    let yardResult: { yardSlotId?: string; yardFullWarning: boolean } = { yardFullWarning: false };
    if (warehouseId && companyId && errors.length === 0) {
      yardResult = await this.assignYardSlot(warehouseId, companyId, errors);
    }

    if (errors.length > 0) throw new BadRequestException(errors);

    const created = await this.prisma.$transaction(async (tx) => {
      const entry = await tx.vehicleGateEntry.create({
        data: {
          warehouse: { connect: { id: warehouseId } },
          vehicle: { connect: { id: vehicleId } },
          driver: { connect: { id: driverId } },
          transporterName: data.transporterName ? String(data.transporterName).trim() : undefined,
          purpose: purpose as any,
          referenceNo: data.referenceNo ? String(data.referenceNo).trim() : undefined,
          destinationCity: data.destinationCity ? String(data.destinationCity).trim() : undefined,
          commodityDescription,
          yardSlot: yardResult.yardSlotId ? { connect: { id: yardResult.yardSlotId } } : undefined,
          gateInBy: { connect: { id: user.userId } },
          grossWeightKg: grossWeightKg,
          grossWeighedAt: grossWeightKg !== undefined ? new Date() : undefined,
          documentChecks: documentChecks.length
            ? { create: documentChecks.map((d) => ({ documentType: d.documentType as any, status: d.status as any, note: d.note })) }
            : undefined,
        },
        include: GATE_ENTRY_INCLUDE,
      });
      if (yardResult.yardSlotId) {
        await tx.yardSlot.update({ where: { id: yardResult.yardSlotId }, data: { status: 'OCCUPIED' } });
      }
      return entry;
    });

    // "Vehicle ready for unloading" (2026-08-27, Inbound receiving design)
    // — fires once, right here at Gate In, only for Inbound and only when
    // every document came back OK (the client's own trigger condition).
    // Broadcast to every Supervisor/Manager on the warehouse, same shape
    // DetentionAlertScheduler already uses for its own recipient lookup.
    // Fire-and-forget in spirit (errors here shouldn't fail the Gate In
    // itself) but awaited so a real send failure still surfaces in logs.
    if (purpose === 'INBOUND_DELIVERY' && documentChecks.length === DOCUMENT_TYPE_VALUES.length && documentChecks.every((d) => d.status === 'OK')) {
      await this.notifyVehicleReady(created, companyId!);
    }

    return { ...this.attachNetWeight(created), yardFullWarning: yardResult.yardFullWarning };
  }

  private async notifyVehicleReady(entry: any, companyId: string) {
    const recipients = await this.prisma.user.findMany({
      where: {
        companyId,
        role: { in: ['WAREHOUSE_SUPERVISOR', 'WAREHOUSE_MANAGER'] },
        isActive: true,
        assignedWarehouses: { some: { id: entry.warehouseId } },
      },
      select: { id: true },
    });
    if (recipients.length === 0) return; // no one assigned to this warehouse yet — same known gap as detention alerting

    const channels = await this.notifications.channelsFor(companyId);
    const message = `Vehicle ${entry.vehicle.vehicleNumber} is parked and documents are OK — ready for unloading.`;
    for (const recipient of recipients) {
      for (const channel of channels) {
        await this.notifications.sendAndLog({
          companyId,
          warehouseId: entry.warehouseId,
          eventType: 'VEHICLE_READY_FOR_UNLOADING',
          referenceType: 'VehicleGateEntry',
          referenceId: entry.id,
          recipientUserId: recipient.id,
          channel,
          message,
        });
      }
    }
  }

  async findAll(user: any) {
    await assertGateAccessAllowed(this.prisma, user);
    const where: any = { warehouse: { ...companyFilter(user) } };
    if (GATE_YARD_SCOPED_ROLES.includes(user.role)) {
      where.warehouseId = { in: await ownWarehouseIds(this.prisma, user.userId) };
    }
    const entries = await this.prisma.vehicleGateEntry.findMany({
      where,
      include: GATE_ENTRY_INCLUDE,
      orderBy: { gateInAt: 'desc' },
    });
    return entries.map((e) => this.attachNetWeight(e));
  }

  // A raw dump — everything in scope, not filtered by date here (the
  // client's own framing: "dump export when we need for date filter,"
  // i.e. filtering happens in Excel afterward, not in this endpoint).
  // Same shape convention as every other master-data export in this
  // codebase, applied to a transaction log for the first time.
  async exportRows(user: any) {
    const entries = await this.findAll(user);
    return entries.map((e: any) => ({
      'Gate In At': e.gateInAt ? e.gateInAt.toISOString() : '',
      'Gate In By': e.gateInBy?.name || '',
      'Warehouse': e.warehouse.code,
      'Vehicle Number': e.vehicle.vehicleNumber,
      'Driver': e.driver.name,
      'Transporter': e.transporterName || '',
      'Purpose': e.purpose,
      'Reference No': e.referenceNo || '',
      'Destination City': e.destinationCity || '',
      'Commodity Description': e.commodityDescription || '',
      'Yard Slot': e.yardSlot?.code || '',
      'Assigned Dock': e.assignedDockNumber || '',
      'Docked In At': e.dockedInAt ? e.dockedInAt.toISOString() : '',
      'Docked In By': e.dockedInBy?.name || '',
      'Physical Condition OK': e.physicalConditionOk === true ? 'TRUE' : e.physicalConditionOk === false ? 'FALSE' : '',
      'Physical Condition Remarks': e.physicalConditionRemarks || '',
      'Seal Number': e.sealNumber || '',
      'Inward Completed At': e.inwardCompletedAt ? e.inwardCompletedAt.toISOString() : '',
      'Inward Completed By': e.inwardCompletedBy?.name || '',
      'Inward Completion Remarks': e.inwardCompletionRemarks || '',
      'Gate Out At': e.gateOutAt ? e.gateOutAt.toISOString() : '',
      'Gate Out By': e.gateOutBy?.name || '',
      'E-Way Bill No': e.eWayBillNo || '',
      'Invoice Weight Kg': e.invoiceWeightKg ?? '',
      'Material Received Confirmed': e.materialReceivedConfirmed ? 'TRUE' : 'FALSE',
      'Gross Weight Kg': e.grossWeightKg ?? '',
      'Tare Weight Kg': e.tareWeightKg ?? '',
      'Net Weight Kg': e.netWeightKg ?? '',
      'Document Checks': (e.documentChecks || []).map((d: any) => `${d.documentType}:${d.status}`).join(', '),
      'Status': e.gateOutAt ? 'GATED_OUT' : e.dockedInAt ? 'DOCKED' : 'IN_YARD',
    }));
  }

  private async assertAccess(id: string, user: any) {
    const entry = await this.prisma.vehicleGateEntry.findUnique({
      where: { id },
      include: { warehouse: true, vehicle: { include: { vehicleType: true } } },
    });
    if (!entry) throw new NotFoundException('Gate entry not found.');
    if (user.role !== 'SUPER_ADMIN' && entry.warehouse.companyId !== user.companyId) {
      throw new ForbiddenException('You do not have access to this gate entry.');
    }
    if (GATE_YARD_SCOPED_ROLES.includes(user.role)) {
      const ids = await ownWarehouseIds(this.prisma, user.userId);
      if (!ids.includes(entry.warehouseId)) throw new ForbiddenException('You do not have access to this gate entry.');
    }
    return entry;
  }

  // Corrections to an entry that hasn't gated out yet — vehicle/driver,
  // transporter, or reference number. Purpose and Warehouse are
  // deliberately not editable here (changing either mid-visit would be a
  // data-integrity smell, not a real correction) — a mistaken entry should
  // be re-logged instead.
  async update(id: string, data: any, user: any) {
    await assertGateAccessAllowed(this.prisma, user);
    const existing = await this.assertAccess(id, user);
    if (existing.gateOutAt) throw new BadRequestException('This vehicle has already gated out — its entry can no longer be edited.');

    const errors: string[] = [];
    const vehicleId = data.vehicleId !== undefined ? await this.resolveVehicle(data.vehicleId, user, errors) : existing.vehicleId;
    const driverId = data.driverId !== undefined ? await this.resolveDriver(data.driverId, user, errors) : existing.driverId;
    if (errors.length > 0) throw new BadRequestException(errors);

    const updated = await this.prisma.vehicleGateEntry.update({
      where: { id },
      data: {
        vehicle: { connect: { id: vehicleId } },
        driver: { connect: { id: driverId } },
        transporterName: data.transporterName !== undefined ? String(data.transporterName).trim() || null : undefined,
        referenceNo: data.referenceNo !== undefined ? String(data.referenceNo).trim() || null : undefined,
        destinationCity: data.destinationCity !== undefined ? String(data.destinationCity).trim() || null : undefined,
      },
      include: GATE_ENTRY_INCLUDE,
    });

    return this.attachNetWeight(updated);
  }

  // A deliberately lightweight stand-in for real Dock Scheduling (not built
  // yet) — just marks "this vehicle left the yard," frees its slot, and
  // stops here. No dock door selection, no appointment logic — that's a
  // separate future feature. See schema.prisma's comment on `dockedInAt`.
  //
  // Also where the physical condition inspection (both directions) and,
  // for INBOUND_DELIVERY only, the seal number/signature get captured
  // (2026-08-27, Yard/Gate competitor-research follow-up) — see
  // schema.prisma's comments on those fields. All optional; nothing here
  // blocks Dock In if left blank.
  async dockIn(id: string, data: any, user: any) {
    await assertGateAccessAllowed(this.prisma, user);
    const existing = await this.assertAccess(id, user);
    if (existing.dockedInAt) throw new BadRequestException('This vehicle has already been marked docked in.');
    if (existing.gateOutAt) throw new BadRequestException('This vehicle has already gated out.');

    const physicalConditionOk = data?.physicalConditionOk !== undefined && data.physicalConditionOk !== null ? !!data.physicalConditionOk : undefined;
    const physicalConditionRemarks = data?.physicalConditionRemarks ? String(data.physicalConditionRemarks).trim() : undefined;
    const sealNumber = data?.sealNumber ? String(data.sealNumber).trim() : undefined;
    const sealSignatureData = data?.sealSignatureData ? String(data.sealSignatureData) : undefined;
    const sealCaptured = sealNumber !== undefined || sealSignatureData !== undefined;

    const updated = await this.prisma.$transaction(async (tx) => {
      const entry = await tx.vehicleGateEntry.update({
        where: { id },
        data: {
          dockedInAt: new Date(),
          dockedInBy: { connect: { id: user.userId } },
          physicalConditionOk,
          physicalConditionRemarks,
          sealNumber,
          sealSignatureData,
          sealCapturedAt: sealCaptured ? new Date() : undefined,
          sealCapturedBy: sealCaptured ? { connect: { id: user.userId } } : undefined,
        },
        include: GATE_ENTRY_INCLUDE,
      });
      if (existing.yardSlotId) {
        await tx.yardSlot.update({ where: { id: existing.yardSlotId }, data: { status: 'AVAILABLE' } });
      }
      return entry;
    });

    return this.attachNetWeight(updated);
  }

  // Inbound receiving, step 2 (2026-08-27, revised same day in a follow-up
  // conversation) — the REAL, authoritative order match. Used to trust a
  // typed PO/Invoice number with NO check it was even the right vehicle — a
  // real gap the client caught: "let's bring in the consideration of the
  // vehicle also... so that we have a 1v1 mapping of vehicle and order,
  // then only we should be able to match order." Now auto-finds the one
  // InboundReceipt whose own declared `vehicleId` equals this gate entry's
  // vehicle and that has no gateEntry yet — no typed reference number at
  // all. InboundReceiptsService enforces the "one open order per vehicle"
  // half of the 1:1 mapping at order-creation time, so at most one such
  // receipt should ever exist; this just looks it up. Only Inbound, only
  // after Dock In (matches the client's described flow — the driver hands
  // over the PO/invoice once actually at the dock), and only once per
  // receipt (@unique on inboundReceiptId) and once per gate entry.
  //
  // Also where the receipt's staging location gets set (2026-08-27,
  // correcting a real gap the client caught) — a delivery's staging spot
  // can't be known at order-creation time, before the vehicle even exists
  // in the system; this is the first moment staff actually knows where
  // they're unloading it. Required here, not optional — every accepted/
  // approved scan needs somewhere real to post its StockMovement against.
  async matchReceipt(id: string, data: any, user: any) {
    await assertGateAccessAllowed(this.prisma, user);
    const existing = await this.assertAccess(id, user);
    if (existing.purpose !== 'INBOUND_DELIVERY') throw new BadRequestException('Only Inbound Delivery vehicles can be matched to an order.');
    if (!existing.dockedInAt) throw new BadRequestException('Mark this vehicle Docked In before matching it to an order.');
    if (existing.gateOutAt) throw new BadRequestException('This vehicle has already gated out.');
    if ((existing as any).inboundReceiptId) throw new BadRequestException('This vehicle is already matched to an order.');

    const stagingLocationId = data?.stagingLocationId || undefined;
    if (!stagingLocationId) throw new BadRequestException('A staging location is required — where is this delivery being unloaded to?');

    const [receipt, stagingLocation] = await Promise.all([
      this.prisma.inboundReceipt.findFirst({ where: { vehicleId: (existing as any).vehicleId, gateEntry: null } }),
      this.prisma.location.findUnique({ where: { id: stagingLocationId } }),
    ]);
    if (!receipt) throw new BadRequestException(`No pending order found for vehicle "${(existing as any).vehicle?.vehicleNumber}" — create one first.`);
    if (receipt.warehouseId !== existing.warehouseId) {
      throw new BadRequestException(`Order "${receipt.referenceNo}" for this vehicle was created for a different warehouse.`);
    }
    if (receipt.status === 'RECEIVED' || receipt.status === 'PUTAWAY_COMPLETE') {
      throw new BadRequestException('This order has already been fully received.');
    }
    if (!stagingLocation || stagingLocation.warehouseId !== existing.warehouseId) {
      throw new BadRequestException('Staging location not found for this warehouse.');
    }
    const alreadyClaimed = await this.prisma.vehicleGateEntry.findFirst({ where: { inboundReceiptId: receipt.id } });
    if (alreadyClaimed) throw new BadRequestException('This order has already been matched to a different vehicle.');

    await this.prisma.inboundReceipt.update({ where: { id: receipt.id }, data: { stagingLocationId } });
    const updated = await this.prisma.vehicleGateEntry.update({
      where: { id },
      data: { inboundReceiptId: receipt.id },
      include: GATE_ENTRY_INCLUDE,
    });
    return this.attachNetWeight(updated);
  }

  // Inbound receiving, step 3 — one scan (2026-08-27). Capture is
  // universal: every physical item scanned gets a row, regardless of
  // whether it can be automatically interpreted. Resolution is scoped to
  // THIS receipt's own expected lines, never company-wide barcode
  // uniqueness (a real barcode can legitimately repeat across unrelated
  // SKUs elsewhere — see schema.prisma's comment on SkuBarcode.
  // storageUnitId) — a scan is unambiguous as long as at most one expected,
  // not-yet-fully-received line on this receipt matches it.
  async scan(id: string, barcode: any, user: any) {
    await assertGateAccessAllowed(this.prisma, user);
    const existing = await this.assertAccess(id, user);
    if (!(existing as any).inboundReceiptId) throw new BadRequestException('This vehicle has not been matched to an order yet.');
    if (existing.gateOutAt) throw new BadRequestException('This vehicle has already gated out.');

    const trimmed = barcode != null ? String(barcode).trim() : '';
    if (!trimmed) throw new BadRequestException('A barcode is required.');

    const receiptId = (existing as any).inboundReceiptId as string;
    const [barcodeMatches, receiptLines, receipt] = await Promise.all([
      this.prisma.skuBarcode.findMany({ where: { barcode: trimmed, sku: { companyId: existing.warehouse.companyId } }, include: { storageUnit: true } }),
      this.prisma.inboundReceiptLine.findMany({ where: { receiptId } }),
      this.prisma.inboundReceipt.findUnique({ where: { id: receiptId }, select: { stagingLocationId: true } }),
    ]);
    // Line override first, falling back to the receipt's own staging spot
    // set at Match Order — see schema.prisma's comment on
    // InboundReceipt.stagingLocationId. matchReceipt() requires this to be
    // set, so it's only ever missing here if a receipt somehow got matched
    // before that requirement existed.
    const receiptStagingLocationId = receipt?.stagingLocationId ?? null;

    const candidates = barcodeMatches
      .map((bc) => {
        const line = receiptLines.find((l) => l.skuId === bc.skuId);
        if (!line) return null;
        const qty = bc.storageUnit ? Number(bc.storageUnit.qtyInBaseUom) : 1;
        const remaining = Number(line.expectedQty) - Number(line.receivedQty);
        if (qty > remaining) return null; // would exceed this line's expected qty — blocked, not auto-accepted
        return { skuId: bc.skuId, receiptLineId: line.id, quantity: qty };
      })
      .filter((c): c is { skuId: string; receiptLineId: string; quantity: number } => c !== null);

    if (candidates.length === 1) {
      const c = candidates[0];
      const scan = await this.prisma.$transaction(async (tx) => {
        const created = await tx.inboundReceiptScan.create({
          data: { receiptId, gateEntryId: id, barcodeScanned: trimmed, skuId: c.skuId, receiptLineId: c.receiptLineId, quantity: c.quantity, status: 'ACCEPTED', scannedById: user.userId },
        });
        const line = await tx.inboundReceiptLine.update({ where: { id: c.receiptLineId }, data: { receivedQty: { increment: c.quantity } } });
        const locationId = line.stagingLocationId ?? receiptStagingLocationId;
        if (!locationId) throw new BadRequestException('This order has no staging location set — match it to a dock/staging spot first.');
        await tx.stockMovement.create({
          data: {
            warehouseId: existing.warehouseId,
            skuId: c.skuId,
            locationId,
            quantity: c.quantity,
            movementType: 'RECEIPT',
            referenceType: 'InboundReceiptScan',
            referenceId: created.id,
            createdById: user.userId,
          },
        });
        await this.recomputeReceiptStatus(tx, receiptId);
        return created;
      });
      return scan;
    }

    // Anything else lands here BLOCKED — wrong SKU/exceeds expected qty, a
    // barcode this system can't interpret at all (a composite case/GS1
    // barcode, a unique per-item serial — real parsing of those is
    // explicitly deferred), or a genuine multi-SKU ambiguity within this
    // one receipt (rare — collapsed into the same Supervisor-review path
    // rather than a separate operator-side picker, a deliberate v1
    // simplification). The operator who scanned it can never resolve their
    // own blocked scan — only a Supervisor can, via approveScan/rejectScan
    // in InboundReceiptsService.
    let blockReason = 'Unrecognized barcode — not on this order.';
    if (barcodeMatches.length > 0 && candidates.length === 0) blockReason = 'SKU not expected on this order, or already fully received.';
    else if (candidates.length > 1) blockReason = 'Barcode matches more than one SKU on this order — needs manual resolution.';

    return this.prisma.inboundReceiptScan.create({
      data: { receiptId, gateEntryId: id, barcodeScanned: trimmed, status: 'BLOCKED', blockReason, scannedById: user.userId },
    });
  }

  // Shared with InboundReceiptsService's approve/reject actions — kept as a
  // small duplicated helper rather than a cross-module call, matching this
  // codebase's "each module queries Prisma directly" convention (the one
  // exception, NotificationsService, was made because duplicating a whole
  // send/adapter/audit pipeline was a much bigger cost than this one query).
  async recomputeReceiptStatus(tx: any, receiptId: string) {
    const lines = await tx.inboundReceiptLine.findMany({ where: { receiptId } });
    const allReceived = lines.length > 0 && lines.every((l: any) => Number(l.receivedQty) >= Number(l.expectedQty));
    const anyReceived = lines.some((l: any) => Number(l.receivedQty) > 0);
    const status = allReceived ? 'RECEIVED' : anyReceived ? 'PARTIALLY_RECEIVED' : 'PENDING';
    await tx.inboundReceipt.update({ where: { id: receiptId }, data: { status } });
  }

  // "Complete Inward Process" (2026-08-27) — a deliberate human close-out,
  // distinct from the matched order simply reaching RECEIVED status. A real
  // gap the client caught testing the flow themselves: reaching RECEIVED
  // was auto-unlocking Gate Out with no explicit sign-off. Only enabled
  // once every expected line is actually fully received; captures an
  // optional remarks note. gateOut() now requires this to be set for
  // Inbound, not just the receipt's own status — see schema.prisma's
  // comment on inwardCompletedAt.
  async completeInward(id: string, remarks: any, user: any) {
    await assertGateAccessAllowed(this.prisma, user);
    const existing = await this.assertAccess(id, user);
    if (existing.purpose !== 'INBOUND_DELIVERY') throw new BadRequestException('Only Inbound Delivery vehicles have an inward process to complete.');
    if (!(existing as any).inboundReceiptId) throw new BadRequestException('This vehicle has not been matched to an order yet.');
    if (existing.gateOutAt) throw new BadRequestException('This vehicle has already gated out.');
    if ((existing as any).inwardCompletedAt) throw new BadRequestException('The inward process has already been completed for this vehicle.');

    const receipt = await this.prisma.inboundReceipt.findUnique({ where: { id: (existing as any).inboundReceiptId }, select: { status: true } });
    if (receipt?.status !== 'RECEIVED' && receipt?.status !== 'PUTAWAY_COMPLETE') {
      throw new BadRequestException('This order has not been fully received yet — every expected SKU/quantity must be scanned (or supervisor-approved) first.');
    }

    const updated = await this.prisma.vehicleGateEntry.update({
      where: { id },
      data: {
        inwardCompletedAt: new Date(),
        inwardCompletedBy: { connect: { id: user.userId } },
        inwardCompletionRemarks: remarks ? String(remarks).trim() : undefined,
      },
      include: GATE_ENTRY_INCLUDE,
    });
    return this.attachNetWeight(updated);
  }

  // "Which dock does the driver go to" (2026-08-27) — a Security Supervisor
  // types in the dock number they've been told (the output of the future
  // Dock Scheduler, standing in for it manually for now — see
  // schema.prisma's comment on assignedDockNumber). Setting or CHANGING it
  // always re-fires the driver notification and resets the warning timer
  // — a stale "Dock 2" message sitting uncorrected after a reassignment to
  // "Dock 5" would be worse than one extra call. Allowed any time before
  // Gate Out, including after Docked In (a re-route while still on-site is
  // plausible), unlike dockIn()/gateOut() which are strict one-way gates.
  async assignDock(id: string, dockNumber: any, user: any) {
    await assertGateAccessAllowed(this.prisma, user);
    const existing = await this.assertAccess(id, user);
    if (existing.gateOutAt) throw new BadRequestException('This vehicle has already gated out.');

    const trimmed = dockNumber != null ? String(dockNumber).trim() : '';
    if (!trimmed) throw new BadRequestException('Dock Number is required.');

    const updated = await this.prisma.vehicleGateEntry.update({
      where: { id },
      data: { assignedDockNumber: trimmed, dockAssignedAt: new Date() },
      include: GATE_ENTRY_INCLUDE,
    });

    await this.driverNotifications.sendDockAssignment({
      gateEntryId: id,
      dockNumber: trimmed,
      vehicleNumber: updated.vehicle.vehicleNumber,
      driverPhone: updated.driver.phone,
      stage: 'INITIAL',
    });

    return this.attachNetWeight(updated);
  }

  // Closes the visit. What's required to close depends on purpose (2026-08-25
  // design conversation — see CLAUDE.md):
  //  - OUTBOUND_DISPATCH: an E-Way Bill number, but only if this company has
  //    opted into requiring it (Company.requireEwayBillForOutboundGateOut) —
  //    not every client routes E-Way Bill data through this system. ALSO an
  //    overweight check (2026-08-27, the client's own KPI, not toggleable) —
  //    see invoiceWeightKg below.
  //  - INBOUND_DELIVERY: a plain manual "all material received" confirmation
  //    — a placeholder until real Inbound/Receiving exists to drive this
  //    automatically.
  //  - RETURNS: neither requirement applies (not yet raised as a real need).
  async gateOut(id: string, data: any, user: any) {
    await assertGateAccessAllowed(this.prisma, user);
    const existing = await this.assertAccess(id, user);
    if (existing.gateOutAt) throw new BadRequestException('This vehicle has already gated out.');

    const errors: string[] = [];

    let tareWeightKg: number | undefined;
    if (data?.tareWeightKg !== undefined && data.tareWeightKg !== null && data.tareWeightKg !== '') {
      tareWeightKg = Number(data.tareWeightKg);
      if (!Number.isFinite(tareWeightKg) || tareWeightKg <= 0) errors.push('Tare Weight must be a positive number.');
    }

    const eWayBillNo = data?.eWayBillNo !== undefined ? String(data.eWayBillNo).trim() || undefined : undefined;
    const materialReceivedConfirmed = !!data?.materialReceivedConfirmed;

    // Seal number/signature — Outbound only lands here (Inbound captures it
    // at Dock In instead, see dockIn() above). Optional either way.
    const sealNumber = data?.sealNumber ? String(data.sealNumber).trim() : undefined;
    const sealSignatureData = data?.sealSignatureData ? String(data.sealSignatureData) : undefined;
    const sealCaptured = sealNumber !== undefined || sealSignatureData !== undefined;

    let invoiceWeightKg: number | undefined;
    if (data?.invoiceWeightKg !== undefined && data.invoiceWeightKg !== null && data.invoiceWeightKg !== '') {
      invoiceWeightKg = Number(data.invoiceWeightKg);
      if (!Number.isFinite(invoiceWeightKg) || invoiceWeightKg <= 0) errors.push('Invoice Weight must be a positive number.');
    }

    if (existing.purpose === 'OUTBOUND_DISPATCH') {
      const company = await this.prisma.company.findUnique({ where: { id: existing.warehouse.companyId } });
      if (company?.requireEwayBillForOutboundGateOut && !eWayBillNo) {
        errors.push('An E-Way Bill number is required before this vehicle can gate out.');
      }
      // Overweight check — the client's own KPI, always on for Outbound (not
      // a per-company toggle like the E-Way Bill requirement above). Real
      // total should eventually be SUM(orderLine.orderedQty * sku.grossWeight)
      // once Outbound exists; invoiceWeightKg is a manual placeholder for
      // that number until then — see schema.prisma's comment on the field.
      // Compares against Vehicle.maxTonnage, falling back to VehicleType's
      // generic ceiling when no per-vehicle override was registered.
      if (invoiceWeightKg === undefined) {
        errors.push('Invoice Weight is required before an Outbound vehicle can gate out.');
      } else if (errors.length === 0) {
        const maxTonnage = existing.vehicle.maxTonnage ?? existing.vehicle.vehicleType.maxTonnage;
        const maxWeightKg = Number(maxTonnage) * 1000;
        if (invoiceWeightKg > maxWeightKg) {
          errors.push(
            `This vehicle is OVERWEIGHT — invoice weight ${invoiceWeightKg} kg exceeds "${existing.vehicle.vehicleNumber}"'s registered max capacity of ${maxWeightKg} kg (${maxTonnage} Ton). Gate Out is blocked.`,
          );
        }
      }
    } else if (existing.purpose === 'INBOUND_DELIVERY') {
      // Real receiving replaces the manual checkbox once a receipt is
      // actually matched (2026-08-27) — the checkbox stays as a fallback
      // for an Inbound entry that never went through the order-maker/scan
      // flow at all (e.g. a company not using it yet), so this doesn't
      // regress anything for entries with no inboundReceiptId.
      //
      // Requires the deliberate "Complete Inward Process" sign-off, not
      // just the receipt reaching RECEIVED (2026-08-27, a real gap the
      // client caught — reaching RECEIVED alone used to auto-unlock this
      // with no explicit close-out step). See completeInward()'s comment.
      const receiptId = (existing as any).inboundReceiptId as string | null;
      if (receiptId) {
        if (!(existing as any).inwardCompletedAt) {
          errors.push('Complete the inward process (on Inbound Orders) before this vehicle can gate out.');
        }
      } else if (!materialReceivedConfirmed) {
        errors.push('Confirm that all material has been received/scanned before this vehicle can gate out.');
      }
    }

    if (errors.length > 0) throw new BadRequestException(errors);

    const updated = await this.prisma.$transaction(async (tx) => {
      const entry = await tx.vehicleGateEntry.update({
        where: { id },
        data: {
          gateOutAt: new Date(),
          gateOutBy: { connect: { id: user.userId } },
          tareWeightKg,
          tareWeighedAt: tareWeightKg !== undefined ? new Date() : undefined,
          eWayBillNo,
          eWayBillGeneratedAt: eWayBillNo !== undefined ? new Date() : undefined,
          materialReceivedConfirmed,
          invoiceWeightKg,
          sealNumber,
          sealSignatureData,
          sealCapturedAt: sealCaptured ? new Date() : undefined,
          sealCapturedBy: sealCaptured ? { connect: { id: user.userId } } : undefined,
        },
        include: GATE_ENTRY_INCLUDE,
      });
      // Safety net: a vehicle that never got marked "Docked In" (e.g. loaded/
      // unloaded straight from the yard, or an operator just forgot the
      // step) must still free its slot once it's actually gone — otherwise
      // the slot leaks as permanently occupied. If dockIn() already ran,
      // the slot is already AVAILABLE and this is a harmless no-op.
      if (existing.yardSlotId) {
        await tx.yardSlot.update({ where: { id: existing.yardSlotId }, data: { status: 'AVAILABLE' } });
      }
      return entry;
    });

    return this.attachNetWeight(updated);
  }
}
