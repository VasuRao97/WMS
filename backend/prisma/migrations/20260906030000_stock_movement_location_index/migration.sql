-- CreateIndex
-- 2026-09-06 hardening-pass fix: suggestBin(), the Plan View occupancy
-- overlay, and the Insights storage-utilization report all filter
-- StockMovement by locationId alone — the existing [skuId, locationId]
-- composite index (kept, untouched) can't serve that efficiently since its
-- leading column is skuId, not locationId. See schema.prisma's comment on
-- StockMovement for the full reasoning.
CREATE INDEX "StockMovement_locationId_idx" ON "StockMovement"("locationId");
