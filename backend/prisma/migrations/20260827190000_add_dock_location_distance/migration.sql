-- Dock <-> Location travel distance (2026-08-27, Inbound deep-dive
-- conversation) — schema-only, no service/controller/UI this pass. See
-- schema.prisma's comment on DockLocationDistance for the full reasoning:
-- the actual "which dock minimizes movement" algorithm plugs in once
-- Putaway/Picking logic exists to consume this data.
CREATE TABLE "DockLocationDistance" (
    "id" TEXT NOT NULL,
    "dockDoorId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "distanceMeters" DECIMAL(65,30) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DockLocationDistance_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DockLocationDistance_dockDoorId_locationId_key" ON "DockLocationDistance"("dockDoorId", "locationId");

ALTER TABLE "DockLocationDistance" ADD CONSTRAINT "DockLocationDistance_dockDoorId_fkey" FOREIGN KEY ("dockDoorId") REFERENCES "DockDoor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DockLocationDistance" ADD CONSTRAINT "DockLocationDistance_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
