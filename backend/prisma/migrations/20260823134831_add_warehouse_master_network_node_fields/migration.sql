-- AlterTable
ALTER TABLE "Warehouse" ADD COLUMN     "areaSqFt" DECIMAL(65,30),
ADD COLUMN     "city" TEXT,
ADD COLUMN     "noOfDocks" INTEGER,
ADD COLUMN     "nodeType" TEXT,
ADD COLUMN     "pincode" TEXT,
ADD COLUMN     "threePlName" TEXT;

-- CreateTable
CREATE TABLE "WarehouseStorageType" (
    "id" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "storageType" TEXT NOT NULL,
    "palletPositions" DECIMAL(65,30) NOT NULL,

    CONSTRAINT "WarehouseStorageType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WarehouseDispatchFlow" (
    "id" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "flowType" TEXT NOT NULL,

    CONSTRAINT "WarehouseDispatchFlow_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "WarehouseStorageType" ADD CONSTRAINT "WarehouseStorageType_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WarehouseDispatchFlow" ADD CONSTRAINT "WarehouseDispatchFlow_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
