-- Detention cost/alerting, a multi-channel (SMS/Email/WhatsApp) notification
-- framework, and a basic self-service driver check-in table (2026-08-27
-- design conversation). See schema.prisma's comments on each model for the
-- full reasoning; CLAUDE.md has the conversation this came out of. Schema
-- only — no provider is wired up, and no cron job exists yet to actually
-- fire an alert; this just gives both a place to land.

-- Detention: cost always accrues from Gate In with no grace period (the
-- client's own call), computed live at read time — nothing here stores a
-- computed cost, only the rate itself.
ALTER TABLE "VehicleType" ADD COLUMN "detentionCostPerDay" DECIMAL(65,30);
ALTER TABLE "Vehicle" ADD COLUMN "detentionCostPerDay" DECIMAL(65,30);

-- Detention alerting thresholds — separate from the cost calculation above,
-- purely about when to notify someone. Both nullable: unset means no alerts
-- configured for that company yet.
ALTER TABLE "Company" ADD COLUMN "detentionAlertHours" INTEGER;
ALTER TABLE "Company" ADD COLUMN "detentionEscalationHours" INTEGER;

CREATE TYPE "NotificationChannel" AS ENUM ('SMS', 'EMAIL', 'WHATSAPP');
CREATE TYPE "NotificationEventType" AS ENUM ('DETENTION_ALERT');
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'ACKNOWLEDGED');

-- Per-company, per-channel config — a child table since a company can
-- enable more than one channel at once. No provider API key/secret lives
-- here on purpose — that stays in environment config until this gets real
-- encryption-at-rest.
CREATE TABLE "CompanyNotificationChannel" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT false,
    "senderId" TEXT,
    "fromAddress" TEXT,
    "providerName" TEXT,

    CONSTRAINT "CompanyNotificationChannel_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CompanyNotificationChannel_companyId_channel_key" ON "CompanyNotificationChannel"("companyId", "channel");

ALTER TABLE "CompanyNotificationChannel" ADD CONSTRAINT "CompanyNotificationChannel_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The audit/delivery/escalation trail — one row per notification sent (or
-- attempted). referenceType/referenceId is a free-text pointer, same
-- pattern as StockMovement.referenceType, since event types are meant to
-- grow beyond gate-entry-linked ones later.
CREATE TABLE "NotificationLog" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "warehouseId" TEXT,
    "eventType" "NotificationEventType" NOT NULL,
    "referenceType" TEXT,
    "referenceId" TEXT,
    "channel" "NotificationChannel" NOT NULL,
    "recipientUserId" TEXT NOT NULL,
    "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "message" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3),
    "acknowledgedAt" TIMESTAMP(3),
    "escalatedAt" TIMESTAMP(3),
    "escalatedToId" TEXT,
    "providerMessageId" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "NotificationLog_companyId_eventType_status_idx" ON "NotificationLog"("companyId", "eventType", "status");

ALTER TABLE "NotificationLog" ADD CONSTRAINT "NotificationLog_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NotificationLog" ADD CONSTRAINT "NotificationLog_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NotificationLog" ADD CONSTRAINT "NotificationLog_recipientUserId_fkey" FOREIGN KEY ("recipientUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NotificationLog" ADD CONSTRAINT "NotificationLog_escalatedToId_fkey" FOREIGN KEY ("escalatedToId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TYPE "SelfCheckInStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED');

-- Deliberately isolated from Vehicle/Driver/VehicleGateEntry — a driver has
-- no login/User account anywhere in this system, so this holds a driver's
-- own unverified self-submitted claim until a security guard reviews it.
-- Only ACCEPTED produces a real VehicleGateEntry.
CREATE TABLE "SelfCheckInRequest" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "vehicleNumberText" TEXT NOT NULL,
    "driverNameText" TEXT NOT NULL,
    "driverPhoneText" TEXT,
    "purpose" "GateEntryPurpose",
    "status" "SelfCheckInStatus" NOT NULL DEFAULT 'PENDING',
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "resultingGateEntryId" TEXT,

    CONSTRAINT "SelfCheckInRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SelfCheckInRequest_resultingGateEntryId_key" ON "SelfCheckInRequest"("resultingGateEntryId");
CREATE INDEX "SelfCheckInRequest_warehouseId_status_idx" ON "SelfCheckInRequest"("warehouseId", "status");

ALTER TABLE "SelfCheckInRequest" ADD CONSTRAINT "SelfCheckInRequest_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SelfCheckInRequest" ADD CONSTRAINT "SelfCheckInRequest_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SelfCheckInRequest" ADD CONSTRAINT "SelfCheckInRequest_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SelfCheckInRequest" ADD CONSTRAINT "SelfCheckInRequest_resultingGateEntryId_fkey" FOREIGN KEY ("resultingGateEntryId") REFERENCES "VehicleGateEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
