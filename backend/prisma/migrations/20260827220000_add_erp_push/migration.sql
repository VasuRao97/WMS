-- ERP push (2026-08-27, live-built the same session it was discussed) —
-- a real, working alternative order-creation path alongside the manual
-- order maker and Excel import. See schema.prisma's comments on
-- Company.erpApiKey/allowErpInboundPush and InboundReceipt.createdById/
-- createdViaErpPush/vehicleId for the full reasoning.

-- OUR secret, issued to an external caller (opposite direction from a
-- third-party provider key) — checked via the X-Api-Key header.
ALTER TABLE "Company" ADD COLUMN "erpApiKey" TEXT;
ALTER TABLE "Company" ADD CONSTRAINT "Company_erpApiKey_key" UNIQUE ("erpApiKey");

-- createdById relaxed to nullable — an ERP push has no human on the other
-- end. The existing FK constraint tolerates NULL without any change.
ALTER TABLE "InboundReceipt" ALTER COLUMN "createdById" DROP NOT NULL;
ALTER TABLE "InboundReceipt" ADD COLUMN "createdViaErpPush" BOOLEAN NOT NULL DEFAULT false;
