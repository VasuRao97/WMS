import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

// ProductCategory is platform-level reference data (no companyId) — every
// company reads the same list. There's no create/update/delete here on
// purpose: it's seeded directly (see prisma/seed.ts), not client-editable.
@Injectable()
export class ProductCategoriesService {
  constructor(private prisma: PrismaService) {}

  findAll() {
    return this.prisma.productCategory.findMany({ orderBy: { name: 'asc' } });
  }
}
