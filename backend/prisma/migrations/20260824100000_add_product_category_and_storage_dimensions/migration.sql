-- CreateTable
CREATE TABLE "ProductCategory" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "ProductCategory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProductCategory_name_key" ON "ProductCategory"("name");

-- AlterTable
ALTER TABLE "WarehouseStorageType" ADD COLUMN     "categoryId" TEXT NOT NULL,
ADD COLUMN     "lengthM" DECIMAL(65,30),
ADD COLUMN     "widthM" DECIMAL(65,30),
ADD COLUMN     "heightM" DECIMAL(65,30);

-- CreateIndex
CREATE UNIQUE INDEX "WarehouseStorageType_warehouseId_storageType_categoryId_key" ON "WarehouseStorageType"("warehouseId", "storageType", "categoryId");

-- AddForeignKey
ALTER TABLE "WarehouseStorageType" ADD CONSTRAINT "WarehouseStorageType_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ProductCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
