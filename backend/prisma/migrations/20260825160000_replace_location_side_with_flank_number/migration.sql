-- Location: retire `side` (only ever used by throwaway test data — no real
-- warehouse data has ever depended on it, confirmed before writing this
-- migration) in favor of `flankNumber`, a global warehouse-wide integer
-- identity for a whole flank (see schema.prisma's comment on
-- Location.flankNumber for the full reasoning).
ALTER TABLE "Location" DROP COLUMN "side";
ALTER TABLE "Location" ADD COLUMN     "flankNumber" INTEGER;
