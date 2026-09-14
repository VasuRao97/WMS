-- CreateEnum
CREATE TYPE "PickExceptionReason" AS ENUM ('SHORT_STOCK', 'EMPTY_BIN', 'WRONG_SKU', 'SHORT_QUANTITY', 'DAMAGED', 'OTHER');

-- AlterEnum
ALTER TYPE "NotificationEventType" ADD VALUE 'PICKING_OPERATOR_MISSED_TURN';

-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "pickingAssignmentGraceMinutes" INTEGER NOT NULL DEFAULT 2;

-- CreateTable
CREATE TABLE "PickException" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "tripId" TEXT,
    "reason" "PickExceptionReason" NOT NULL,
    "notes" TEXT,
    "reportedById" TEXT,
    "reportedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    "reviewedById" TEXT,

    CONSTRAINT "PickException_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PickException_taskId_idx" ON "PickException"("taskId");

-- CreateIndex
CREATE INDEX "PickException_reviewedAt_idx" ON "PickException"("reviewedAt");

-- AddForeignKey
ALTER TABLE "PickException" ADD CONSTRAINT "PickException_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "PickTask"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PickException" ADD CONSTRAINT "PickException_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "PickTrip"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PickException" ADD CONSTRAINT "PickException_reportedById_fkey" FOREIGN KEY ("reportedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PickException" ADD CONSTRAINT "PickException_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
