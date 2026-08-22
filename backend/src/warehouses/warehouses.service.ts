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
}