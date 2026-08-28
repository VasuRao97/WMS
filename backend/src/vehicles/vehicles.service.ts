import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { assertGateAccessAllowed, companyFilter, gateYardAccessibleWarehouseIds, ownWarehouseIds, GATE_YARD_SCOPED_ROLES } from '../common/tenant.util';
import { toNumberOrUndefined } from '../common/xlsx-parse.util';

// Registered vehicle master — see schema.prisma's comment on the Vehicle
// model for the full "register once, reuse" reasoning (2026-08-25 design
// conversation). Was company-scoped, not warehouse-scoped, until 2026-08-28
// — REVERSED per the client's own real reason: different warehouses under
// one company can be run by different 3PLs, so one 3PL's fleet showing up
// to another's staff is a genuine privacy leak, not just noise ("TN08 only
// should see it"). Now warehouse-scoped the same way Warehouse/Customer/User
// already are for Manager/Supervisor (GATE_YARD_SCOPED_ROLES here, since
// registration/edit is still gated by GATE_YARD_* roles, not MASTER_DATA_*).
@Injectable()
export class VehiclesService {
  private toDate(v: any): Date | undefined {
    if (v === undefined || v === null || v === '') return undefined;
    const d = new Date(v);
    return isNaN(d.getTime()) ? undefined : d;
  }

  constructor(private prisma: PrismaService) {}

  private validate(data: any, errors: string[]) {
    const vehicleNumber = data.vehicleNumber ? String(data.vehicleNumber).trim().toUpperCase() : '';
    if (!vehicleNumber) errors.push('Vehicle Number is required.');

    if (!data.vehicleTypeId) errors.push('Vehicle Type is required.');

    for (const [field, label] of [
      ['lengthFt', 'Length'],
      ['widthFt', 'Width'],
      ['heightFt', 'Height'],
      ['maxTonnage', 'Max Capacity'],
      ['detentionCostPerDay', 'Detention Cost Per Day'],
    ] as const) {
      const v = data[field];
      if (v !== undefined && v !== null && v !== '' && Number(v) <= 0) errors.push(`${label} must be a positive number when given.`);
    }

    if (data.isBlacklisted && !data.blacklistReason?.trim()) {
      errors.push('Blacklist Reason is required when marking a vehicle blacklisted.');
    }

    return vehicleNumber;
  }

  private async assertVehicleType(vehicleTypeId: string, errors: string[]) {
    if (!vehicleTypeId) return;
    const vt = await this.prisma.vehicleType.findUnique({ where: { id: vehicleTypeId } });
    if (!vt) errors.push('Vehicle Type not found.');
  }

  // Resolves + validates the home warehouse (2026-08-28) — required on
  // every new registration going forward (captured from the Gate In form's
  // already-selected warehouse, no extra picker needed). A scoped role can
  // only register/reassign to a warehouse they themselves have access to,
  // same check every other warehouse-scoped write in this codebase runs.
  private async resolveWarehouseId(warehouseId: any, user: any, errors: string[]): Promise<string | undefined> {
    if (!warehouseId) {
      errors.push('Warehouse is required.');
      return undefined;
    }
    const warehouse = await this.prisma.warehouse.findUnique({ where: { id: warehouseId } });
    if (!warehouse || (user.role !== 'SUPER_ADMIN' && warehouse.companyId !== user.companyId)) {
      errors.push('Warehouse not found.');
      return undefined;
    }
    if (GATE_YARD_SCOPED_ROLES.includes(user.role)) {
      const ids = await ownWarehouseIds(this.prisma, user.userId);
      if (!ids.includes(warehouseId)) {
        errors.push('You can only register a vehicle to your own assigned warehouse(s).');
        return undefined;
      }
    }
    return warehouseId;
  }

