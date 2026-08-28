-- Loaded/unloaded travel speed, km/h (2026-08-28, same session) — "i can
-- give you average speed of these MHEs during moving both loaded / non
-- loaded, lets consider that and store it." Schema laid down ahead of the
-- real figures (due separately, the client's own choice) so they can be
-- stored directly once given, no further migration needed. All nullable —
-- genericAvgTripMinutes/avgTripMinutes stay the fallback estimate until
-- these are populated and DockLocationDistance has real data to pair them
-- with.

ALTER TABLE "EquipmentType" ADD COLUMN "genericLoadedSpeedKmh" DECIMAL(65,30);
ALTER TABLE "EquipmentType" ADD COLUMN "genericUnloadedSpeedKmh" DECIMAL(65,30);

ALTER TABLE "Equipment" ADD COLUMN "loadedSpeedKmh" DECIMAL(65,30);
ALTER TABLE "Equipment" ADD COLUMN "unloadedSpeedKmh" DECIMAL(65,30);
