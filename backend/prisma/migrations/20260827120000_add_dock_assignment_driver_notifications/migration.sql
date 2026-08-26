-- Dock assignment -> automated driver notification (2026-08-27) — closes
-- the "how does the driver know which dock to go to" gap. See
-- schema.prisma's comments on VehicleGateEntry.assignedDockNumber and
-- DriverDockNotification for the full reasoning; CLAUDE.md has the
-- conversation this came out of.

-- Not used anywhere else in this same migration, so no "unsafe use of new
-- value" issue (Postgres only forbids using a just-added enum value within
-- the same transaction that added it) — same pattern as SECURITY_SUPERVISOR.
ALTER TYPE "NotificationChannel" ADD VALUE 'VOICE_CALL';

ALTER TABLE "VehicleGateEntry" ADD COLUMN "assignedDockNumber" TEXT;
ALTER TABLE "VehicleGateEntry" ADD COLUMN "dockAssignedAt" TIMESTAMP(3);

CREATE TYPE "DockNotificationStage" AS ENUM ('INITIAL', 'FINAL_WARNING');

CREATE TABLE "DriverDockNotification" (
    "id" TEXT NOT NULL,
    "gateEntryId" TEXT NOT NULL,
    "stage" "DockNotificationStage" NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "driverPhone" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "sentAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DriverDockNotification_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DriverDockNotification_gateEntryId_stage_idx" ON "DriverDockNotification"("gateEntryId", "stage");

ALTER TABLE "DriverDockNotification" ADD CONSTRAINT "DriverDockNotification_gateEntryId_fkey" FOREIGN KEY ("gateEntryId") REFERENCES "VehicleGateEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
