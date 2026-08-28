-- Corrects the same-day EquipmentType-level activity matrix (2026-08-28) —
-- it had nowhere for anyone to actually edit it. The client's own explicit
-- call: "it should be warehouse wise! you can give dropdown for wh code and
-- give matrix." Moves the six suitability columns off EquipmentType (a
-- shared platform-wide row, only ever correctable by editing seed data) and
-- onto a new per-(Warehouse, EquipmentType) table, which gets a real
-- edit UI. EquipmentType table itself had zero real client data depending
-- on these six columns yet (Putaway task logic that would consume them was
-- never built) — dropped outright, no backfill needed.

ALTER TABLE "EquipmentType" DROP COLUMN "putawaySuitability";
ALTER TABLE "EquipmentType" DROP COLUMN "pickingSuitability";
ALTER TABLE "EquipmentType" DROP COLUMN "loadingSuitability";
ALTER TABLE "EquipmentType" DROP COLUMN "unloadingSuitability";
ALTER TABLE "EquipmentType" DROP COLUMN "consolidationSuitability";
ALTER TABLE "EquipmentType" DROP COLUMN "inventoryCheckSuitability";

CREATE TABLE "WarehouseEquipmentSuitability" (
    "id" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "equipmentTypeId" TEXT NOT NULL,
    "putawaySuitability" "EquipmentSuitability" NOT NULL DEFAULT 'NOT_USED',
    "pickingSuitability" "EquipmentSuitability" NOT NULL DEFAULT 'NOT_USED',
    "loadingSuitability" "EquipmentSuitability" NOT NULL DEFAULT 'NOT_USED',
    "unloadingSuitability" "EquipmentSuitability" NOT NULL DEFAULT 'NOT_USED',
    "consolidationSuitability" "EquipmentSuitability" NOT NULL DEFAULT 'NOT_USED',
    "inventoryCheckSuitability" "EquipmentSuitability" NOT NULL DEFAULT 'NOT_USED',

    CONSTRAINT "WarehouseEquipmentSuitability_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WarehouseEquipmentSuitability_warehouseId_equipmentTypeId_key" ON "WarehouseEquipmentSuitability"("warehouseId", "equipmentTypeId");

ALTER TABLE "WarehouseEquipmentSuitability" ADD CONSTRAINT "WarehouseEquipmentSuitability_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WarehouseEquipmentSuitability" ADD CONSTRAINT "WarehouseEquipmentSuitability_equipmentTypeId_fkey" FOREIGN KEY ("equipmentTypeId") REFERENCES "EquipmentType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
