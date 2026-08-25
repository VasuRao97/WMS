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

// Seeds VehicleType — platform-level reference data for Yard & Gate (same
// "not a tenant master, seeded by us" shape as ProductCategory above). Built
// with the client 2026-08-25 from a real workflow conversation, dimensions
// sourced from public truck/container spec listings (see CLAUDE.md's Yard &
// Gate section for the full list-building conversation and sources) — not
// exhaustive by design: two/three-wheelers and non-standard bodies (Low-Bed
// Trailer, Flatbed, Curtain-Sided, generic Multi-Axle open truck) were
// deliberately left out where no reliable sourced dimension was found.
// `maxTonnage` is the payload ceiling in Tons, kept as one number (not a
// min/max range) so a future feature can compare it directly against a
// weighbridge reading. The 20 ft Open Body / Closed Container rows' tonnage
// is a placeholder pending the client's own check against their fleet — see
// CLAUDE.md, don't treat it as final without re-confirming.
const VEHICLE_TYPES: { name: string; segment: string; lengthFt: number; widthFt: number; heightFt: number; maxTonnage: number }[] = [
  { name: 'Tata Ace / Chhota Hathi', segment: 'Mini Truck', lengthFt: 7, widthFt: 4.8, heightFt: 4.8, maxTonnage: 1 },
  { name: 'Mahindra Jeeto / Supro', segment: 'Mini Truck', lengthFt: 7, widthFt: 4.8, heightFt: 4.8, maxTonnage: 1.3 },
  { name: 'Piaggio Porter', segment: 'Mini Truck', lengthFt: 7, widthFt: 4.6, heightFt: 4.6, maxTonnage: 1 },
  { name: 'Ashok Leyland Dost', segment: 'Mini Truck', lengthFt: 7, widthFt: 4.8, heightFt: 4.8, maxTonnage: 1 },
  { name: 'Ashok Leyland Bada Dost', segment: 'Mini Truck', lengthFt: 9.5, widthFt: 5.5, heightFt: 5, maxTonnage: 2 },
  { name: 'Tata 407 / 407 Gold', segment: 'Pickup', lengthFt: 9, widthFt: 5.5, heightFt: 5, maxTonnage: 2.5 },
  { name: 'Mahindra Bolero Pickup', segment: 'Pickup', lengthFt: 8, widthFt: 5, heightFt: 4.8, maxTonnage: 1.5 },
  { name: 'Eicher 14 ft (Pro 1049-class)', segment: 'Pickup', lengthFt: 14, widthFt: 6, heightFt: 6.5, maxTonnage: 4 },
  { name: 'Eicher 17 ft (Pro 1055-class)', segment: 'Pickup', lengthFt: 17, widthFt: 6, heightFt: 7, maxTonnage: 5 },
  { name: 'Tata 709 / 712 / 1109', segment: 'MCV', lengthFt: 19, widthFt: 7, heightFt: 7, maxTonnage: 9 },
  { name: 'Eicher Pro 2049 / 2059', segment: 'MCV', lengthFt: 19, widthFt: 7, heightFt: 7, maxTonnage: 9 },
  { name: 'Ashok Leyland Partner', segment: 'MCV', lengthFt: 19, widthFt: 7, heightFt: 7, maxTonnage: 9 },
  { name: '3-Axle Truck (10-wheeler, ~22 ft)', segment: 'HCV', lengthFt: 22, widthFt: 7.5, heightFt: 7, maxTonnage: 10 },
  { name: '20 ft Open Body Truck', segment: 'Container', lengthFt: 20, widthFt: 8, heightFt: 8, maxTonnage: 7 },
  { name: '20 ft Closed Container', segment: 'Container', lengthFt: 20, widthFt: 8, heightFt: 8.5, maxTonnage: 7 },
  { name: '32 ft SXL (Single-Axle)', segment: 'Container', lengthFt: 32, widthFt: 8, heightFt: 8, maxTonnage: 9 },
  { name: '32 ft MXL (Multi-Axle)', segment: 'Container', lengthFt: 32, widthFt: 8, heightFt: 8, maxTonnage: 18 },
  { name: '40 ft Container', segment: 'Container', lengthFt: 40, widthFt: 8, heightFt: 8.5, maxTonnage: 28 },
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

  for (const vt of VEHICLE_TYPES) {
    await prisma.vehicleType.upsert({
      where: { name: vt.name },
      update: {},
      create: vt,
    });
  }
  console.log(`Seeded ${VEHICLE_TYPES.length} vehicle types.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
