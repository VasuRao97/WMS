import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class WarehousesService {
  constructor(private prisma: PrismaService) {}

  create(data: { code: string; name: string; address?: string }, user: any) {
    if (!user.companyId) {
      throw new ForbiddenException(
        'Super admin accounts cannot create warehouses directly — log in as a company admin instead.',
      );
    }
    return this.prisma.warehouse.create({
      data: {
        code: data.code,
        name: data.name,
        address: data.address,
        company: { connect: { id: user.companyId } },
      },
    });
  }

  findAll(user: any) {
    if (user.role === 'SUPER_ADMIN') {
      return this.prisma.warehouse.findMany();
    }
    return this.prisma.warehouse.findMany({ where: { companyId: user.companyId } });
  }

  async removeAll(user: any) {
    const where = user.role === 'SUPER_ADMIN' ? {} : { companyId: user.companyId };
    const warehouses = await this.prisma.warehouse.findMany({
      where,
      include: {
        _count: {
          select: {
            assignedUsers: true,
            shipToAssignments: true,
            locations: true,
            inboundReceipts: true,
            outboundOrders: true,
            stockMovements: true,
          },
        },
      },
    });
    const deletable: string[] = [];
    const blocked: string[] = [];
    for (const wh of warehouses) {
      const c = wh._count;
      const totalLinked = c.assignedUsers + c.shipToAssignments + c.locations + c.inboundReceipts + c.outboundOrders + c.stockMovements;
      if (totalLinked > 0) blocked.push(wh.code);
      else deletable.push(wh.id);
    }
    if (deletable.length > 0) {
      await this.prisma.warehouse.deleteMany({ where: { id: { in: deletable } } });
    }
    return { deletedCount: deletable.length, blockedCount: blocked.length, blockedCodes: blocked };
  }

  async getCustomerSummary(user: any) {
    const where = user.role === 'SUPER_ADMIN' ? {} : { companyId: user.companyId };
    const warehouses = await this.prisma.warehouse.findMany({
      where,
      include: { shipToAssignments: { select: { customerId: true, deliveryZone: true } } },
      orderBy: { code: 'asc' },
    });
    return warehouses.map((w) => ({
      warehouseId: w.id,
      code: w.code,
      name: w.name,
      shipToCount: w.shipToAssignments.length,
      customerCount: new Set(w.shipToAssignments.map((s) => s.customerId)).size,
      localCount: w.shipToAssignments.filter((s) => s.deliveryZone === 'LOCAL').length,
      upcountryCount: w.shipToAssignments.filter((s) => s.deliveryZone === 'UPCOUNTRY').length,
    }));
  }
}