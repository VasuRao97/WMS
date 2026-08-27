-- Staging location moves from required-per-line-at-order-creation to a
-- receipt-level default chosen at Match Order, once the vehicle is
-- actually at the dock (2026-08-27) — see schema.prisma's comment on
-- InboundReceipt.stagingLocationId for the full reasoning.
ALTER TABLE "InboundReceiptLine" ALTER COLUMN "stagingLocationId" DROP NOT NULL;

ALTER TABLE "InboundReceipt" ADD COLUMN "stagingLocationId" TEXT;
ALTER TABLE "InboundReceipt" ADD CONSTRAINT "InboundReceipt_stagingLocationId_fkey" FOREIGN KEY ("stagingLocationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;
