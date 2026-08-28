-- MHE (Material Handling Equipment) master data (2026-08-28, Putaway
-- kickoff conversation) — built BEFORE any Putaway task logic, per the
-- client's own explicit sequencing. Same two-tier shape as VehicleType/
-- Vehicle: a platform-seeded generic EquipmentType list (see prisma/seed.ts)
-- plus a company's own warehouse-scoped actual Equipment units, which can
-- override the generic per-trip throughput numbers.

CREATE TABLE "EquipmentType" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "genericPalletsPerTrip" DECIMAL(65,30) NOT NULL,
    "genericAvgTripMinutes" DECIMAL(65,30) NOT NULL,

    CONSTRAINT "EquipmentType_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EquipmentType_name_key" ON "EquipmentType"("name");

CREATE TABLE "Equipment" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT,
    "equipmentTypeId" TEXT NOT NULL,
    "palletsPerTrip" DECIMAL(65,30),
    "avgTripMinutes" DECIMAL(65,30),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Equipment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Equipment_warehouseId_code_key" ON "Equipment"("warehouseId", "code");

ALTER TABLE "Equipment" ADD CONSTRAINT "Equipment_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Equipment" ADD CONSTRAINT "Equipment_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Equipment" ADD CONSTRAINT "Equipment_equipmentTypeId_fkey" FOREIGN KEY ("equipmentTypeId") REFERENCES "EquipmentType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
