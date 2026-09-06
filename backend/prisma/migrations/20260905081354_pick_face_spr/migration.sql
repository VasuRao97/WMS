-- CreateEnum
CREATE TYPE "PickFaceTaskStatus" AS ENUM ('PENDING', 'COMPLETED');

-- CreateEnum
CREATE TYPE "PickFaceTaskReason" AS ENUM ('REFILL', 'EVICTION');

-- CreateEnum
CREATE TYPE "PickFaceTripStatus" AS ENUM ('IN_PROGRESS', 'COMPLETED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "MovementType" ADD VALUE 'PICK_FACE_REPLENISH_OUT';
ALTER TYPE "MovementType" ADD VALUE 'PICK_FACE_REPLENISH_IN';

-- AlterTable
ALTER TABLE "Warehouse" ADD COLUMN     "pickFaceEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "PickFaceTask" (
    "id" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "skuId" TEXT NOT NULL,
    "fromLocationId" TEXT NOT NULL,
    "toLocationId" TEXT NOT NULL,
    "quantity" DECIMAL(65,30) NOT NULL,
    "status" "PickFaceTaskStatus" NOT NULL DEFAULT 'PENDING',
    "reason" "PickFaceTaskReason" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PickFaceTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PickFaceTrip" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "quantity" DECIMAL(65,30) NOT NULL,
    "status" "PickFaceTripStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "claimedById" TEXT NOT NULL,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceBarcodeScanned" TEXT,
    "scannedLocationId" TEXT,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "PickFaceTrip_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "PickFaceTask" ADD CONSTRAINT "PickFaceTask_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PickFaceTask" ADD CONSTRAINT "PickFaceTask_skuId_fkey" FOREIGN KEY ("skuId") REFERENCES "Sku"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PickFaceTask" ADD CONSTRAINT "PickFaceTask_fromLocationId_fkey" FOREIGN KEY ("fromLocationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PickFaceTask" ADD CONSTRAINT "PickFaceTask_toLocationId_fkey" FOREIGN KEY ("toLocationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PickFaceTrip" ADD CONSTRAINT "PickFaceTrip_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "PickFaceTask"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PickFaceTrip" ADD CONSTRAINT "PickFaceTrip_claimedById_fkey" FOREIGN KEY ("claimedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PickFaceTrip" ADD CONSTRAINT "PickFaceTrip_scannedLocationId_fkey" FOREIGN KEY ("scannedLocationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;
