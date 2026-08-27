-- Yard/Gate competitor-research follow-up (2026-08-27) — three cheap,
-- confirmed additions to VehicleGateEntry (see CLAUDE.md and the
-- wms-yms-competitor-research memory for the full discussion):
--   1. commodityDescription — free-text cargo visibility at Gate In.
--   2. physicalConditionOk/physicalConditionRemarks — a flat (no photos, no
--      itemized checklist) truck/trailer condition check, captured at Dock
--      In for both directions.
--   3. sealNumber/sealSignatureData(+capturedAt/By) — seal + signature
--      capture, timing branches by purpose in the service layer (Dock In
--      for Inbound, Gate Out for Outbound) but lives on one shared set of
--      columns either way.
ALTER TABLE "VehicleGateEntry" ADD COLUMN "commodityDescription" TEXT;
ALTER TABLE "VehicleGateEntry" ADD COLUMN "physicalConditionOk" BOOLEAN;
ALTER TABLE "VehicleGateEntry" ADD COLUMN "physicalConditionRemarks" TEXT;
ALTER TABLE "VehicleGateEntry" ADD COLUMN "sealNumber" TEXT;
ALTER TABLE "VehicleGateEntry" ADD COLUMN "sealSignatureData" TEXT;
ALTER TABLE "VehicleGateEntry" ADD COLUMN "sealCapturedAt" TIMESTAMP(3);
ALTER TABLE "VehicleGateEntry" ADD COLUMN "sealCapturedById" TEXT;

ALTER TABLE "VehicleGateEntry" ADD CONSTRAINT "VehicleGateEntry_sealCapturedById_fkey" FOREIGN KEY ("sealCapturedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
