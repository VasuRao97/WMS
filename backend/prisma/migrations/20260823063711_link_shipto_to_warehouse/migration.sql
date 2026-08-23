-- AlterTable
ALTER TABLE "CustomerShipTo" ADD COLUMN     "warehouseId" TEXT;

-- AddForeignKey
ALTER TABLE "CustomerShipTo" ADD CONSTRAINT "CustomerShipTo_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE SET NULL ON UPDATE CASCADE;
