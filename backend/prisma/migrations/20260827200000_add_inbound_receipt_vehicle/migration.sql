-- Inbound order <-> Vehicle 1:1 mapping (2026-08-27, Inbound deep-dive
-- follow-up). Nullable at the DB level (a handful of pre-existing
-- throwaway-company receipts have no vehicle) but required by the service
-- layer on every new order going forward — see schema.prisma's comment on
-- InboundReceipt.vehicleId.
ALTER TABLE "InboundReceipt" ADD COLUMN "vehicleId" TEXT;
ALTER TABLE "InboundReceipt" ADD CONSTRAINT "InboundReceipt_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;
