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

// Seeds EquipmentType — platform-level reference data for Putaway's MHE
// master (2026-08-28, "we need to get the MHE master at start" — built
// before any Putaway task logic, per the client's own explicit sequencing).
// Same "not a tenant master, seeded by us, client corrects the numbers
// later" shape as VehicleType. Two entries came from a direct client
// disambiguation: "Manual" is a real zero-equipment hand-carry entry
// (needed so a task worked with no MHE at all still has somewhere to log
// throughput against), distinct from "Hand Held Trolley" (a real wheeled
// cart). Forklift is split into named sub-types (confirmed explicitly,
// same reasoning as VehicleType splitting Dost vs. Bada Dost) rather than
// one generic entry with per-unit overrides. "Stacker (Walkie/Rider)" was
// added by us, not in the client's own named list — a common lighter-duty
// vertical-lift type in Indian warehouses, easy to drop/rename later if it
// doesn't apply.
//
// genericPalletsPerTrip/genericAvgTripMinutes — REVISED 2026-08-28, same
// session, after the client directly asked whether these were actually
// researched or just guessed (they were guessed, the first time). Now
// grounded in real published figures rather than general reasoning, same
// "ships with a number, client corrects it later" convention as
// VehicleType.maxTonnage (whose own dimensions WERE sourced from public
// spec listings — this correction brings EquipmentType's numbers up to
// that same bar). Still not THIS client's own fleet-measured data — every
// real Equipment unit a company registers can override either figure.
// Sources and derivation per type:
//   - HOPT vs BOPT: a direct, matched comparison — "an employee takes 10
//     minutes to move a pallet manually [i.e. a hand pallet truck] but
//     only 3 minutes with an electric truck" (mobilept.com). Used
//     verbatim: HOPT 10 min, BOPT 3 min, both 1 pallet/trip.
//   - Forklift (both fuel types) / Reach Truck: general benchmarks cluster
//     at 16-25 pallet moves/hour (≈2.4-3.75 min/trip) — acclaimhandling.co.uk,
//     xorosoft.com, raymondcorp.com. Set at 3 min (Electric Forklift, Reach
//     Truck) / 3.5 min (Diesel/LPG Forklift — larger, more yard/outdoor
//     duty, still within the same band), all 1 pallet/trip.
//   - Double Deep Reach Truck: totallift.ca/abelwomack.com cite a 20-30%
//     productivity drop vs. a standard reach truck (extra handling to move
//     the front pallet before reaching the second row) — applied as +25%
//     over Reach Truck's 3 min → 3.75 min, 1 pallet/trip.
//   - Stacker (Walkie/Rider): sources (raymondcorp.com, toyotaforklift.com)
//     position it as bridging manual pallet trucks and full forklifts —
//     powered but walk-behind (slower travel than a ride-on) — no single
//     published pallets/hour figure found, so its 4.5 min/trip sits between
//     BOPT (3 min) and a manual-effort tier by that same positioning, not a
//     hard citation like the others — flagged as the one figure still
//     closer to reasoned estimate than sourced fact.
//   - Manual (Hand Carry) / Hand Held Trolley: these move loose cartons,
//     not pallets, so palletsPerTrip is a fraction derived from cartons-
//     per-pallet (30-60 for medium consumer goods, ~40 as a working
//     midpoint — freightamigo.com/getonecart.com) — a 2-carton hand-carry
//     trip ≈ 2/40 = 0.05 pallet-equivalent, a 6-carton trolley trip ≈
//     6/40 = 0.15. Trip TIME uses the manual case-picking band (150-250
//     cases/hour — shipbob.com/optioryx.com) as context for a plausible
//     short round-trip, not a direct per-trip citation (that benchmark
//     measures continuous picking, not one carry-and-return trip) — 3 min
//     (Manual) / 4 min (Trolley, more to load/unload per trip) are the
//     least strongly sourced of the nine, same caveat as Stacker above.
const EQUIPMENT_TYPES: { name: string; genericPalletsPerTrip: number; genericAvgTripMinutes: number }[] = [
  { name: 'Manual (Hand Carry)', genericPalletsPerTrip: 0.05, genericAvgTripMinutes: 3 },
  { name: 'Hand Held Trolley', genericPalletsPerTrip: 0.15, genericAvgTripMinutes: 4 },
  { name: 'HOPT (Hand Pallet Truck)', genericPalletsPerTrip: 1, genericAvgTripMinutes: 10 },
  { name: 'BOPT (Battery Pallet Truck)', genericPalletsPerTrip: 1, genericAvgTripMinutes: 3 },
  { name: 'Stacker (Walkie/Rider)', genericPalletsPerTrip: 1, genericAvgTripMinutes: 4.5 },
  { name: 'Forklift (Electric, up to 2T)', genericPalletsPerTrip: 1, genericAvgTripMinutes: 3 },
  { name: 'Forklift (Diesel/LPG, 2.5T+)', genericPalletsPerTrip: 1, genericAvgTripMinutes: 3.5 },
  { name: 'Reach Truck (RT)', genericPalletsPerTrip: 1, genericAvgTripMinutes: 3 },
  { name: 'Double Deep Reach Truck (DDRT)', genericPalletsPerTrip: 1, genericAvgTripMinutes: 3.75 },
];
// The activity-suitability matrix (Putaway/Picking/Loading/Unloading/
// Consolidation/Inventory Check) is deliberately NOT seeded here — a same-
// day correction, 2026-08-28: it was first built as a shared column set on
// this very model, then moved to a per-(Warehouse, EquipmentType) table
// once it became clear there was nowhere to actually edit a platform-wide
// matrix ("where is the matrix for input??"). See
// `common/equipment-suitability-defaults.ts` (consumed by
// `WarehousesService.generateEquipmentSuitability()`) and
// `WarehouseEquipmentSuitability` in schema.prisma for where it lives now.

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

  // update: et (not the create-only `{}` VehicleType/ProductCategory use
  // above) — EquipmentType has no client-facing edit UI at all, so
  // re-running this seed IS the only correction mechanism for its
  // throughput numbers (proven necessary the same day this was written:
  // the numbers above were corrected once already after the client asked
  // whether they were actually researched).
  for (const et of EQUIPMENT_TYPES) {
    await prisma.equipmentType.upsert({
      where: { name: et.name },
      update: et,
      create: et,
    });
  }
  console.log(`Seeded ${EQUIPMENT_TYPES.length} equipment types.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
