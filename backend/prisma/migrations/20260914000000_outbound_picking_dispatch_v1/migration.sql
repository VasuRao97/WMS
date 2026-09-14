-- CreateEnum
CREATE TYPE "PickTripStatus" AS ENUM ('IN_PROGRESS', 'COMPLETED', 'ABANDONED');

-- AlterEnum
ALTER TYPE "MovementType" ADD VALUE 'PICK_IN';

-- AlterEnum
ALTER TYPE "OrderStatus" ADD VALUE 'ALLOTTED';

-- AlterEnum
BEGIN;
CREATE TYPE "PickStatus_new" AS ENUM ('NEEDS_SOURCE', 'PENDING', 'COMPLETED');
ALTER TABLE "public"."PickTask" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "PickTask" ALTER COLUMN "status" TYPE "PickStatus_new" USING ("status"::text::"PickStatus_new");
ALTER TYPE "PickStatus" RENAME TO "PickStatus_old";
ALTER TYPE "PickStatus_new" RENAME TO "PickStatus";
DROP TYPE "public"."PickStatus_old";
ALTER TABLE "PickTask" ALTER COLUMN "status" SET DEFAULT 'PENDING';
COMMIT;

-- DropForeignKey
ALTER TABLE "Allocation" DROP CONSTRAINT "Allocation_locationId_fkey";

-- DropForeignKey
ALTER TABLE "Allocation" DROP CONSTRAINT "Allocation_orderLineId_fkey";

-- DropForeignKey
ALTER TABLE "Allocation" DROP CONSTRAINT "Allocation_skuId_fkey";

-- DropForeignKey
ALTER TABLE "OutboundOrder" DROP CONSTRAINT "OutboundOrder_createdById_fkey";

-- DropForeignKey
ALTER TABLE "PickTask" DROP CONSTRAINT "PickTask_allocationId_fkey";

-- DropForeignKey
ALTER TABLE "PickTask" DROP CONSTRAINT "PickTask_pickerId_fkey";

-- DropIndex
DROP INDEX "OutboundOrder_orderNo_key";

-- DropIndex
DROP INDEX "PickTask_allocationId_key";

-- AlterTable
ALTER TABLE "OutboundOrder" ADD COLUMN     "createdViaErpPush" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "destinationCity" TEXT NOT NULL,
ADD COLUMN     "vehicleId" TEXT,
ALTER COLUMN "createdById" DROP NOT NULL;

-- AlterTable
ALTER TABLE "OutboundOrderLine" DROP COLUMN "allocatedQty",
ADD COLUMN     "isPriority" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "PickTask" DROP COLUMN "allocationId",
DROP COLUMN "pickedAt",
DROP COLUMN "pickerId",
ADD COLUMN     "fromLocationId" TEXT,
ADD COLUMN     "orderLineId" TEXT NOT NULL,
ADD COLUMN     "skuId" TEXT NOT NULL,
ADD COLUMN     "toLocationId" TEXT;

-- AlterTable
ALTER TABLE "VehicleGateEntry" ADD COLUMN     "outboundOrderId" TEXT;

-- DropTable
DROP TABLE "Allocation";

-- DropEnum
DROP TYPE "AllocationStatus";

-- CreateTable
CREATE TABLE "PickTrip" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "quantity" DECIMAL(65,30) NOT NULL,
    "status" "PickTripStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "claimedById" TEXT NOT NULL,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "scannedLocationId" TEXT,
    "palletLoadId" TEXT,
    "unitBarcodeScanned" TEXT,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "PickTrip_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PickTrip_taskId_idx" ON "PickTrip"("taskId");

-- CreateIndex
CREATE INDEX "PickTrip_claimedById_status_idx" ON "PickTrip"("claimedById", "status");

-- CreateIndex
CREATE INDEX "PickTask_orderLineId_idx" ON "PickTask"("orderLineId");

-- CreateIndex
CREATE INDEX "PickTask_fromLocationId_status_idx" ON "PickTask"("fromLocationId", "status");

-- CreateIndex
CREATE INDEX "PickTask_status_idx" ON "PickTask"("status");

-- CreateIndex
CREATE UNIQUE INDEX "VehicleGateEntry_outboundOrderId_key" ON "VehicleGateEntry"("outboundOrderId");

-- AddForeignKey
ALTER TABLE "VehicleGateEntry" ADD CONSTRAINT "VehicleGateEntry_outboundOrderId_fkey" FOREIGN KEY ("outboundOrderId") REFERENCES "OutboundOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundOrder" ADD CONSTRAINT "OutboundOrder_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundOrder" ADD CONSTRAINT "OutboundOrder_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PickTask" ADD CONSTRAINT "PickTask_orderLineId_fkey" FOREIGN KEY ("orderLineId") REFERENCES "OutboundOrderLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PickTask" ADD CONSTRAINT "PickTask_skuId_fkey" FOREIGN KEY ("skuId") REFERENCES "Sku"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PickTask" ADD CONSTRAINT "PickTask_fromLocationId_fkey" FOREIGN KEY ("fromLocationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PickTask" ADD CONSTRAINT "PickTask_toLocationId_fkey" FOREIGN KEY ("toLocationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PickTrip" ADD CONSTRAINT "PickTrip_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "PickTask"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PickTrip" ADD CONSTRAINT "PickTrip_claimedById_fkey" FOREIGN KEY ("claimedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PickTrip" ADD CONSTRAINT "PickTrip_scannedLocationId_fkey" FOREIGN KEY ("scannedLocationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PickTrip" ADD CONSTRAINT "PickTrip_palletLoadId_fkey" FOREIGN KEY ("palletLoadId") REFERENCES "PalletLoad"("id") ON DELETE SET NULL ON UPDATE CASCADE;

