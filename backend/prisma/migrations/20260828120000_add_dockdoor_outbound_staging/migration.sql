-- Outbound staging Location sibling on DockDoor (2026-08-28, Putaway
-- kickoff conversation) — see schema.prisma's comment on
-- DockDoor.outboundStagingLocationId. Mirrors the existing
-- defaultStagingLocationId FK shape exactly (nullable, SET NULL on delete).
ALTER TABLE "DockDoor" ADD COLUMN "outboundStagingLocationId" TEXT;
ALTER TABLE "DockDoor" ADD CONSTRAINT "DockDoor_outboundStagingLocationId_fkey" FOREIGN KEY ("outboundStagingLocationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;
