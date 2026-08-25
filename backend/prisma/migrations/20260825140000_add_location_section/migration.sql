-- Location: add `section` (nullable text) — a manually-typed physical
-- section name, one Section per Aisle always (enforced in the service
-- layer via assertSectionConsistency, not a DB constraint, since it spans
-- a lookup across existing rows rather than a simple column check).
ALTER TABLE "Location" ADD COLUMN     "section" TEXT;
