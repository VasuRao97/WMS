-- Putaway skeleton (2026-08-28) — schema only, after a long workflow design
-- conversation (see the wms-putaway-design memory for the full context).
-- No service/controller/frontend logic in this migration — "finish this
-- skeleton coding first then we put actual logics" per the client's own
-- explicit sequencing. PutawayTask confirmed empty (0 rows) before this
-- ran, so no backfill needed for any of the column changes below.

-- PutawayStatus gains NEEDS_BIN — a task the slotting algorithm couldn't
-- find any eligible bin for yet. Not used elsewhere in this same
-- migration, so no transaction-ordering issue.
ALTER TYPE "PutawayStatus" ADD VALUE 'NEEDS_BIN';

-- PutawayTriggerMode (Company.putawayTriggerMode) — BATCH vs IMMEDIATE.
CREATE TYPE "PutawayTriggerMode" AS ENUM ('BATCH', 'IMMEDIATE');

ALTER TABLE "Company" ADD COLUMN "putawayTriggerMode" "PutawayTriggerMode" NOT NULL DEFAULT 'BATCH';
ALTER TABLE "Company" ADD COLUMN "putawayDefaultBatchQty" DECIMAL(65,30);

ALTER TABLE "Sku" ADD COLUMN "putawayBatchQty" DECIMAL(65,30);

-- PutawayTask reshape: toLocationId becomes nullable (see PutawayStatus.
-- NEEDS_BIN), completion moves off this table entirely onto the new
-- PutawayTrip child table below (a task can have several trips, done by
-- different people — a single completedById/completedAt no longer fits),
-- and openForAccumulation supports the IMMEDIATE trigger mode's
-- accumulator behavior.
ALTER TABLE "PutawayTask" ALTER COLUMN "toLocationId" DROP NOT NULL;
ALTER TABLE "PutawayTask" DROP CONSTRAINT "PutawayTask_completedById_fkey";
ALTER TABLE "PutawayTask" DROP COLUMN "completedById";
ALTER TABLE "PutawayTask" DROP COLUMN "completedAt";
ALTER TABLE "PutawayTask" ADD COLUMN "openForAccumulation" BOOLEAN NOT NULL DEFAULT false;

-- PutawayTrip — one row per physical trip (staging scan claims it,
-- location scan completes it). Quantity moved so far is derived by
-- summing this table's COMPLETED rows per task, never a separate stored
-- counter on PutawayTask.
CREATE TYPE "PutawayTripStatus" AS ENUM ('IN_PROGRESS', 'COMPLETED', 'ABANDONED');

CREATE TABLE "PutawayTrip" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "quantity" DECIMAL(65,30) NOT NULL,
    "status" "PutawayTripStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "claimedById" TEXT NOT NULL,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stagingBarcodeScanned" TEXT,
    "scannedLocationId" TEXT,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "PutawayTrip_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "PutawayTrip" ADD CONSTRAINT "PutawayTrip_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "PutawayTask"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PutawayTrip" ADD CONSTRAINT "PutawayTrip_claimedById_fkey" FOREIGN KEY ("claimedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PutawayTrip" ADD CONSTRAINT "PutawayTrip_scannedLocationId_fkey" FOREIGN KEY ("scannedLocationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- PutawayReassignment — "request different bin" audit trail.
CREATE TABLE "PutawayReassignment" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "previousLocationId" TEXT,
    "newLocationId" TEXT,
    "reason" TEXT,
    "requestedById" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PutawayReassignment_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "PutawayReassignment" ADD CONSTRAINT "PutawayReassignment_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "PutawayTask"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PutawayReassignment" ADD CONSTRAINT "PutawayReassignment_previousLocationId_fkey" FOREIGN KEY ("previousLocationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PutawayReassignment" ADD CONSTRAINT "PutawayReassignment_newLocationId_fkey" FOREIGN KEY ("newLocationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PutawayReassignment" ADD CONSTRAINT "PutawayReassignment_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- MultiSkuLaneException — the only bypass for the mandatory single-SKU-
-- per-multi-deep-lane rule: a real request/approve/revoke audit record,
-- warehouse-wide scope, requested only by a Warehouse Manager, decided
-- only by a Company Admin.
CREATE TYPE "MultiSkuLaneExceptionStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'REVOKED');

CREATE TABLE "MultiSkuLaneException" (
    "id" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "MultiSkuLaneExceptionStatus" NOT NULL DEFAULT 'PENDING',
    "requestedById" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "revokedById" TEXT,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "MultiSkuLaneException_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "MultiSkuLaneException" ADD CONSTRAINT "MultiSkuLaneException_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MultiSkuLaneException" ADD CONSTRAINT "MultiSkuLaneException_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MultiSkuLaneException" ADD CONSTRAINT "MultiSkuLaneException_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MultiSkuLaneException" ADD CONSTRAINT "MultiSkuLaneException_revokedById_fkey" FOREIGN KEY ("revokedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
