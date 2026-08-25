-- Yard & Gate, third design pass (2026-08-25): Yard Management (real
-- numbered parking slots), Gate Pass Number sequencing, Vehicle/Driver
-- blacklist flags, and dropping the unused VEHICLE_ONLY purpose. See
-- schema.prisma's comments on each model/field for the full reasoning;
-- CLAUDE.md has the conversation this came out of.

-- Warehouse: capacity input that drives YardSlot generation. Existing
-- warehouses just get NULL (no yard tracking until re-saved with a value).
ALTER TABLE "Warehouse" ADD COLUMN "yardCapacity" INTEGER;

-- Company: two new per-company toggles/settings. Existing rows (24) get
-- the column defaults with no backfill needed.
ALTER TABLE "Company" ADD COLUMN "blockGateInWhenYardFull" BOOLEAN NOT NULL DEFAULT false;

CREATE TYPE "GatePassResetPeriod" AS ENUM ('FINANCIAL_YEAR', 'QUARTER', 'MONTH');
ALTER TABLE "Company" ADD COLUMN "gatePassResetPeriod" "GatePassResetPeriod" NOT NULL DEFAULT 'FINANCIAL_YEAR';

-- Vehicle / Driver: blacklist flag, confirmed needed for both.
ALTER TABLE "Vehicle" ADD COLUMN "isBlacklisted" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Vehicle" ADD COLUMN "blacklistReason" TEXT;
ALTER TABLE "Driver" ADD COLUMN "isBlacklisted" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Driver" ADD COLUMN "blacklistReason" TEXT;

-- GateEntryPurpose: drop VEHICLE_ONLY (no concrete use case, dropped per
-- client 2026-08-25). Postgres can't DROP a value from an enum type
-- directly, so swap in a new type — VehicleGateEntry confirmed empty, so
-- the USING cast can't fail on a VEHICLE_ONLY row that doesn't exist.
CREATE TYPE "GateEntryPurpose_new" AS ENUM ('INBOUND_DELIVERY', 'OUTBOUND_DISPATCH', 'RETURNS');
ALTER TABLE "VehicleGateEntry" ALTER COLUMN "purpose" TYPE "GateEntryPurpose_new" USING ("purpose"::text::"GateEntryPurpose_new");
ALTER TYPE "GateEntryPurpose" RENAME TO "GateEntryPurpose_old";
ALTER TYPE "GateEntryPurpose_new" RENAME TO "GateEntryPurpose";
DROP TYPE "GateEntryPurpose_old";

-- YardSlot: real numbered parking slots, generated from Warehouse.yardCapacity.
CREATE TYPE "YardSlotStatus" AS ENUM ('AVAILABLE', 'OCCUPIED');

CREATE TABLE "YardSlot" (
    "id" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "status" "YardSlotStatus" NOT NULL DEFAULT 'AVAILABLE',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "YardSlot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "YardSlot_warehouseId_code_key" ON "YardSlot"("warehouseId", "code");

ALTER TABLE "YardSlot" ADD CONSTRAINT "YardSlot_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- GatePassSequence: per-warehouse, per-direction, per-period counter.
CREATE TYPE "GatePassDirection" AS ENUM ('INBOUND', 'OUTBOUND');

CREATE TABLE "GatePassSequence" (
    "id" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "direction" "GatePassDirection" NOT NULL,
    "periodKey" TEXT NOT NULL,
    "lastNumber" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "GatePassSequence_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GatePassSequence_warehouseId_direction_periodKey_key" ON "GatePassSequence"("warehouseId", "direction", "periodKey");

ALTER TABLE "GatePassSequence" ADD CONSTRAINT "GatePassSequence_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- VehicleGateEntry: yard slot link + generated gate pass number, both
-- nullable (yardSlotId can legitimately be unassigned; gatePassNo is
-- system-generated after validation, not client-supplied).
ALTER TABLE "VehicleGateEntry" ADD COLUMN "yardSlotId" TEXT;
ALTER TABLE "VehicleGateEntry" ADD COLUMN "gatePassNo" TEXT;

ALTER TABLE "VehicleGateEntry" ADD CONSTRAINT "VehicleGateEntry_yardSlotId_fkey" FOREIGN KEY ("yardSlotId") REFERENCES "YardSlot"("id") ON DELETE SET NULL ON UPDATE CASCADE;
