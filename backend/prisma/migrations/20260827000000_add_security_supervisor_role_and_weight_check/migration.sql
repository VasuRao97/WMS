-- Gate In/Out screen build, 2026-08-27: a new SECURITY_SUPERVISOR role tier
-- (same level as WAREHOUSE_SUPERVISOR, different access surface), a
-- per-company toggle to restrict Gate/Yard access to it, a per-vehicle max
-- capacity override, and a manual invoice-weight field for the Outbound
-- overweight check. See schema.prisma's comments for the full reasoning.

-- Not used anywhere else in this same migration, so no "unsafe use of new
-- value" issue (Postgres only forbids using a just-added enum value within
-- the same transaction that added it).
ALTER TYPE "Role" ADD VALUE 'SECURITY_SUPERVISOR';

ALTER TABLE "Company" ADD COLUMN "restrictGateAccessToSecuritySupervisor" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Vehicle" ADD COLUMN "maxTonnage" DECIMAL(65,30);

ALTER TABLE "VehicleGateEntry" ADD COLUMN "invoiceWeightKg" DECIMAL(65,30);
