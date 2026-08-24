-- User: free-text specialization label for Supervisor/Operator (e.g. "Inbound Sup",
-- "Shift Sup", "Picking"). Descriptive only, not read by any permission check.
ALTER TABLE "User" ADD COLUMN "functionTag" TEXT;
