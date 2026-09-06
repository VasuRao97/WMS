-- CreateEnum
CREATE TYPE "DockZonePurpose" AS ENUM ('INBOUND', 'OUTBOUND', 'BOTH');

-- CreateEnum
CREATE TYPE "DockZoneAisleEnd" AS ENUM ('LOW', 'HIGH');

-- CreateTable
CREATE TABLE "WarehouseDockZone" (
    "id" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "purpose" "DockZonePurpose" NOT NULL,
    "nearAisleEnd" "DockZoneAisleEnd" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WarehouseDockZone_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "WarehouseDockZone" ADD CONSTRAINT "WarehouseDockZone_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
