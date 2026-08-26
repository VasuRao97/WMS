-- Detention free-time window (2026-08-27, correcting the earlier "no grace
-- period" call — "one mistake, you were right"). Cost now only starts
-- accruing past this many hours of dwell; the daily rate then applies per
-- 24-hour period measured from the END of this window. Defaults to 4 (the
-- client's own placeholder), backfilling every existing company the same
-- way detentionCostPerDay's DEFAULT 15000 did.
ALTER TABLE "Company" ADD COLUMN "detentionFreeHours" INTEGER DEFAULT 4;
