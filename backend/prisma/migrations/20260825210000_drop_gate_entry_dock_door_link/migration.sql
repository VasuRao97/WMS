-- Decouple VehicleGateEntry from DockDoor entirely (2026-08-25) — rejected
-- by the client, not just the auto-flip status logic that used it. Dock
-- Door status is manual/staff-driven, and real dock *selection* logic still
-- needs its own design pass later. Both tables confirmed empty before this
-- migration, so no backfill needed.
ALTER TABLE "VehicleGateEntry" DROP CONSTRAINT "VehicleGateEntry_dockDoorId_fkey";
ALTER TABLE "VehicleGateEntry" DROP COLUMN "dockDoorId";
