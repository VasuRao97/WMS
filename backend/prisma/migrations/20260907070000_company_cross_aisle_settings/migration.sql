-- 3D Plan View rendering preference: how many Rack bays / Ground bins get
-- placed flush before a real cross-aisle gap appears. Nullable, DB default
-- 10 for both so every existing company (and every new row inserted before
-- app code catches up) gets the confirmed default automatically, no
-- separate backfill statement needed.
ALTER TABLE "Company" ADD COLUMN "rackBaysPerCrossAisle" INTEGER DEFAULT 10;
ALTER TABLE "Company" ADD COLUMN "groundBinsPerCrossAisle" INTEGER DEFAULT 10;
