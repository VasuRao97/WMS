-- Move "aging methodology" (AgingGranularity) from Company to Warehouse
-- (2026-08-29) — a real correction caught in conversation: this was never
-- wired to any UI/API, and once actually building a Settings control for
-- it, the client's own call was that granularity is warehouse-specific,
-- not a single company-wide fact ("depends on the node the granularity
-- might be different"). Same shape as the earlier
-- EquipmentType -> WarehouseEquipmentSuitability correction. Company's
-- copy was never populated by any real workflow (no endpoint ever wrote
-- to it), so this is a straight drop-and-add, no data to migrate.

ALTER TABLE "Company" DROP COLUMN "agingGranularity";

ALTER TABLE "Warehouse" ADD COLUMN "agingGranularity" "AgingGranularity";
