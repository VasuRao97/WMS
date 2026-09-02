-- CreateEnum
CREATE TYPE "PalletStatus" AS ENUM ('AVAILABLE', 'IN_USE');

-- CreateEnum
CREATE TYPE "PalletLoadStatus" AS ENUM ('OPEN', 'CLOSED');

-- DropForeignKey
ALTER TABLE "Driver" DROP CONSTRAINT "Driver_warehouseId_fkey";

-- DropForeignKey
ALTER TABLE "InboundReceipt" DROP CONSTRAINT "InboundReceipt_createdById_fkey";

-- DropForeignKey
ALTER TABLE "InboundReceiptLine" DROP CONSTRAINT "InboundReceiptLine_stagingLocationId_fkey";

-- DropForeignKey
ALTER TABLE "Location" DROP CONSTRAINT "Location_categoryId_fkey";

-- DropForeignKey
ALTER TABLE "NotificationLog" DROP CONSTRAINT "NotificationLog_escalatedToId_fkey";

-- DropForeignKey
ALTER TABLE "NotificationLog" DROP CONSTRAINT "NotificationLog_warehouseId_fkey";

-- DropForeignKey
ALTER TABLE "PutawayTask" DROP CONSTRAINT "PutawayTask_toLocationId_fkey";

-- DropForeignKey
ALTER TABLE "SelfCheckInRequest" DROP CONSTRAINT "SelfCheckInRequest_resultingGateEntryId_fkey";

-- DropForeignKey
ALTER TABLE "SelfCheckInRequest" DROP CONSTRAINT "SelfCheckInRequest_reviewedById_fkey";

-- DropForeignKey
ALTER TABLE "Vehicle" DROP CONSTRAINT "Vehicle_warehouseId_fkey";

-- DropIndex
DROP INDEX "Driver_warehouseId_idx";

-- DropIndex
DROP INDEX "Vehicle_warehouseId_idx";

-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "defaultMaxCasesPerPallet" DECIMAL(65,30);

-- AlterTable
ALTER TABLE "InboundReceipt" ADD COLUMN     "requiresPalletConsolidation" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "PutawayTask" ADD COLUMN     "palletLoadId" TEXT;

-- AlterTable
ALTER TABLE "Sku" ADD COLUMN     "maxCasesPerPallet" DECIMAL(65,30);

-- AlterTable
ALTER TABLE "StockMovement" ADD COLUMN     "palletLoadId" TEXT;

-- CreateTable
CREATE TABLE "Pallet" (
    "id" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "status" "PalletStatus" NOT NULL DEFAULT 'AVAILABLE',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Pallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PalletLoad" (
    "id" TEXT NOT NULL,
    "palletId" TEXT NOT NULL,
    "skuId" TEXT NOT NULL,
    "receiptLineId" TEXT,
    "status" "PalletLoadStatus" NOT NULL DEFAULT 'OPEN',
    "closeReason" TEXT,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "closedById" TEXT,

    CONSTRAINT "PalletLoad_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Pallet_warehouseId_code_key" ON "Pallet"("warehouseId", "code");

-- CreateIndex
CREATE INDEX "PalletLoad_palletId_idx" ON "PalletLoad"("palletId");

-- CreateIndex
CREATE INDEX "StockMovement_palletLoadId_idx" ON "StockMovement"("palletLoadId");

-- AddForeignKey
ALTER TABLE "Location" ADD CONSTRAINT "Location_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ProductCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_palletLoadId_fkey" FOREIGN KEY ("palletLoadId") REFERENCES "PalletLoad"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Driver" ADD CONSTRAINT "Driver_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationLog" ADD CONSTRAINT "NotificationLog_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationLog" ADD CONSTRAINT "NotificationLog_escalatedToId_fkey" FOREIGN KEY ("escalatedToId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SelfCheckInRequest" ADD CONSTRAINT "SelfCheckInRequest_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SelfCheckInRequest" ADD CONSTRAINT "SelfCheckInRequest_resultingGateEntryId_fkey" FOREIGN KEY ("resultingGateEntryId") REFERENCES "VehicleGateEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboundReceipt" ADD CONSTRAINT "InboundReceipt_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboundReceiptLine" ADD CONSTRAINT "InboundReceiptLine_stagingLocationId_fkey" FOREIGN KEY ("stagingLocationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PutawayTask" ADD CONSTRAINT "PutawayTask_toLocationId_fkey" FOREIGN KEY ("toLocationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PutawayTask" ADD CONSTRAINT "PutawayTask_palletLoadId_fkey" FOREIGN KEY ("palletLoadId") REFERENCES "PalletLoad"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Pallet" ADD CONSTRAINT "Pallet_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PalletLoad" ADD CONSTRAINT "PalletLoad_palletId_fkey" FOREIGN KEY ("palletId") REFERENCES "Pallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PalletLoad" ADD CONSTRAINT "PalletLoad_skuId_fkey" FOREIGN KEY ("skuId") REFERENCES "Sku"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PalletLoad" ADD CONSTRAINT "PalletLoad_receiptLineId_fkey" FOREIGN KEY ("receiptLineId") REFERENCES "InboundReceiptLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PalletLoad" ADD CONSTRAINT "PalletLoad_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

