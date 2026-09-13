-- Dock zone: 4-wall model, step 1 of 2 (2026-09-10) — "in our dock setting
-- page, we have to keep 4 options... how will that even work" — a real,
-- correct catch. WarehouseDockZone.nearAisleEnd only ever captured which
-- end of the AISLE sequence (LOW/HIGH, e.g. near Aisle 1 vs. near the
-- highest-numbered aisle) — a real dock sits along one WALL of the
-- building, and a wall can just as easily be the front/back of every aisle
-- (the ROW axis — Row 1 nearest the corner through Row N farthest) as
-- either aisle-sequence end. This adds the two missing values only; the
-- ranking/placement logic that will actually USE them is deliberately a
-- separate, later step ("then we talk step by step") — not used anywhere
-- in this same migration, so no "unsafe use of a just-added enum value"
-- issue (Postgres only forbids using a value within the same transaction
-- that added it), same pattern as SECURITY_SUPERVISOR/VOICE_CALL before.
ALTER TYPE "DockZoneAisleEnd" ADD VALUE 'ROW_LOW';
ALTER TYPE "DockZoneAisleEnd" ADD VALUE 'ROW_HIGH';
