-- Activity suitability matrix on EquipmentType (2026-08-28) — "so we get
-- all the mhe's in warehouse instantly" for a given activity. See
-- schema.prisma's comment on the model for the full reasoning. All six
-- columns default NOT_USED; prisma/seed.ts backfills the real placeholder
-- matrix for the 9 already-seeded rows on next `npx prisma db seed`.

CREATE TYPE "EquipmentSuitability" AS ENUM ('PRIMARY', 'SECONDARY', 'NOT_USED');

ALTER TABLE "EquipmentType" ADD COLUMN "putawaySuitability" "EquipmentSuitability" NOT NULL DEFAULT 'NOT_USED';
ALTER TABLE "EquipmentType" ADD COLUMN "pickingSuitability" "EquipmentSuitability" NOT NULL DEFAULT 'NOT_USED';
ALTER TABLE "EquipmentType" ADD COLUMN "loadingSuitability" "EquipmentSuitability" NOT NULL DEFAULT 'NOT_USED';
ALTER TABLE "EquipmentType" ADD COLUMN "unloadingSuitability" "EquipmentSuitability" NOT NULL DEFAULT 'NOT_USED';
ALTER TABLE "EquipmentType" ADD COLUMN "consolidationSuitability" "EquipmentSuitability" NOT NULL DEFAULT 'NOT_USED';
ALTER TABLE "EquipmentType" ADD COLUMN "inventoryCheckSuitability" "EquipmentSuitability" NOT NULL DEFAULT 'NOT_USED';
