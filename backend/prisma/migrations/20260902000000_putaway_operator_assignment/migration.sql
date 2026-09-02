-- AlterEnum
ALTER TYPE "NotificationEventType" ADD VALUE 'PUTAWAY_OPERATOR_MISSED_TURN';

-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "putawayAssignmentGraceMinutes" INTEGER NOT NULL DEFAULT 2;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "canHandleGroundBlock" BOOLEAN,
ADD COLUMN     "canOperateMhe" BOOLEAN;

