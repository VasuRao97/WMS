/*
  Warnings:

  - A unique constraint covering the columns `[companyId,code]` on the table `Sku` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[companyId,code]` on the table `Warehouse` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "Sku_code_key";

-- DropIndex
DROP INDEX "Warehouse_code_key";

-- AlterTable
ALTER TABLE "Warehouse" ADD COLUMN     "latitude" DOUBLE PRECISION,
ADD COLUMN     "longitude" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "pan" TEXT,
    "billingAddress" TEXT,
    "pincode" TEXT,
    "state" TEXT,
    "gstNumber" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "companyId" TEXT NOT NULL,
    "erpCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerShipTo" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "pincode" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "gstNumber" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerShipTo_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Customer_companyId_code_key" ON "Customer"("companyId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Sku_companyId_code_key" ON "Sku"("companyId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Warehouse_companyId_code_key" ON "Warehouse"("companyId", "code");

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerShipTo" ADD CONSTRAINT "CustomerShipTo_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
