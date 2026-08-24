-- User: cached "last seen" timestamp, kept in sync with LoginEvent below.
ALTER TABLE "User" ADD COLUMN "lastLoginAt" TIMESTAMP(3);

-- LoginEvent: append-only login ledger, one row per successful login.
-- First-level capture only — records raw data for a future manpower-
-- attendance report, doesn't build the report/rollup itself yet.
CREATE TABLE "LoginEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "loggedInAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoginEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LoginEvent_userId_loggedInAt_idx" ON "LoginEvent"("userId", "loggedInAt");

ALTER TABLE "LoginEvent" ADD CONSTRAINT "LoginEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
