import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { companyFilter } from '../common/tenant.util';
import { CODE_REGEX, PINCODE_REGEX } from '../common/validation.util';

const GST_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
const PAN_REGEX = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DELIVERY_ZONE_VALUES = ['LOCAL', 'UPCOUNTRY'];

@Injectable()
export class CustomersService {
  constructor(private prisma: PrismaService) {}

  private validate(data: any): string[] {
    const errors: string[] = [];
    if (!data.code || !CODE_REGEX.test(data.code)) {
      errors.push('Bill To ID is required: alphanumeric/hyphens only, max 30 characters.');
    }
    if (!data.name || data.name.length < 2 || data.name.length > 200) {
      errors.push('Customer Name is required: 2-200 characters.');
    }
    if (data.email && !EMAIL_REGEX.test(data.email)) errors.push('Email format is invalid.');
    if (data.pan && !PAN_REGEX.test(data.pan)) errors.push('PAN format is invalid (expected e.g. ABCDE1234F).');
    if (data.gstNumber && !GST_REGEX.test(data.gstNumber)) errors.push('Billing GST number format is invalid.');
    if (data.pincode && !PINCODE_REGEX.test(data.pincode)) errors.push('Pincode must be 6 digits.');

    if (data.shipToLocations && data.shipToLocations.length > 0) {
      let defaultCount = 0;
      for (const s of data.shipToLocations) {
        if (!s.address) errors.push('Each Ship-to location requires an address.');
        if (!s.pincode || !PINCODE_REGEX.test(s.pincode)) errors.push('Each Ship-to location requires a valid 6-digit pincode.');
        if (!s.state) errors.push('Each Ship-to location requires a state.');
        if (s.gstNumber && !GST_REGEX.test(s.gstNumber)) errors.push(`Ship-to GST number format is invalid: ${s.gstNumber}`);
        if (s.deliveryZone && !DELIVERY_ZONE_VALUES.includes(String(s.deliveryZone).trim().toUpperCase())) {
          errors.push(`Ship-to Local/Upcountry must be one of: ${DELIVERY_ZONE_VALUES.join(', ')}`);
        }
        if (s.isDefault) defaultCount++;
      }
      if (defaultCount > 1) errors.push('Only one Ship-to location can be marked as Default.');
    }
    return errors;
  }

  private async resolveShipTos(shipToLocations: any[], user: any, errors: string[]) {
    const resolved: any[] = [];
    for (const s of shipToLocations || []) {
      let warehouseId: string | undefined = undefined;
      if (s.warehouseCode) {
        const wh = await this.prisma.warehouse.findUnique({
          where: { companyId_code: { companyId: user.companyId, code: s.warehouseCode.toUpperCase() } },
        });
        if (!wh) {
          errors.push(`Warehouse code "${s.warehouseCode}" not found for this company.`);
          continue;
        }
        warehouseId = wh.id;
      }
      resolved.push({
        shipToCode: s.shipToCode || undefined,
        address: s.address,
        pincode: s.pincode,
        state: s.state,
        gstNumber: s.gstNumber || undefined,
        isDefault: !!s.isDefault,
        warehouseId,
        deliveryZone: s.deliveryZone ? String(s.deliveryZone).toUpperCase().trim() : undefined,
      });
    }
    return resolved;
  }

  async create(data: any, user: any) {
    if (!user.companyId) {
      throw new ForbiddenException('Super admin accounts cannot create customers directly — log in as a company admin instead.');
    }
    const errors = this.validate(data);
    const shipToCreateData = await this.resolveShipTos(data.shipToLocations, user, errors);
    if (errors.length > 0) throw new BadRequestException(errors);

    const existing = await this.prisma.customer.findUnique({
      where: { companyId_code: { companyId: user.companyId, code: data.code.toUpperCase() } },
    });
    if (existing) throw new BadRequestException(`Bill To ID "${data.code}" already exists.`);

    return this.prisma.customer.create({
      data: {
        code: data.code.toUpperCase(),
        name: data.name,
        category: data.category || undefined,
        email: data.email || undefined,
        phone: data.phone || undefined,
        pan: data.pan || undefined,
        billingAddress: data.billingAddress || undefined,
        pincode: data.pincode || undefined,
        state: data.state || undefined,
        gstNumber: data.gstNumber || undefined,
        isActive: data.isActive !== undefined ? !!data.isActive : true,
        erpCode: data.erpCode || undefined,
        company: { connect: { id: user.companyId } },
        shipToLocations: shipToCreateData.length ? { create: shipToCreateData } : undefined,
      },
      include: { shipToLocations: { include: { warehouse: { select: { code: true, name: true } } } } },
    });
  }

