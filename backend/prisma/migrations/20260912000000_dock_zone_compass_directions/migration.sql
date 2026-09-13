-- Dock zone: rename to compass directions (2026-09-12) — a direct, correct
-- client catch: "aisle one has 2 sides? how can you know which side dude?
-- not the right way, easiest way - north south west east and in the
-- location area put that direction marking in a corner!" The LOW/HIGH/
-- ROW_LOW/ROW_HIGH names required mentally tracking "which end of the
-- aisle-number sequence" and "which end of the row-number sequence" —
-- abstract and error-prone. Compass directions tied to the Plan View's own
-- fixed rendering orientation (a compass rose now drawn in its corner) are
-- immediately visual instead: look at the picture, see which wall the dock
-- touches.
--
-- Pure rename, not a new value — `ALTER TYPE ... RENAME VALUE` (supported
-- since Postgres 10, unlike DROP VALUE) updates every existing row's value
-- in place, so TNR8's own real OUTBOUND/LOW zone becomes OUTBOUND/EAST
-- automatically, with no separate backfill needed. Mapping (matches
-- LocationsPlanView.tsx's own layout: Aisle 1/Row 1 both anchor to the
-- bottom-right corner, aisles growing left, rows growing up):
--   LOW  (near Aisle 1, the right edge of the Plan View)   -> EAST
--   HIGH (near the last aisle, the left edge)               -> WEST
--   ROW_LOW  (near Row 1, the bottom edge)                  -> SOUTH
--   ROW_HIGH (near Row N, the top edge)                     -> NORTH
ALTER TYPE "DockZoneAisleEnd" RENAME VALUE 'LOW' TO 'EAST';
ALTER TYPE "DockZoneAisleEnd" RENAME VALUE 'HIGH' TO 'WEST';
ALTER TYPE "DockZoneAisleEnd" RENAME VALUE 'ROW_LOW' TO 'SOUTH';
ALTER TYPE "DockZoneAisleEnd" RENAME VALUE 'ROW_HIGH' TO 'NORTH';

-- The column name itself ("near AISLE end") no longer accurately describes
-- what's stored now that it also covers the row axis — renamed to the
-- neutral "dockSide" so a future reader isn't misled the same way this
-- session was. The enum TYPE name gets the same treatment.
ALTER TABLE "WarehouseDockZone" RENAME COLUMN "nearAisleEnd" TO "dockSide";
ALTER TYPE "DockZoneAisleEnd" RENAME TO "DockCompassDirection";
