-- Dock zone: capture which end of the Aisle/Row NUMBERING sits nearest the
-- dock, instead of assuming it (2026-09-12, same-day follow-up to the
-- compass-direction rename) — see schema.prisma's own comment on
-- WarehouseDockZone.numberOneNearDock for the full reasoning. Real client
-- catch, live-testing Bin Rank against TNR8: "we need to have idea of from
-- where the row 1 starts... we need to get info during warehouse stage so
-- this issue doesnt pop up."
--
-- Backfilled to match EXACTLY what the old hardcoded assumption already
-- computed (dock-zone.util.ts, pre-this-migration): an EAST or SOUTH zone
-- treated Aisle/Row 1 as nearest the dock (numberOneNearDock = true, the
-- column default, so no separate UPDATE needed for those rows); a WEST or
-- NORTH zone treated the HIGHEST-numbered Aisle/Row as nearest instead
-- (numberOneNearDock = false). This is a zero-behavior-change backfill, not
-- a correction — it's still just the old, unconfirmed guess, carried
-- forward so every warehouse's live Bin Rank/placement results stay
-- identical the moment this ships. TNR8's own real NORTH zone becomes
-- `false` here, exactly matching the live value this session's diagnostic
-- calls already observed (Aisle 10's highest block, Block 20, scoring
-- best/AF) — still needs the client's real confirmation, not assumed
-- correct just because it round-trips.
ALTER TABLE "WarehouseDockZone" ADD COLUMN "numberOneNearDock" BOOLEAN NOT NULL DEFAULT true;

UPDATE "WarehouseDockZone" SET "numberOneNearDock" = false WHERE "dockSide" IN ('WEST', 'NORTH');
