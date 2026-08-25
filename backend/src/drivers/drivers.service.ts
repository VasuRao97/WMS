import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { companyFilter } from '../common/tenant.util';

// Registered driver master — see schema.prisma's comment on the Driver
// model. Company-scoped like Vehicle, not warehouse-scoped. No unique
// constraint on phone/licenseNumber (deliberate — see schema comment), so
// no duplicate-detection here beyond what the operator notices themselves.
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

  async create(data: any, user: any) {
    if (!user.companyId) {
      throw new ForbiddenException('Super admin accounts cannot register drivers directly — log in as a company admin instead.');
    }
    const errors: string[] = [];
    this.validate(data, errors);
    if (errors.length > 0) throw new BadRequestException(errors);

    return this.prisma.driver.create({
      data: {
        company: { connect: { id: user.companyId } },
        name: String(data.name).trim(),
        phone: data.phone ? String(data.phone).trim() : undefined,
        licenseNumber: data.licenseNumber ? String(data.licenseNumber).trim() : undefined,
        licenseExpiry: this.toDate(data.licenseExpiry),
        isBlacklisted: !!data.isBlacklisted,
        blacklistReason: data.isBlacklisted ? String(data.blacklistReason).trim() : undefined,
      },
    });
  }

  async findAll(user: any) {
    return this.prisma.driver.findMany({ where: companyFilter(user), orderBy: { name: 'asc' } });
  }

  private async assertAccess(id: string, user: any) {
    const driver = await this.prisma.driver.findUnique({ where: { id } });
    if (!driver) throw new NotFoundException('Driver not found.');
    if (user.role !== 'SUPER_ADMIN' && driver.companyId !== user.companyId) {
      throw new ForbiddenException('You do not have access to this driver.');
    }
    return driver;
  }

  async update(id: string, data: any, user: any) {
    await this.assertAccess(id, user);
    const errors: string[] = [];
    this.validate(data, errors);
    if (errors.length > 0) throw new BadRequestException(errors);

    return this.prisma.driver.update({
      where: { id },
      data: {
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
    await this.assertAccess(id, user);
    return this.prisma.driver.update({ where: { id }, data: { isActive: false } });
  }

  async reactivate(id: string, user: any) {
    await this.assertAccess(id, user);
    return this.prisma.driver.update({ where: { id }, data: { isActive: true } });
  }

  async removeAll(user: any) {
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
    const driver = await this.assertAccess(id, user);
    const count = await this.prisma.vehicleGateEntry.count({ where: { driverId: id } });
    if (count > 0) {
      throw new BadRequestException(`Cannot permanently delete "${driver.name}" — it has ${count} linked gate entry record(s). Deactivate it instead.`);
    }
    await this.prisma.driver.delete({ where: { id } });
    return { deleted: true, code: driver.name };
  }
}
