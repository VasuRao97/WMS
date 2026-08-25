-- VehicleType: platform-level reference data for Yard & Gate (same shape as
-- ProductCategory — no companyId, seeded via prisma/seed.ts, not client-
-- editable via any UI yet). Dimensions are three separate numeric columns
-- (not a combined text label) for future truck-load/volume analysis; see
-- schema.prisma's comment on the model for the full reasoning.
CREATE TABLE "VehicleType" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "segment" TEXT NOT NULL,
    "lengthFt" DECIMAL(65,30) NOT NULL,
    "widthFt" DECIMAL(65,30) NOT NULL,
    "heightFt" DECIMAL(65,30) NOT NULL,
    "maxTonnage" DECIMAL(65,30) NOT NULL,

    CONSTRAINT "VehicleType_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "VehicleType_name_key" ON "VehicleType"("name");

-- VehicleGateEntry: table confirmed empty (no gate entries logged yet), so
-- this required FK needs no backfill.
ALTER TABLE "VehicleGateEntry" ADD COLUMN "vehicleTypeId" TEXT NOT NULL;

ALTER TABLE "VehicleGateEntry" ADD CONSTRAINT "VehicleGateEntry_vehicleTypeId_fkey" FOREIGN KEY ("vehicleTypeId") REFERENCES "VehicleType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
