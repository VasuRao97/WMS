import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { assertGateAccessAllowed, companyFilter, gateYardAccessibleWarehouseIds, ownWarehouseIds, GATE_YARD_SCOPED_ROLES } from '../common/tenant.util';

// Registered driver master — see schema.prisma's comment on the Driver
// model. Was company-scoped like Vehicle, not warehouse-scoped, until
// 2026-08-28 — see VehiclesService's file comment for the full reasoning
// (data privacy between different warehouses' 3PLs); same warehouse
// scoping shape mirrored here. No unique constraint on phone/licenseNumber
// (deliberate — see schema comment), so no duplicate-detection here beyond
// what the operator notices themselves.
@Injectable()
export class DriversService {
  private toDate(v: any): Date | undefined {
    if (v === undefined || v === null || v === '') return undefined;
    const d = new Date(v);
    return isNaN(d.getTime()) ? undefined : d;
  }

  constructor(private prisma: PrismaService) {}

  private validate(data: any, errors: string[]) {
    if (!data.name || !String(data.name).trim()) errors.push('Name is required.');
    if (data.isBlacklisted && !data.blacklistReason?.trim()) {
      errors.push('Blacklist Reason is required when marking a driver blacklisted.');
    }
  }

  // Same shape as VehiclesService.resolveWarehouseId — required on every
  // new registration/edit, a scoped role can only assign within their own
  // accessible warehouse(s).
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
        errors.push('You can only register a driver to your own assigned warehouse(s).');
        return undefined;
      }
    }
    return warehouseId;
  }

  async create(data: any, user: any) {
    await assertGateAccessAllowed(this.prisma, user);
    if (!user.companyId) {
      throw new ForbiddenException('Super admin accounts cannot register drivers directly — log in as a company admin instead.');
    }
    const errors: string[] = [];
    this.validate(data, errors);
    const warehouseId = await this.resolveWarehouseId(data.warehouseId, user, errors);
    if (errors.length > 0) throw new BadRequestException(errors);

    return this.prisma.driver.create({
      data: {
        company: { connect: { id: user.companyId } },
        warehouse: { connect: { id: warehouseId! } },
        name: String(data.name).trim(),
        phone: data.phone ? String(data.phone).trim() : undefined,
        licenseNumber: data.licenseNumber ? String(data.licenseNumber).trim() : undefined,
        licenseExpiry: this.toDate(data.licenseExpiry),
        isBlacklisted: !!data.isBlacklisted,
        blacklistReason: data.isBlacklisted ? String(data.blacklistReason).trim() : undefined,
      },
    });
  }

  // warehouseId (2026-08-28) — same explicit-filter-checked-against-own-
  // access shape as VehiclesService.findAll; see its comment for the full
  // reasoning (mirrors YardService.tracker()'s own historical bug fix).
  async findAll(user: any, warehouseId?: string) {
    await assertGateAccessAllowed(this.prisma, user);
    const accessibleIds = await gateYardAccessibleWarehouseIds(this.prisma, user);
    if (warehouseId && accessibleIds && !accessibleIds.includes(warehouseId)) {
      throw new ForbiddenException('You do not have access to this warehouse.');
    }
    const where: any = { ...companyFilter(user) };
    if (warehouseId) where.warehouseId = warehouseId;
    else if (accessibleIds) where.warehouseId = { in: accessibleIds };
    return this.prisma.driver.findMany({ where, include: { warehouse: { select: { id: true, code: true, name: true } } }, orderBy: { name: 'asc' } });
  }

  // Export only — see VehiclesService.exportRows for why there's no bulk
  // import counterpart (2026-08-27 Vehicle & Driver Master pass).
  async exportRows(user: any) {
    const drivers = await this.findAll(user);
    return drivers.map((d) => ({
      'Name': d.name,
      'Warehouse': (d as any).warehouse?.code ?? '',
      'Phone': d.phone ?? '',
      'License Number': d.licenseNumber ?? '',
      'License Expiry': d.licenseExpiry ? d.licenseExpiry.toISOString().slice(0, 10) : '',
      'Blacklisted': d.isBlacklisted ? 'TRUE' : 'FALSE',
      'Blacklist Reason': d.blacklistReason ?? '',
      'Active': d.isActive ? 'TRUE' : 'FALSE',
    }));
  }

  // Warehouse-scoped 2026-08-28 — same reasoning as VehiclesService.
  // assertAccess.
  private async assertAccess(id: string, user: any) {
    const driver = await this.prisma.driver.findUnique({ where: { id } });
    if (!driver) throw new NotFoundException('Driver not found.');
    if (user.role !== 'SUPER_ADMIN' && driver.companyId !== user.companyId) {
      throw new ForbiddenException('You do not have access to this driver.');
    }
    if (GATE_YARD_SCOPED_ROLES.includes(user.role)) {
      const ids = await ownWarehouseIds(this.prisma, user.userId);
      if (!driver.warehouseId || !ids.includes(driver.warehouseId)) {
        throw new ForbiddenException('You do not have access to this driver.');
      }
    }
    return driver;
  }

  async update(id: string, data: any, user: any) {
    await assertGateAccessAllowed(this.prisma, user);
    await this.assertAccess(id, user);
    const errors: string[] = [];
    this.validate(data, errors);
    const warehouseId = await this.resolveWarehouseId(data.warehouseId, user, errors);
    if (errors.length > 0) throw new BadRequestException(errors);

    return this.prisma.driver.update({
      where: { id },
      data: {
        warehouse: { connect: { id: warehouseId! } },
        name: String(data.name).trim(),
        phone: data.phone ? String(data.phone).trim() : null,
        licenseNumber: data.licenseNumber ? String(data.licenseNumber).trim() : null,
        licenseExpiry: this.toDate(data.licenseExpiry) ?? null,
        isBlacklisted: !!data.isBlacklisted,
        blacklistReason: data.isBlacklisted ? String(data.blacklistReason).trim() : null,
      },
    });
  }

  async deactivate(id: string, user: any) {
    await assertGateAccessAllowed(this.prisma, user);
    await this.assertAccess(id, user);
    return this.prisma.driver.update({ where: { id }, data: { isActive: false } });
  }

  async reactivate(id: string, user: any) {
    await assertGateAccessAllowed(this.prisma, user);
    await this.assertAccess(id, user);
    return this.prisma.driver.update({ where: { id }, data: { isActive: true } });
  }

  async removeAll(user: any) {
    await assertGateAccessAllowed(this.prisma, user);
    const drivers = await this.prisma.driver.findMany({
      where: companyFilter(user),
      select: { id: true, name: true, _count: { select: { gateEntries: true } } },
    });
    const deletable = drivers.filter((d) => d._count.gateEntries === 0).map((d) => d.id);
    const blocked = drivers.filter((d) => d._count.gateEntries > 0).map((d) => d.name);
    if (deletable.length > 0) await this.prisma.driver.deleteMany({ where: { id: { in: deletable } } });
    return { deletedCount: deletable.length, blockedCount: blocked.length, blockedCodes: blocked };
  }

  async remove(id: string, user: any) {
    await assertGateAccessAllowed(this.prisma, user);
    const driver = await this.assertAccess(id, user);
    const count = await this.prisma.vehicleGateEntry.count({ where: { driverId: id } });
    if (count > 0) {
      throw new BadRequestException(`Cannot permanently delete "${driver.name}" — it has ${count} linked gate entry record(s). Deactivate it instead.`);
    }
    await this.prisma.driver.delete({ where: { id } });
    return { deleted: true, code: driver.name };
  }
}
