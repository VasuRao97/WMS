-- Yard & Gate Management, foundation pass (2026-08-25): Dock Door master
-- data + the vehicle Gate In/Out log. See schema.prisma's "YARD & GATE
-- MANAGEMENT" section comment for the full reasoning — Yard (parking-bay
-- holding) and Dock Scheduling (advance appointment booking) are
-- deliberately not built yet.

CREATE TYPE "DockDoorType" AS ENUM ('INBOUND', 'OUTBOUND', 'BOTH');
CREATE TYPE "DockDoorStatus" AS ENUM ('AVAILABLE', 'OCCUPIED', 'MAINTENANCE');
CREATE TYPE "GateEntryPurpose" AS ENUM ('INBOUND_DELIVERY', 'OUTBOUND_DISPATCH', 'RETURNS', 'VEHICLE_ONLY');

CREATE TABLE "DockDoor" (
    "id" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT,
    "dockType" "DockDoorType" NOT NULL DEFAULT 'BOTH',
    "status" "DockDoorStatus" NOT NULL DEFAULT 'AVAILABLE',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DockDoor_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DockDoor_warehouseId_code_key" ON "DockDoor"("warehouseId", "code");

ALTER TABLE "DockDoor" ADD CONSTRAINT "DockDoor_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "VehicleGateEntry" (
    "id" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "vehicleNumber" TEXT NOT NULL,
    "driverName" TEXT,
    "driverPhone" TEXT,
    "transporterName" TEXT,
    "purpose" "GateEntryPurpose" NOT NULL,
    "referenceNo" TEXT,
    "dockDoorId" TEXT,
    "gateInAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "gateInById" TEXT NOT NULL,
    "gateOutAt" TIMESTAMP(3),
    "gateOutById" TEXT,
    "grossWeightKg" DECIMAL(65,30),
    "grossWeighedAt" TIMESTAMP(3),
    "tareWeightKg" DECIMAL(65,30),
    "tareWeighedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VehicleGateEntry_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "VehicleGateEntry_warehouseId_gateInAt_idx" ON "VehicleGateEntry"("warehouseId", "gateInAt");

ALTER TABLE "VehicleGateEntry" ADD CONSTRAINT "VehicleGateEntry_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VehicleGateEntry" ADD CONSTRAINT "VehicleGateEntry_dockDoorId_fkey" FOREIGN KEY ("dockDoorId") REFERENCES "DockDoor"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "VehicleGateEntry" ADD CONSTRAINT "VehicleGateEntry_gateInById_fkey" FOREIGN KEY ("gateInById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VehicleGateEntry" ADD CONSTRAINT "VehicleGateEntry_gateOutById_fkey" FOREIGN KEY ("gateOutById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
