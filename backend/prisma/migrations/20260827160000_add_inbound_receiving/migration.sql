-- Inbound receiving (2026-08-27) — order matching + scan-based receiving.
-- See CLAUDE.md's "Inbound receiving" section for the full design.

-- New notification event: fires at Gate In (Inbound, docs all OK) to every
-- Supervisor/Manager on the warehouse. No value is used within this same
-- migration, so the "new enum value can't be used until committed"
-- restriction doesn't apply here.
ALTER TYPE "NotificationEventType" ADD VALUE 'VEHICLE_READY_FOR_UNLOADING';

-- Company-level toggle, schema-ready for a later ERP-push pass.
ALTER TABLE "Company" ADD COLUMN "allowErpInboundPush" BOOLEAN NOT NULL DEFAULT false;

-- Which pack level a barcode represents (case vs each vs pallet) — resolves
-- a scan's quantity multiplier via SkuStorageUnit.qtyInBaseUom. Nullable so
-- every existing barcode keeps working unchanged (defaults to "1 each").
ALTER TABLE "SkuBarcode" ADD COLUMN "storageUnitId" TEXT;
ALTER TABLE "SkuBarcode" ADD CONSTRAINT "SkuBarcode_storageUnitId_fkey" FOREIGN KEY ("storageUnitId") REFERENCES "SkuStorageUnit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The real, authoritative order match — set at a new step after Dock In,
-- distinct from the loose free-text VehicleGateEntry.referenceNo. Unique so
-- a given InboundReceipt can only ever be claimed by one gate visit.
ALTER TABLE "VehicleGateEntry" ADD COLUMN "inboundReceiptId" TEXT;
ALTER TABLE "VehicleGateEntry" ADD CONSTRAINT "VehicleGateEntry_inboundReceiptId_key" UNIQUE ("inboundReceiptId");
ALTER TABLE "VehicleGateEntry" ADD CONSTRAINT "VehicleGateEntry_inboundReceiptId_fkey" FOREIGN KEY ("inboundReceiptId") REFERENCES "InboundReceipt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The per-scan receiving log — capture is universal (every physical item
-- scanned), interpretation is tiered (ACCEPTED auto-matches cleanly,
-- BLOCKED needs a Supervisor to APPROVE or REJECT). See schema.prisma's
-- comment on InboundReceiptScan for the full status-flow reasoning.
CREATE TYPE "InboundScanStatus" AS ENUM ('ACCEPTED', 'BLOCKED', 'APPROVED', 'REJECTED');

CREATE TABLE "InboundReceiptScan" (
    "id" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "gateEntryId" TEXT NOT NULL,
    "barcodeScanned" TEXT NOT NULL,
    "skuId" TEXT,
    "receiptLineId" TEXT,
    "quantity" DECIMAL(65,30),
    "status" "InboundScanStatus" NOT NULL DEFAULT 'ACCEPTED',
    "blockReason" TEXT,
    "scannedById" TEXT NOT NULL,
    "scannedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),

    CONSTRAINT "InboundReceiptScan_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "InboundReceiptScan_receiptId_idx" ON "InboundReceiptScan"("receiptId");
CREATE INDEX "InboundReceiptScan_gateEntryId_status_idx" ON "InboundReceiptScan"("gateEntryId", "status");

ALTER TABLE "InboundReceiptScan" ADD CONSTRAINT "InboundReceiptScan_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "InboundReceipt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InboundReceiptScan" ADD CONSTRAINT "InboundReceiptScan_gateEntryId_fkey" FOREIGN KEY ("gateEntryId") REFERENCES "VehicleGateEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InboundReceiptScan" ADD CONSTRAINT "InboundReceiptScan_skuId_fkey" FOREIGN KEY ("skuId") REFERENCES "Sku"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "InboundReceiptScan" ADD CONSTRAINT "InboundReceiptScan_receiptLineId_fkey" FOREIGN KEY ("receiptLineId") REFERENCES "InboundReceiptLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "InboundReceiptScan" ADD CONSTRAINT "InboundReceiptScan_scannedById_fkey" FOREIGN KEY ("scannedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InboundReceiptScan" ADD CONSTRAINT "InboundReceiptScan_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
