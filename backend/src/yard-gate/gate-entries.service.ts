import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { normalizeCode } from '../common/normalize.util';
import { companyFilter, ownWarehouseIds, GATE_YARD_SCOPED_ROLES } from '../common/tenant.util';

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
  vehicle: { select: { id: true, vehicleNumber: true, vehicleType: { select: { id: true, name: true, segment: true, maxTonnage: true } } } },
  driver: { select: { id: true, name: true, phone: true } },
  gateInBy: { select: { id: true, name: true } },
  gateOutBy: { select: { id: true, name: true } },
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

  async create(data: any, user: any) {
    if (!user.companyId) {
      throw new ForbiddenException('Super admin accounts cannot log gate entries directly — log in as a company admin instead.');
    }
    const errors: string[] = [];
    const warehouseId = data.warehouseId;
    if (!warehouseId) errors.push('Warehouse is required.');
    else await this.assertWarehouseAccess(warehouseId, user, errors);

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

    if (errors.length > 0) throw new BadRequestException(errors);

    const created = await this.prisma.vehicleGateEntry.create({
      data: {
        warehouse: { connect: { id: warehouseId } },
        vehicle: { connect: { id: vehicleId } },
        driver: { connect: { id: driverId } },
        transporterName: data.transporterName ? String(data.transporterName).trim() : undefined,
        purpose: purpose as any,
        referenceNo: data.referenceNo ? String(data.referenceNo).trim() : undefined,
        gateInBy: { connect: { id: user.userId } },
        grossWeightKg: grossWeightKg,
        grossWeighedAt: grossWeightKg !== undefined ? new Date() : undefined,
        documentChecks: documentChecks.length
          ? { create: documentChecks.map((d) => ({ documentType: d.documentType as any, status: d.status as any, note: d.note })) }
          : undefined,
      },
      include: GATE_ENTRY_INCLUDE,
    });

    return this.attachNetWeight(created);
  }

  async findAll(user: any) {
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

  private async assertAccess(id: string, user: any) {
    const entry = await this.prisma.vehicleGateEntry.findUnique({ where: { id }, include: { warehouse: true } });
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
      },
      include: GATE_ENTRY_INCLUDE,
    });

    return this.attachNetWeight(updated);
  }

  // Closes the visit. What's required to close depends on purpose (2026-08-25
  // design conversation — see CLAUDE.md):
  //  - OUTBOUND_DISPATCH: an E-Way Bill number, but only if this company has
  //    opted into requiring it (Company.requireEwayBillForOutboundGateOut) —
  //    not every client routes E-Way Bill data through this system.
  //  - INBOUND_DELIVERY: a plain manual "all material received" confirmation
  //    — a placeholder until real Inbound/Receiving exists to drive this
  //    automatically.
  //  - RETURNS / VEHICLE_ONLY: neither requirement applies (not yet raised
  //    as a real need for these purposes).
  async gateOut(id: string, data: any, user: any) {
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

    if (existing.purpose === 'OUTBOUND_DISPATCH') {
      const company = await this.prisma.company.findUnique({ where: { id: existing.warehouse.companyId } });
      if (company?.requireEwayBillForOutboundGateOut && !eWayBillNo) {
        errors.push('An E-Way Bill number is required before this vehicle can gate out.');
      }
    } else if (existing.purpose === 'INBOUND_DELIVERY') {
      if (!materialReceivedConfirmed) {
        errors.push('Confirm that all material has been received/scanned before this vehicle can gate out.');
      }
    }

    if (errors.length > 0) throw new BadRequestException(errors);

    const updated = await this.prisma.vehicleGateEntry.update({
      where: { id },
      data: {
        gateOutAt: new Date(),
        gateOutBy: { connect: { id: user.userId } },
        tareWeightKg,
        tareWeighedAt: tareWeightKg !== undefined ? new Date() : undefined,
        eWayBillNo,
        eWayBillGeneratedAt: eWayBillNo !== undefined ? new Date() : undefined,
        materialReceivedConfirmed,
      },
      include: GATE_ENTRY_INCLUDE,
    });

    return this.attachNetWeight(updated);
  }
}
