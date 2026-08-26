import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { assertGateAccessAllowed, companyFilter } from '../common/tenant.util';
import { toNumberOrUndefined } from '../common/xlsx-parse.util';

// Registered vehicle master — see schema.prisma's comment on the Vehicle
// model for the full "register once, reuse" reasoning (2026-08-25 design
// conversation). Company-scoped, not warehouse-scoped — a vehicle can visit
// any of a company's warehouses, so every operational role in that company
// can see/register one (gated via GATE_YARD_* roles in the controller, not
// MASTER_DATA_* — this is closer to Gate Entry's own access shape than to
// Warehouse/Customer's).
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

  async create(data: any, user: any) {
    await assertGateAccessAllowed(this.prisma, user);
    if (!user.companyId) {
      throw new ForbiddenException('Super admin accounts cannot register vehicles directly — log in as a company admin instead.');
    }
    const errors: string[] = [];
    const vehicleNumber = this.validate(data, errors);
    await this.assertVehicleType(data.vehicleTypeId, errors);
    if (errors.length > 0) throw new BadRequestException(errors);

    const existing = await this.prisma.vehicle.findUnique({
      where: { companyId_vehicleNumber: { companyId: user.companyId, vehicleNumber } },
    });
    if (existing) throw new BadRequestException(`Vehicle Number "${vehicleNumber}" is already registered.`);

    return this.prisma.vehicle.create({
      data: {
        company: { connect: { id: user.companyId } },
        vehicleNumber,
        vehicleType: { connect: { id: data.vehicleTypeId } },
        lengthFt: toNumberOrUndefined(data.lengthFt),
        widthFt: toNumberOrUndefined(data.widthFt),
        heightFt: toNumberOrUndefined(data.heightFt),
        maxTonnage: toNumberOrUndefined(data.maxTonnage),
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
      include: { vehicleType: { select: { id: true, name: true, segment: true, maxTonnage: true } } },
    });
  }

  async findAll(user: any) {
    await assertGateAccessAllowed(this.prisma, user);
    return this.prisma.vehicle.findMany({
      where: companyFilter(user),
      include: { vehicleType: { select: { id: true, name: true, segment: true, maxTonnage: true } } },
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
      'Vehicle Type': v.vehicleType.name,
      'Segment': v.vehicleType.segment,
      'Max Capacity (Ton)': v.maxTonnage ?? v.vehicleType.maxTonnage,
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

  private async assertAccess(id: string, user: any) {
    const vehicle = await this.prisma.vehicle.findUnique({ where: { id } });
    if (!vehicle) throw new NotFoundException('Vehicle not found.');
    if (user.role !== 'SUPER_ADMIN' && vehicle.companyId !== user.companyId) {
      throw new ForbiddenException('You do not have access to this vehicle.');
    }
    return vehicle;
  }

  async update(id: string, data: any, user: any) {
    await assertGateAccessAllowed(this.prisma, user);
    const existingVehicle = await this.assertAccess(id, user);
    const errors: string[] = [];
    const vehicleNumber = this.validate(data, errors);
    await this.assertVehicleType(data.vehicleTypeId, errors);
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
        lengthFt: toNumberOrUndefined(data.lengthFt) ?? null,
        widthFt: toNumberOrUndefined(data.widthFt) ?? null,
        heightFt: toNumberOrUndefined(data.heightFt) ?? null,
        maxTonnage: toNumberOrUndefined(data.maxTonnage) ?? null,
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
      include: { vehicleType: { select: { id: true, name: true, segment: true, maxTonnage: true } } },
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
      select: { id: true, vehicleNumber: true, _count: { select: { gateEntries: true } } },
    });
    const deletable = vehicles.filter((v) => v._count.gateEntries === 0).map((v) => v.id);
    const blocked = vehicles.filter((v) => v._count.gateEntries > 0).map((v) => v.vehicleNumber);
    if (deletable.length > 0) await this.prisma.vehicle.deleteMany({ where: { id: { in: deletable } } });
    return { deletedCount: deletable.length, blockedCount: blocked.length, blockedCodes: blocked };
  }

  async remove(id: string, user: any) {
    await assertGateAccessAllowed(this.prisma, user);
    const vehicle = await this.assertAccess(id, user);
    const count = await this.prisma.vehicleGateEntry.count({ where: { vehicleId: id } });
    if (count > 0) {
      throw new BadRequestException(`Cannot permanently delete "${vehicle.vehicleNumber}" — it has ${count} linked gate entry record(s). Deactivate it instead.`);
    }
    await this.prisma.vehicle.delete({ where: { id } });
    return { deleted: true, code: vehicle.vehicleNumber };
  }
}
