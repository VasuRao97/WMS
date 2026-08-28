-- Vehicle/Driver gain a home warehouse (2026-08-28) — reverses the
-- original "company-wide, not warehouse-scoped" visibility design. The
-- client's own real reason: different warehouses under one company tenant
-- can be run by different 3PLs, and one 3PL's registered fleet being
-- visible to another's staff is a genuine data-privacy leak. Nullable
-- (existing rows have no warehouse and stay invisible to warehouse-scoped
-- roles until fixed via the Vehicle & Driver Master edit form).
ALTER TABLE "Vehicle" ADD COLUMN "warehouseId" TEXT;
ALTER TABLE "Driver" ADD COLUMN "warehouseId" TEXT;

ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Driver" ADD CONSTRAINT "Driver_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "Vehicle_warehouseId_idx" ON "Vehicle"("warehouseId");
CREATE INDEX "Driver_warehouseId_idx" ON "Driver"("warehouseId");
