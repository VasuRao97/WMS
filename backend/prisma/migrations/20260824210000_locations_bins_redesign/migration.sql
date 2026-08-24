-- WarehouseStorageType: add STILLAGE to the storageType vocabulary (enforced
-- in warehouses.service.ts, not a Postgres enum — no DDL needed for the value
-- itself) and add the ABC-class SKU-sharing config used by future Putaway
-- logic (not enforced yet, just the config surface).
ALTER TABLE "WarehouseStorageType" ADD COLUMN     "maxSkusClassA" INTEGER DEFAULT 1,
ADD COLUMN     "maxSkusClassB" INTEGER DEFAULT 2,
ADD COLUMN     "maxSkusClassC" INTEGER;

-- Location: table is empty (confirmed before writing this migration), so no
-- backfill needed. Replace the old 6-value `type` (LocationType enum) with
-- `zoneType` (14-value LocationZoneType enum, function tag) plus a whole new
-- set of physical-addressing fields — see schema.prisma's comments on
-- Location for the full reasoning (2026-08-24 design pass).
CREATE TYPE "LocationZoneType" AS ENUM (
    'UNLOADING_STAGING',
    'LOADING_STAGING',
    'ACTUAL_STORAGE',
    'FORWARD_PICK',
    'PICK_FACE',
    'PACKING_KITTING',
    'CROSS_DOCK',
    'SLOB',
    'RETURNS',
    'RE_PUTAWAY',
    'QC_HOLD',
    'TEMP_CONTROLLED_STORAGE',
    'HAZMAT',
    'DAMAGE_SCRAP'
);

ALTER TABLE "Location" ADD COLUMN     "zoneType" "LocationZoneType",
ADD COLUMN     "storageType" TEXT,
ADD COLUMN     "categoryId" TEXT,
ADD COLUMN     "aisle" TEXT,
ADD COLUMN     "rack" TEXT,
ADD COLUMN     "level" TEXT,
ADD COLUMN     "bin" TEXT,
ADD COLUMN     "block" TEXT,
ADD COLUMN     "stack" TEXT,
ADD COLUMN     "depth" INTEGER,
ADD COLUMN     "width" INTEGER,
ADD COLUMN     "height" INTEGER;

-- Table is empty, so this NOT NULL flip is safe with no backfill.
ALTER TABLE "Location" ALTER COLUMN "zoneType" SET NOT NULL;
ALTER TABLE "Location" ALTER COLUMN "storageType" SET NOT NULL;

ALTER TABLE "Location" DROP COLUMN "type";
DROP TYPE "LocationType";

ALTER TABLE "Location" ADD CONSTRAINT "Location_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ProductCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