  async create(data: any, user: any) {
    await assertGateAccessAllowed(this.prisma, user);
    if (!user.companyId) {
      throw new ForbiddenException('Super admin accounts cannot register vehicles directly — log in as a company admin instead.');
    }
    const errors: string[] = [];
    const vehicleNumber = this.validate(data, errors);
    await this.assertVehicleType(data.vehicleTypeId, errors);
    const warehouseId = await this.resolveWarehouseId(data.warehouseId, user, errors);
    if (errors.length > 0) throw new BadRequestException(errors);

    const existing = await this.prisma.vehicle.findUnique({
      where: { companyId_vehicleNumber: { companyId: user.companyId, vehicleNumber } },
    });
    if (existing) throw new BadRequestException(`Vehicle Number "${vehicleNumber}" is already registered.`);

    return this.prisma.vehicle.create({
      data: {
        company: { connect: { id: user.companyId } },
        warehouse: { connect: { id: warehouseId! } },
        vehicleNumber,
        vehicleType: { connect: { id: data.vehicleTypeId } },
        lengthFt: toNumberOrUndefined(data.lengthFt),
        widthFt: toNumberOrUndefined(data.widthFt),
        heightFt: toNumberOrUndefined(data.heightFt),
        maxTonnage: toNumberOrUndefined(data.maxTonnage),
        detentionCostPerDay: toNumberOrUndefined(data.detentionCostPerDay),
        rcNumber: data.rcNumber || undefined,
        rcExpiry: this.toDate(data.rcExpiry),
        insuranceNumber: data.insuranceNumber || undefined,
        insuranceExpiry: this.toDate(data.insuranceExpiry),
        pucNumber: data.pucNumber || undefined,
        pucExpiry: this.toDate(data.pucExpiry),
        fitnessNumber: data.fitnessNumber || undefined,
        fitnessExpiry: this.toDate(data.fitnessExpiry),
        isBlacklisted: !!data.isBlacklisted,
        blacklistReason: data.isBlacklisted ? String(data.blacklistReason).trim() : undefined,
      },
      include: { vehicleType: { select: { id: true, name: true, segment: true, maxTonnage: true, detentionCostPerDay: true } } },
    });
  }

  // warehouseId (2026-08-28) — an explicit filter (e.g. the Gate In form's
  // own selected warehouse) is checked against the caller's own accessible
  // set before being trusted, same real-bug-class fix YardService.tracker()
  // already had to make (a scoped role could otherwise pass a DIFFERENT
  // warehouse's id and bypass their own restriction entirely). No explicit
  // id → falls back to the caller's own full accessible set (every
  // warehouse for Admin, only assignedWarehouses for a scoped role) — same
  // shape as every other warehouse-scoped findAll in this codebase. A
  // warehouseId: null row (pre-2026-08-28 legacy data) is only ever visible
  // to Admin/SuperAdmin — the conservative default, not a fallback to
  // full visibility, same as Customer's own no-ship-to case.
  async findAll(user: any, warehouseId?: string) {
    await assertGateAccessAllowed(this.prisma, user);
    const accessibleIds = await gateYardAccessibleWarehouseIds(this.prisma, user);
    if (warehouseId && accessibleIds && !accessibleIds.includes(warehouseId)) {
      throw new ForbiddenException('You do not have access to this warehouse.');
    }
    const where: any = { ...companyFilter(user) };
    if (warehouseId) where.warehouseId = warehouseId;
    else if (accessibleIds) where.warehouseId = { in: accessibleIds };
    return this.prisma.vehicle.findMany({
      where,
      include: {
        vehicleType: { select: { id: true, name: true, segment: true, maxTonnage: true, detentionCostPerDay: true } },
        warehouse: { select: { id: true, code: true, name: true } },
      },
      orderBy: { vehicleNumber: 'asc' },
    });
  }

