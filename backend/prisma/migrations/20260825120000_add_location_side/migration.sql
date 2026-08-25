-- Location: add `side` (nullable text) so the range generator can record
-- which flank of an aisle a row belongs to — blank = primary side, 'B' =
-- secondary side (manually-typed Second Range, or the "mirror" checkbox).
-- Existing rows get NULL, which the Plan View treats as single-flank (safe
-- default — never invents a second flank that doesn't really exist).
ALTER TABLE "Location" ADD COLUMN     "side" TEXT;
