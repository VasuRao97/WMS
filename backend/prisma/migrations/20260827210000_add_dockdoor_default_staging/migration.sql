-- DockDoor's own default staging Location (2026-08-27, live-testing
-- follow-up — "we still need to set the staging area against each dock").
-- Optional; Match Order pre-fills from it client-side but staff can still
-- override. Does NOT touch VehicleGateEntry.assignedDockNumber, which
-- stays free text as before.
ALTER TABLE "DockDoor" ADD COLUMN "defaultStagingLocationId" TEXT;
ALTER TABLE "DockDoor" ADD CONSTRAINT "DockDoor_defaultStagingLocationId_fkey" FOREIGN KEY ("defaultStagingLocationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;
