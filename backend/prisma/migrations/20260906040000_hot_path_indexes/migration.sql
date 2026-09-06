-- CreateIndex
-- 2026-09-06 hardening-pass fix: PutawayTask, PutawayTrip, and
-- InboundReceiptLine are all append-only, unboundedly-growing logs that had
-- NO indexes at all beyond their primary key, despite being queried
-- constantly by exactly the shapes below (checked against every real query
-- in the codebase before adding these — see schema.prisma's comments on
-- each model for the full reasoning, not speculative additions).

-- PutawayTask
CREATE INDEX "PutawayTask_receiptLineId_idx" ON "PutawayTask"("receiptLineId");
CREATE INDEX "PutawayTask_toLocationId_status_idx" ON "PutawayTask"("toLocationId", "status");
CREATE INDEX "PutawayTask_status_openForAccumulation_idx" ON "PutawayTask"("status", "openForAccumulation");

-- PutawayTrip
CREATE INDEX "PutawayTrip_taskId_idx" ON "PutawayTrip"("taskId");
CREATE INDEX "PutawayTrip_claimedById_status_idx" ON "PutawayTrip"("claimedById", "status");
CREATE INDEX "PutawayTrip_status_claimedAt_idx" ON "PutawayTrip"("status", "claimedAt");

-- InboundReceiptLine
CREATE INDEX "InboundReceiptLine_receiptId_idx" ON "InboundReceiptLine"("receiptId");
CREATE INDEX "InboundReceiptLine_skuId_idx" ON "InboundReceiptLine"("skuId");
