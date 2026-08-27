-- "Complete Inward Process" (2026-08-27) — a deliberate human close-out,
-- distinct from the matched order simply reaching RECEIVED status. See
-- schema.prisma's comment on VehicleGateEntry.inwardCompletedAt.
ALTER TABLE "VehicleGateEntry" ADD COLUMN "inwardCompletedAt" TIMESTAMP(3);
ALTER TABLE "VehicleGateEntry" ADD COLUMN "inwardCompletedById" TEXT;
ALTER TABLE "VehicleGateEntry" ADD COLUMN "inwardCompletionRemarks" TEXT;

ALTER TABLE "VehicleGateEntry" ADD CONSTRAINT "VehicleGateEntry_inwardCompletedById_fkey" FOREIGN KEY ("inwardCompletedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
