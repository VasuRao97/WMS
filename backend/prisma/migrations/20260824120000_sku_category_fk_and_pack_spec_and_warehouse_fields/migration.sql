-- Warehouse: GSTIN, facility hours, primary contact.
ALTER TABLE "Warehouse" ADD COLUMN     "gstin" TEXT,
ADD COLUMN     "workingDays" TEXT,
ADD COLUMN     "workingHours" TEXT,
ADD COLUMN     "contactName" TEXT,
ADD COLUMN     "contactPhone" TEXT;

-- CategoryPackSpec: physical dimensions of a Category's packaging at a given
-- unit level (EACH/INNER/CASE/PALLET), so a correction cascades to every SKU
-- in that category instead of being edited per-SKU.
CREATE TABLE "CategoryPackSpec" (
    "id" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "unitType" TEXT NOT NULL,
    "lengthCm" DECIMAL(65,30),
    "widthCm" DECIMAL(65,30),
    "heightCm" DECIMAL(65,30),
    "weightKg" DECIMAL(65,30),

    CONSTRAINT "CategoryPackSpec_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CategoryPackSpec_categoryId_unitType_key" ON "CategoryPackSpec"("categoryId", "unitType");

ALTER TABLE "CategoryPackSpec" ADD CONSTRAINT "CategoryPackSpec_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ProductCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Sku.category: free text -> categoryId FK into ProductCategory, so SKU
-- category and the Warehouse storage-type breakdown's category are
-- guaranteed to be the same curated list, not two strings that can drift.
ALTER TABLE "Sku" ADD COLUMN     "categoryId" TEXT,
ADD COLUMN     "primaryStorageUnit" TEXT;

-- Backfill: match existing free-text category by name (case-insensitive),
-- falling back to "Uncategorized" for anything that doesn't match the
-- curated list (e.g. a value typed before this list existed).
UPDATE "Sku" s SET "categoryId" = COALESCE(
    (SELECT pc.id FROM "ProductCategory" pc WHERE lower(pc.name) = lower(s.category)),
    (SELECT pc.id FROM "ProductCategory" pc WHERE pc.name = 'Uncategorized')
);

ALTER TABLE "Sku" ALTER COLUMN "categoryId" SET NOT NULL;
ALTER TABLE "Sku" DROP COLUMN "category";

ALTER TABLE "Sku" ADD CONSTRAINT "Sku_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ProductCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
