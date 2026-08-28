import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

// EquipmentType is platform-level reference data (no companyId) — every
// company reads the same list. No create/update/delete here on purpose:
// it's seeded directly (see prisma/seed.ts), not client-editable, same
// shape as VehicleTypesService/ProductCategoriesService.
@Injectable()
export class EquipmentTypesService {
  constructor(private prisma: PrismaService) {}

  findAll() {
    return this.prisma.equipmentType.findMany({ orderBy: { name: 'asc' } });
  }
}
