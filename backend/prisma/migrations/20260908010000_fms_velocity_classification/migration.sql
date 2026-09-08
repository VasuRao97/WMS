-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "fmsClassFPercent" DECIMAL(65,30) NOT NULL DEFAULT 75,
ADD COLUMN     "fmsClassMPercent" DECIMAL(65,30) NOT NULL DEFAULT 15,
ADD COLUMN     "fmsClassSPercent" DECIMAL(65,30) NOT NULL DEFAULT 10;

-- AlterTable
ALTER TABLE "SkuWarehouseClass" ADD COLUMN     "fmsClass" TEXT,
ADD COLUMN     "orderCount" DECIMAL(65,30);

-- AlterTable
ALTER TABLE "HistoricalDispatchSeed" ADD COLUMN     "orderCount" INTEGER;
