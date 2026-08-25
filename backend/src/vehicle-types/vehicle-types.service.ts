import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

// VehicleType is platform-level reference data (no companyId) — every
// company reads the same list. No create/update/delete here on purpose:
// it's seeded directly (see prisma/seed.ts), not client-editable, same
// shape as ProductCategoriesService.
@Injectable()
export class VehicleTypesService {
  constructor(private prisma: PrismaService) {}

  findAll() {
    return this.prisma.vehicleType.findMany({ orderBy: [{ segment: 'asc' }, { maxTonnage: 'asc' }] });
  }
}
