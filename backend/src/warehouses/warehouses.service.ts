    import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class WarehousesService {
  constructor(private prisma: PrismaService) {}

  create(data: { code: string; name: string; address?: string }) {
    return this.prisma.warehouse.create({ data });
  }

  findAll() {
    return this.prisma.warehouse.findMany();
  }
}
