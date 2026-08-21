/*
  Warnings:

  - You are about to drop the column `barcode` on the `Sku` table. All the data in the column will be lost.
  - You are about to drop the column `name` on the `Sku` table. All the data in the column will be lost.
  - You are about to drop the column `uom` on the `Sku` table. All the data in the column will be lost.
  - Added the required column `baseUom` to the `Sku` table without a default value. This is not possible if the table is not empty.
  - Added the required column `hsnCode` to the `Sku` table without a default value. This is not possible if the table is not empty.
  - Made the column `description` on table `Sku` required. This step will fail if there are existing NULL values in that column.
  - Made the column `category` on table `Sku` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "Sku" DROP COLUMN "barcode",
DROP COLUMN "name",
DROP COLUMN "uom",
ADD COLUMN     "abcClass" TEXT,
ADD COLUMN     "baseUom" TEXT NOT NULL,
ADD COLUMN     "batchTracked" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "currency" TEXT,
ADD COLUMN     "grossWeight" DECIMAL(65,30),
ADD COLUMN     "hasUniqueBarcode" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "hazmatClass" TEXT,
ADD COLUMN     "hsnCode" TEXT NOT NULL,
ADD COLUMN     "isHazmat" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "moq" DECIMAL(65,30),
ADD COLUMN     "shelfLifeDays" INTEGER,
ADD COLUMN     "shelfLifeTracked" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "standardCost" DECIMAL(65,30),
ADD COLUMN     "storageCondition" TEXT NOT NULL DEFAULT 'AMBIENT',
ADD COLUMN     "subCategory" TEXT,
ADD COLUMN     "weightUom" TEXT,
ALTER COLUMN "description" SET NOT NULL,
ALTER COLUMN "category" SET NOT NULL,
ALTER COLUMN "category" SET DEFAULT 'Uncategorized';

-- CreateTable
CREATE TABLE "SkuStorageUnit" (
    "id" TEXT NOT NULL,
    "skuId" TEXT NOT NULL,
    "unitType" TEXT NOT NULL,
    "qtyInBaseUom" DECIMAL(65,30) NOT NULL,
    "isPreferred" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "SkuStorageUnit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SkuBarcode" (
    "id" TEXT NOT NULL,
    "skuId" TEXT NOT NULL,
    "barcode" TEXT NOT NULL,
    "type" TEXT NOT NULL,

    CONSTRAINT "SkuBarcode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SkuRelationship" (
    "id" TEXT NOT NULL,
    "parentSkuId" TEXT NOT NULL,
    "childSkuId" TEXT NOT NULL,
    "quantity" DECIMAL(65,30) NOT NULL,

    CONSTRAINT "SkuRelationship_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "SkuStorageUnit" ADD CONSTRAINT "SkuStorageUnit_skuId_fkey" FOREIGN KEY ("skuId") REFERENCES "Sku"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SkuBarcode" ADD CONSTRAINT "SkuBarcode_skuId_fkey" FOREIGN KEY ("skuId") REFERENCES "Sku"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SkuRelationship" ADD CONSTRAINT "SkuRelationship_parentSkuId_fkey" FOREIGN KEY ("parentSkuId") REFERENCES "Sku"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SkuRelationship" ADD CONSTRAINT "SkuRelationship_childSkuId_fkey" FOREIGN KEY ("childSkuId") REFERENCES "Sku"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
