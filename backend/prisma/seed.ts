// Seeds ProductCategory — platform-level reference data, not a tenant
// master, not client-editable via any UI (see schema.prisma's comment on the
// model). Safe to re-run any time (upsert by name): add real categories here
// as more come in, then run `npx prisma db seed` again — existing rows are
// left untouched.
//
// Phase 1 is a flat list (no Industry column on ProductCategory yet — see
// schema.prisma's comment on the model). The client's first real submission
// came grouped by industry; kept here as a comment so that mapping isn't
// lost once an `industryId` FK gets added:
//
//   Industry   | Category
//   -----------|--------------------
//   Tyre       | Car Tyres
//   Tyre       | Truck Tyres-Radial
//   Tyre       | Truck Tyres-Bias
//   Tyre       | 2W tyres
//   Beverage   | Water
//   Beverage   | Carbonated
//   Beverage   | Non-Carbonated
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const CATEGORIES: string[] = [
  'Uncategorized', // default fallback when a storage-type row doesn't specify a category
  'Car Tyres',
  'Truck Tyres-Radial',
  'Truck Tyres-Bias',
  '2W tyres',
  'Water',
  'Carbonated',
  'Non-Carbonated',
];

async function main() {
  for (const name of CATEGORIES) {
    await prisma.productCategory.upsert({
      where: { name },
      update: {},
      create: { name },
    });
  }
  console.log(`Seeded ${CATEGORIES.length} product categor${CATEGORIES.length === 1 ? 'y' : 'ies'}.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
