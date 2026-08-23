import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const GST_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
const PAN_REGEX = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

@Injectable()
export class CustomersService {
  constructor(private prisma: PrismaService) {}

  private validate(data: any): string[] {
    const errors: string[] = [];

    if (!data.code || !/^[A-Za-z0-9-]{1,30}$/.test(data.code)) {
      errors.push('Customer Code is required: alphanumeric/hyphens only, max 30 characters.');
    }
    if (!data.name || data.name.length < 2 || data.name.length > 200) {
      errors.push('Customer Name is required: 2-200 characters.');
    }
    if (data.email && !EMAIL_REGEX.test(data.email)) {
      errors.push('Email format is invalid.');
    }
    if (data.pan && !PAN_REGEX.test(data.pan)) {
      errors.push('PAN format is invalid (expected e.g. ABCDE1234F).');
    }
    if (data.gstNumber && !GST_REGEX.test(data.gstNumber)) {
      errors.push('Billing GST number format is invalid.');
    }
    if (data.pincode && !/^\d{6}$/.test(data.pincode)) {
      errors.push('Pincode must be 6 digits.');
    }

    if (data.shipToLocations && data.shipToLocations.length > 0) {
      let defaultCount = 0;
      for (const s of data.shipToLocations) {
        if (!s.address) errors.push('Each Ship-to location requires an address.');
        if (!s.pincode || !/^\d{6}$/.test(s.pincode)) errors.push('Each Ship-to location requires a valid 6-digit pincode.');
        if (!s.state) errors.push('Each Ship-to location requires a state.');
        if (s.gstNumber && !GST_REGEX.test(s.gstNumber)) errors.push(`Ship-to GST number format is invalid: ${s.gstNumber}`);
        if (s.isDefault) defaultCount++;
      }
      if (defaultCount > 1) errors.push('Only one Ship-to location can be marked as Default.');
    }

    return errors;
  }

  async create(data: any, user: any) {
    if (!user.companyId) {
      throw new ForbiddenException('Super admin accounts cannot create customers directly — log in as a company admin instead.');
    }
    const errors = this.validate(data);
    if (errors.length > 0) throw new BadRequestException(errors);

    const existing = await this.prisma.customer.findUnique({
      where: { companyId_code: { companyId: user.companyId, code: data.code.toUpperCase() } },
    });
    if (existing) throw new BadRequestException(`Customer code "${data.code}" already exists.`);

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
        shipToLocations:
          data.shipToLocations && data.shipToLocations.length
            ? {
                create: data.shipToLocations.map((s: any) => ({
                  address: s.address,
                  pincode: s.pincode,
                  state: s.state,
                  gstNumber: s.gstNumber || undefined,
                  latitude: s.latitude || undefined,
                  longitude: s.longitude || undefined,
                  isDefault: !!s.isDefault,
                })),
              }
            : undefined,
      },
      include: { shipToLocations: true },
    });
  }

  findAll(user: any) {
    const where = user.role === 'SUPER_ADMIN' ? {} : { companyId: user.companyId };
    return this.prisma.customer.findMany({ where, include: { shipToLocations: true } });
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
}