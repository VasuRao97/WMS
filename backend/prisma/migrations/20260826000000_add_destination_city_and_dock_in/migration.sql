-- Yard Management, second pass (2026-08-26): a simplified single-city
-- Destination field (reintroduced after the original multi-point version
-- was scrapped) and a lightweight "Docked In" trigger that stands in for
-- real Dock Scheduling (not built yet) — see schema.prisma's comments on
-- VehicleGateEntry for the full reasoning.
ALTER TABLE "VehicleGateEntry" ADD COLUMN "destinationCity" TEXT;
ALTER TABLE "VehicleGateEntry" ADD COLUMN "dockedInAt" TIMESTAMP(3);
ALTER TABLE "VehicleGateEntry" ADD COLUMN "dockedInById" TEXT;

ALTER TABLE "VehicleGateEntry" ADD CONSTRAINT "VehicleGateEntry_dockedInById_fkey" FOREIGN KEY ("dockedInById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
