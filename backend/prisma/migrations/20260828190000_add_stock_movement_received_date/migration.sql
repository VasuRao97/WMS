-- "Localized aging" (2026-08-28, Putaway design conversation) — a
-- deliberately simple stand-in for real manufacturing-date/batch tracking
-- (which stays parked). StockMovement.receivedDate carries the case-level
-- Inbound receiving date forward through every subsequent movement for
-- that same stock (RECEIPT -> PUTAWAY_OUT/IN -> future PICK/DISPATCH),
-- copied at write time, never recalculated — this is why it lives on the
-- one ledger that already threads through the whole lifecycle rather than
-- a Putaway-specific table. Nullable — existing rows have no captured
-- value, and the copy-forward logic itself isn't built yet (schema only).

ALTER TABLE "StockMovement" ADD COLUMN "receivedDate" TIMESTAMP(3);

-- Company.agingGranularity — how close two receivedDate values need to be
-- to count as "the same age" for the multi-deep-lane same-SKU top-up
-- exception. Null = no tolerance configured, safe default (must fully
-- empty a lane before new stock enters, same as no exception existing).
CREATE TYPE "AgingGranularity" AS ENUM ('DAY', 'WEEK', 'MONTH');

ALTER TABLE "Company" ADD COLUMN "agingGranularity" "AgingGranularity";