  // Export only — no bulk import for Vehicle/Driver (deliberate, 2026-08-27
  // Vehicle & Driver Master pass: registration is a one-time-per-vehicle
  // manual step via Gate & Yard's Register modal, not a batch-onboarding
  // scenario the way Users/SKUs are).
  async exportRows(user: any) {
    const vehicles = await this.findAll(user);
    return vehicles.map((v) => ({
      'Vehicle Number': v.vehicleNumber,
      'Warehouse': (v as any).warehouse?.code ?? '',
      'Vehicle Type': v.vehicleType.name,
      'Segment': v.vehicleType.segment,
      'Max Capacity (Ton)': v.maxTonnage ?? v.vehicleType.maxTonnage,
      'Detention Cost/Day (₹)': v.detentionCostPerDay ?? v.vehicleType.detentionCostPerDay ?? '',
      'Length (ft)': v.lengthFt ?? '',
      'Width (ft)': v.widthFt ?? '',
      'Height (ft)': v.heightFt ?? '',
      'RC Number': v.rcNumber ?? '',
      'RC Expiry': v.rcExpiry ? v.rcExpiry.toISOString().slice(0, 10) : '',
      'Insurance Number': v.insuranceNumber ?? '',
      'Insurance Expiry': v.insuranceExpiry ? v.insuranceExpiry.toISOString().slice(0, 10) : '',
      'PUC Number': v.pucNumber ?? '',
      'PUC Expiry': v.pucExpiry ? v.pucExpiry.toISOString().slice(0, 10) : '',
      'Fitness Number': v.fitnessNumber ?? '',
      'Fitness Expiry': v.fitnessExpiry ? v.fitnessExpiry.toISOString().slice(0, 10) : '',
      'Blacklisted': v.isBlacklisted ? 'TRUE' : 'FALSE',
      'Blacklist Reason': v.blacklistReason ?? '',
      'Active': v.isActive ? 'TRUE' : 'FALSE',
    }));
  }

  // Warehouse-scoped 2026-08-28 (same pattern as DockDoorsService.
  // assertAccess) — a scoped role can't reach a vehicle outside their own
  // warehouse(s) just by knowing its id, even though findAll() already
  // wouldn't have listed it. A null-warehouse legacy row is inaccessible to
  // a scoped role until an Admin assigns it one.
  private async assertAccess(id: string, user: any) {
    const vehicle = await this.prisma.vehicle.findUnique({ where: { id } });
    if (!vehicle) throw new NotFoundException('Vehicle not found.');
    if (user.role !== 'SUPER_ADMIN' && vehicle.companyId !== user.companyId) {
      throw new ForbiddenException('You do not have access to this vehicle.');
    }
    if (GATE_YARD_SCOPED_ROLES.includes(user.role)) {
      const ids = await ownWarehouseIds(this.prisma, user.userId);
      if (!vehicle.warehouseId || !ids.includes(vehicle.warehouseId)) {
        throw new ForbiddenException('You do not have access to this vehicle.');
      }
    }
    return vehicle;
  }

  async update(id: string, data: any, user: any) {
    await assertGateAccessAllowed(this.prisma, user);
    const existingVehicle = await this.assertAccess(id, user);
    const errors: string[] = [];
    const vehicleNumber = this.validate(data, errors);
    await this.assertVehicleType(data.vehicleTypeId, errors);
    // Also required on edit, same as create — this is deliberately the
    // fix path for a pre-2026-08-28 legacy row with no warehouse at all
    // (assertAccess above already lets an Admin reach it regardless).
    const warehouseId = await this.resolveWarehouseId(data.warehouseId, user, errors);
    if (errors.length > 0) throw new BadRequestException(errors);

    const duplicate = await this.prisma.vehicle.findUnique({
      where: { companyId_vehicleNumber: { companyId: existingVehicle.companyId, vehicleNumber } },
    });
    if (duplicate && duplicate.id !== id) throw new BadRequestException(`Vehicle Number "${vehicleNumber}" is already registered.`);

    return this.prisma.vehicle.update({
      where: { id },
      data: {
        vehicleNumber,
        vehicleType: { connect: { id: data.vehicleTypeId } },
        warehouse: { connect: { id: warehouseId! } },
        lengthFt: toNumberOrUndefined(data.lengthFt) ?? null,
        widthFt: toNumberOrUndefined(data.widthFt) ?? null,
        heightFt: toNumberOrUndefined(data.heightFt) ?? null,
        maxTonnage: toNumberOrUndefined(data.maxTonnage) ?? null,
        detentionCostPerDay: toNumberOrUndefined(data.detentionCostPerDay) ?? null,
        rcNumber: data.rcNumber || null,
        rcExpiry: this.toDate(data.rcExpiry) ?? null,
        insuranceNumber: data.insuranceNumber || null,
        insuranceExpiry: this.toDate(data.insuranceExpiry) ?? null,
        pucNumber: data.pucNumber || null,
        pucExpiry: this.toDate(data.pucExpiry) ?? null,
        fitnessNumber: data.fitnessNumber || null,
        fitnessExpiry: this.toDate(data.fitnessExpiry) ?? null,
        isBlacklisted: !!data.isBlacklisted,
        blacklistReason: data.isBlacklisted ? String(data.blacklistReason).trim() : null,
      },
      include: { vehicleType: { select: { id: true, name: true, segment: true, maxTonnage: true, detentionCostPerDay: true } } },
    });
  }

