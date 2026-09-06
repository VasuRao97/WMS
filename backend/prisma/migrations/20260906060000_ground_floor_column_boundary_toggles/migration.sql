-- AlterTable
-- 2026-09-06 — Ground/Floor Putaway design (see wms-putaway-design memory).
-- WarehouseStorageType.maxSkusClassA/B/C already governs how many distinct
-- SKUs may share one bin across its columns; these four booleans are a
-- separate, independent question — whether a single COLUMN must stay
-- internally single-SKU ("respects column boundaries") or can mix
-- different SKUs at different depths within the same column. Meaningless
-- for non-Ground storage types (Rack has no "column" concept to subdivide
-- further) — read only when storageType is GROUND_FLOOR.
ALTER TABLE "WarehouseStorageType" ADD COLUMN "respectsColumnBoundariesClassA" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "WarehouseStorageType" ADD COLUMN "respectsColumnBoundariesClassB" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "WarehouseStorageType" ADD COLUMN "respectsColumnBoundariesClassC" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "WarehouseStorageType" ADD COLUMN "respectsColumnBoundariesClassD" BOOLEAN NOT NULL DEFAULT false;
