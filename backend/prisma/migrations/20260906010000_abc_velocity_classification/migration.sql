-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "abcReassessmentEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "abcClassAPercent" DECIMAL(65,30) NOT NULL DEFAULT 75,
ADD COLUMN     "abcClassBPercent" DECIMAL(65,30) NOT NULL DEFAULT 15,
ADD COLUMN     "abcClassCPercent" DECIMAL(65,30) NOT NULL DEFAULT 10,
ADD COLUMN     "abcAssessmentWindowMonths" INTEGER NOT NULL DEFAULT 3;

-- CreateEnum
CREATE TYPE "ReslottingSuggestionType" AS ENUM ('RESLOT', 'CONSOLIDATE');

-- CreateEnum
CREATE TYPE "ReslottingSuggestionStatus" AS ENUM ('PENDING', 'ACTIONED', 'DISMISSED');

-- CreateTable
CREATE TABLE "SkuWarehouseClass" (
    "id" TEXT NOT NULL,
    "skuId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "abcClass" TEXT NOT NULL,
    "dispatchedQty" DECIMAL(65,30) NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SkuWarehouseClass_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HistoricalDispatchSeed" (
    "id" TEXT NOT NULL,
    "skuId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "month" TIMESTAMP(3) NOT NULL,
    "quantity" DECIMAL(65,30) NOT NULL,
    "importedById" TEXT NOT NULL,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HistoricalDispatchSeed_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReslottingSuggestion" (
    "id" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "skuId" TEXT NOT NULL,
    "type" "ReslottingSuggestionType" NOT NULL,
    "suggestedLocationId" TEXT,
    "reason" TEXT NOT NULL,
    "status" "ReslottingSuggestionStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actionedAt" TIMESTAMP(3),
    "actionedById" TEXT,

    CONSTRAINT "ReslottingSuggestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReslottingSuggestionSource" (
    "id" TEXT NOT NULL,
    "suggestionId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "quantity" DECIMAL(65,30) NOT NULL,

    CONSTRAINT "ReslottingSuggestionSource_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SkuWarehouseClass_skuId_warehouseId_key" ON "SkuWarehouseClass"("skuId", "warehouseId");

-- CreateIndex
CREATE UNIQUE INDEX "HistoricalDispatchSeed_skuId_warehouseId_month_key" ON "HistoricalDispatchSeed"("skuId", "warehouseId", "month");

-- AddForeignKey
ALTER TABLE "SkuWarehouseClass" ADD CONSTRAINT "SkuWarehouseClass_skuId_fkey" FOREIGN KEY ("skuId") REFERENCES "Sku"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SkuWarehouseClass" ADD CONSTRAINT "SkuWarehouseClass_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HistoricalDispatchSeed" ADD CONSTRAINT "HistoricalDispatchSeed_skuId_fkey" FOREIGN KEY ("skuId") REFERENCES "Sku"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HistoricalDispatchSeed" ADD CONSTRAINT "HistoricalDispatchSeed_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HistoricalDispatchSeed" ADD CONSTRAINT "HistoricalDispatchSeed_importedById_fkey" FOREIGN KEY ("importedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReslottingSuggestion" ADD CONSTRAINT "ReslottingSuggestion_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReslottingSuggestion" ADD CONSTRAINT "ReslottingSuggestion_skuId_fkey" FOREIGN KEY ("skuId") REFERENCES "Sku"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReslottingSuggestion" ADD CONSTRAINT "ReslottingSuggestion_suggestedLocationId_fkey" FOREIGN KEY ("suggestedLocationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReslottingSuggestion" ADD CONSTRAINT "ReslottingSuggestion_actionedById_fkey" FOREIGN KEY ("actionedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReslottingSuggestionSource" ADD CONSTRAINT "ReslottingSuggestionSource_suggestionId_fkey" FOREIGN KEY ("suggestionId") REFERENCES "ReslottingSuggestion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReslottingSuggestionSource" ADD CONSTRAINT "ReslottingSuggestionSource_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
