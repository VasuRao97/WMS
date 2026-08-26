import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { normalizeCode } from '../common/normalize.util';
import { assertGateAccessAllowed, companyFilter, ownWarehouseIds, GATE_YARD_SCOPED_ROLES } from '../common/tenant.util';

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
  documentChecks: true,
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
  constructor(private prisma: PrismaService) {}

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

    return { ...this.attachNetWeight(created), yardFullWarning: yardResult.yardFullWarning };
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
      'Yard Slot': e.yardSlot?.code || '',
      'Docked In At': e.dockedInAt ? e.dockedInAt.toISOString() : '',
      'Docked In By': e.dockedInBy?.name || '',
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
  async dockIn(id: string, user: any) {
    await assertGateAccessAllowed(this.prisma, user);
    const existing = await this.assertAccess(id, user);
    if (existing.dockedInAt) throw new BadRequestException('This vehicle has already been marked docked in.');
    if (existing.gateOutAt) throw new BadRequestException('This vehicle has already gated out.');

    const updated = await this.prisma.$transaction(async (tx) => {
      const entry = await tx.vehicleGateEntry.update({
        where: { id },
        data: { dockedInAt: new Date(), dockedInBy: { connect: { id: user.userId } } },
        include: GATE_ENTRY_INCLUDE,
      });
      if (existing.yardSlotId) {
        await tx.yardSlot.update({ where: { id: existing.yardSlotId }, data: { status: 'AVAILABLE' } });
      }
      return entry;
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
      if (!materialReceivedConfirmed) {
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
