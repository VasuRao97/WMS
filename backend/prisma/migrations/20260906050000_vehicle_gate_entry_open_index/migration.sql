-- CreateIndex
-- 2026-09-06 hardening-pass fix: NotificationLog is filtered by
-- referenceType+referenceId+eventType by both DetentionAlertScheduler
-- (every 5 min) and PutawayAssignmentScheduler (every 1 min) — the
-- existing composite's leading column (companyId) doesn't serve this at
-- all. See schema.prisma's comment on NotificationLog.
CREATE INDEX "NotificationLog_referenceType_referenceId_eventType_idx" ON "NotificationLog"("referenceType", "referenceId", "eventType");

-- CreateIndex (partial — not expressible in Prisma's schema DSL, see
-- schema.prisma's comment on VehicleGateEntry for the full reasoning)
-- {vehicleId, gateOutAt: null} is checked on every Gate In; {gateOutAt:
-- null} alone is scanned by two different schedulers every few minutes.
-- "Currently open" stays a small, roughly constant-sized slice of this
-- unboundedly-growing table regardless of how much closed history
-- accumulates, so a partial index stays fast rather than degrading over
-- the table's lifetime the way a plain composite index would.
CREATE INDEX "VehicleGateEntry_vehicleId_open_idx" ON "VehicleGateEntry"("vehicleId") WHERE "gateOutAt" IS NULL;