  findAll(user: any) {
    return this.prisma.customer.findMany({
      where: companyFilter(user),
      include: { shipToLocations: { include: { warehouse: { select: { code: true, name: true } } } } },
    });
  }

  private async assertAccess(id: string, user: any) {
    const customer = await this.prisma.customer.findUnique({ where: { id } });
    if (!customer) throw new NotFoundException('Customer not found.');
    if (user.role !== 'SUPER_ADMIN' && customer.companyId !== user.companyId) {
      throw new ForbiddenException('You do not have access to this customer.');
    }
    return customer;
  }

  async deactivate(id: string, user: any) {
    await this.assertAccess(id, user);
    return this.prisma.customer.update({ where: { id }, data: { isActive: false } });
  }

  async reactivate(id: string, user: any) {
    await this.assertAccess(id, user);
    return this.prisma.customer.update({ where: { id }, data: { isActive: true } });
  }

  async remove(id: string, user: any) {
    const customer = await this.assertAccess(id, user);
    await this.prisma.$transaction([
      this.prisma.customerShipTo.deleteMany({ where: { customerId: id } }),
      this.prisma.customer.delete({ where: { id } }),
    ]);
    return { deleted: true, code: customer.code };
  }

  async removeAll(user: any) {
    const customers = await this.prisma.customer.findMany({ where: companyFilter(user), select: { id: true } });
    const ids = customers.map((c) => c.id);
    if (ids.length > 0) {
      await this.prisma.$transaction([
        this.prisma.customerShipTo.deleteMany({ where: { customerId: { in: ids } } }),
        this.prisma.customer.deleteMany({ where: { id: { in: ids } } }),
      ]);
    }
    return { deletedCount: ids.length, blockedCount: 0, blockedCodes: [] };
  }

  async bulkImport(groupedCustomers: any[], user: any) {
    if (!user.companyId) {
      throw new ForbiddenException('Super admin accounts cannot import customers directly — log in as a company admin instead.');
    }
    const results: any[] = [];
    const codesSeenInFile = new Set<string>();

    for (const group of groupedCustomers) {
      const upperCode = group.code ? String(group.code).toUpperCase() : '';
      const errors = this.validate(group);

      if (upperCode && codesSeenInFile.has(upperCode)) {
        errors.push(`Duplicate Bill To ID within this file: ${upperCode}`);
      }

      const shipToCreateData = await this.resolveShipTos(group.shipToLocations, user, errors);

      if (errors.length === 0 && upperCode) {
        const existing = await this.prisma.customer.findUnique({
          where: { companyId_code: { companyId: user.companyId, code: upperCode } },
        });
        if (existing) errors.push(`Bill To ID already exists in the database: ${upperCode}`);
      }

      if (errors.length > 0) {
        results.push({ code: group.code || '(blank)', status: 'error', errors });
        continue;
      }

      try {
        await this.prisma.customer.create({
          data: {
            code: upperCode,
            name: group.name,
            category: group.category || undefined,
            email: group.email || undefined,
            phone: group.phone || undefined,
            pan: group.pan || undefined,
            billingAddress: group.billingAddress || undefined,
            pincode: group.pincode || undefined,
            state: group.state || undefined,
            gstNumber: group.gstNumber || undefined,
            company: { connect: { id: user.companyId } },
            shipToLocations: shipToCreateData.length ? { create: shipToCreateData } : undefined,
          },
        });
        results.push({ code: upperCode, status: 'success', shipToCount: shipToCreateData.length });
        codesSeenInFile.add(upperCode);
      } catch (err: any) {
        results.push({ code: group.code || '(blank)', status: 'error', errors: [err.message || 'Unknown error'] });
      }
    }

    return {
      totalCustomers: groupedCustomers.length,
      successCount: results.filter((r) => r.status === 'success').length,
      failCount: results.filter((r) => r.status === 'error').length,
      results,
    };
  }
}