  async deactivate(id: string, user: any) {
    await assertGateAccessAllowed(this.prisma, user);
    await this.assertAccess(id, user);
    return this.prisma.vehicle.update({ where: { id }, data: { isActive: false } });
  }

  async reactivate(id: string, user: any) {
    await assertGateAccessAllowed(this.prisma, user);
    await this.assertAccess(id, user);
    return this.prisma.vehicle.update({ where: { id }, data: { isActive: true } });
  }

  async removeAll(user: any) {
    await assertGateAccessAllowed(this.prisma, user);
    const vehicles = await this.prisma.vehicle.findMany({
      where: companyFilter(user),
      // inboundReceipts added 2026-08-27 (the vehicle<->order 1:1 mapping
      // follow-up) — a real lesson this codebase already learned once with
      // Warehouse's own removeAll/remove (see CLAUDE.md's "Every master-data
      // entity gets a Delete All"): a new relation must be added to an
      // existing entity's blocking check by hand, it doesn't happen
      // automatically just because the FK exists. Without this, a Vehicle
      // named on an order but with zero gate entries would be wrongly
      // reported deletable, then hit Postgres's real FK constraint as an
      // unhandled 500 instead of a graceful "blocked" result.
      select: { id: true, vehicleNumber: true, _count: { select: { gateEntries: true, inboundReceipts: true } } },
    });
    const deletable = vehicles.filter((v) => v._count.gateEntries === 0 && v._count.inboundReceipts === 0).map((v) => v.id);
    const blocked = vehicles.filter((v) => v._count.gateEntries > 0 || v._count.inboundReceipts > 0).map((v) => v.vehicleNumber);
    if (deletable.length > 0) await this.prisma.vehicle.deleteMany({ where: { id: { in: deletable } } });
    return { deletedCount: deletable.length, blockedCount: blocked.length, blockedCodes: blocked };
  }

  async remove(id: string, user: any) {
    await assertGateAccessAllowed(this.prisma, user);
    const vehicle = await this.assertAccess(id, user);
    const [gateEntryCount, receiptCount] = await Promise.all([
      this.prisma.vehicleGateEntry.count({ where: { vehicleId: id } }),
      this.prisma.inboundReceipt.count({ where: { vehicleId: id } }),
    ]);
    if (gateEntryCount > 0 || receiptCount > 0) {
      const parts = [gateEntryCount > 0 ? `${gateEntryCount} linked gate entry record(s)` : null, receiptCount > 0 ? `${receiptCount} linked inbound order(s)` : null].filter(Boolean);
      throw new BadRequestException(`Cannot permanently delete "${vehicle.vehicleNumber}" — it has ${parts.join(' and ')}. Deactivate it instead.`);
    }
    await this.prisma.vehicle.delete({ where: { id } });
    return { deleted: true, code: vehicle.vehicleNumber };
  }
}
