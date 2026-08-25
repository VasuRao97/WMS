-- Yard & Gate, second design pass (2026-08-25): registered Vehicle/Driver
-- masters, per-entry document checks, E-Way Bill + inbound material
-- confirmation on the gate log, and a company-level E-Way Bill toggle. See
-- schema.prisma's comments on each model for the full reasoning; CLAUDE.md
-- has the conversation this came out of.

CREATE TYPE "GateDocumentType" AS ENUM ('LICENSE', 'INSURANCE', 'RC', 'PUC', 'FITNESS');
CREATE TYPE "GateDocumentStatus" AS ENUM ('OK', 'FLAGGED', 'MISSING');

-- Company: per-company opt-in for requiring an E-Way Bill before an
-- Outbound Gate Out can close. Defaults off — existing companies (24 rows)
-- get `false`, no backfill needed beyond the column default.
ALTER TABLE "Company" ADD COLUMN "requireEwayBillForOutboundGateOut" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "Vehicle" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "vehicleNumber" TEXT NOT NULL,
    "vehicleTypeId" TEXT NOT NULL,
    "lengthFt" DECIMAL(65,30),
    "widthFt" DECIMAL(65,30),
    "heightFt" DECIMAL(65,30),
    "rcNumber" TEXT,
    "rcExpiry" TIMESTAMP(3),
    "insuranceNumber" TEXT,
    "insuranceExpiry" TIMESTAMP(3),
    "pucNumber" TEXT,
    "pucExpiry" TIMESTAMP(3),
    "fitnessNumber" TEXT,
    "fitnessExpiry" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Vehicle_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Vehicle_companyId_vehicleNumber_key" ON "Vehicle"("companyId", "vehicleNumber");

ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_vehicleTypeId_fkey" FOREIGN KEY ("vehicleTypeId") REFERENCES "VehicleType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "Driver" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "licenseNumber" TEXT,
    "licenseExpiry" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Driver_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Driver" ADD CONSTRAINT "Driver_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- VehicleGateEntry: confirmed empty, so these column swaps need no backfill.
ALTER TABLE "VehicleGateEntry" DROP CONSTRAINT "VehicleGateEntry_vehicleTypeId_fkey";
ALTER TABLE "VehicleGateEntry" DROP COLUMN "vehicleTypeId";
ALTER TABLE "VehicleGateEntry" DROP COLUMN "vehicleNumber";
ALTER TABLE "VehicleGateEntry" DROP COLUMN "driverName";
ALTER TABLE "VehicleGateEntry" DROP COLUMN "driverPhone";

ALTER TABLE "VehicleGateEntry" ADD COLUMN "vehicleId" TEXT NOT NULL;
ALTER TABLE "VehicleGateEntry" ADD COLUMN "driverId" TEXT NOT NULL;
ALTER TABLE "VehicleGateEntry" ADD COLUMN "eWayBillNo" TEXT;
ALTER TABLE "VehicleGateEntry" ADD COLUMN "eWayBillGeneratedAt" TIMESTAMP(3);
ALTER TABLE "VehicleGateEntry" ADD COLUMN "materialReceivedConfirmed" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "VehicleGateEntry" ADD CONSTRAINT "VehicleGateEntry_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VehicleGateEntry" ADD CONSTRAINT "VehicleGateEntry_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "GateEntryDocumentCheck" (
    "id" TEXT NOT NULL,
    "gateEntryId" TEXT NOT NULL,
    "documentType" "GateDocumentType" NOT NULL,
    "status" "GateDocumentStatus" NOT NULL,
    "note" TEXT,

    CONSTRAINT "GateEntryDocumentCheck_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GateEntryDocumentCheck_gateEntryId_documentType_key" ON "GateEntryDocumentCheck"("gateEntryId", "documentType");

ALTER TABLE "GateEntryDocumentCheck" ADD CONSTRAINT "GateEntryDocumentCheck_gateEntryId_fkey" FOREIGN KEY ("gateEntryId") REFERENCES "VehicleGateEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
