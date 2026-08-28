// Default activity-suitability starting point for a newly created
// warehouse's Equipment Type matrix (2026-08-28) — consumed only by
// WarehousesService.generateEquipmentSuitability() to give a fresh
// warehouse a reasonable, fully-editable starting point, same "auto-
// generate a sensible default, edit later" convention as DockDoor/YardSlot.
// Built from general Indian-warehouse-operations reasoning, NOT this
// client's own confirmed practice — every value here is meant to be
// corrected per warehouse via PATCH /equipment/suitability-matrix, never
// treated as final. Keyed by EquipmentType.name (must match prisma/seed.ts's
// own names) — a type this map doesn't recognize (e.g. a future addition)
// simply defaults to NOT_USED across the board via NOT_USED_ROW rather than
// erroring.
export type SuitabilityLevel = 'PRIMARY' | 'SECONDARY' | 'NOT_USED';
export type SuitabilityRow = {
  putawaySuitability: SuitabilityLevel;
  pickingSuitability: SuitabilityLevel;
  loadingSuitability: SuitabilityLevel;
  unloadingSuitability: SuitabilityLevel;
  consolidationSuitability: SuitabilityLevel;
  inventoryCheckSuitability: SuitabilityLevel;
};

export const NOT_USED_ROW: SuitabilityRow = {
  putawaySuitability: 'NOT_USED',
  pickingSuitability: 'NOT_USED',
  loadingSuitability: 'NOT_USED',
  unloadingSuitability: 'NOT_USED',
  consolidationSuitability: 'NOT_USED',
  inventoryCheckSuitability: 'NOT_USED',
};

export const DEFAULT_EQUIPMENT_SUITABILITY: Record<string, SuitabilityRow> = {
  'Manual (Hand Carry)': { putawaySuitability: 'SECONDARY', pickingSuitability: 'SECONDARY', loadingSuitability: 'NOT_USED', unloadingSuitability: 'SECONDARY', consolidationSuitability: 'SECONDARY', inventoryCheckSuitability: 'PRIMARY' },
  'Hand Held Trolley': { putawaySuitability: 'SECONDARY', pickingSuitability: 'PRIMARY', loadingSuitability: 'SECONDARY', unloadingSuitability: 'SECONDARY', consolidationSuitability: 'SECONDARY', inventoryCheckSuitability: 'SECONDARY' },
  'HOPT (Hand Pallet Truck)': { putawaySuitability: 'SECONDARY', pickingSuitability: 'NOT_USED', loadingSuitability: 'PRIMARY', unloadingSuitability: 'PRIMARY', consolidationSuitability: 'SECONDARY', inventoryCheckSuitability: 'NOT_USED' },
  'BOPT (Battery Pallet Truck)': { putawaySuitability: 'SECONDARY', pickingSuitability: 'NOT_USED', loadingSuitability: 'PRIMARY', unloadingSuitability: 'PRIMARY', consolidationSuitability: 'SECONDARY', inventoryCheckSuitability: 'NOT_USED' },
  'Stacker (Walkie/Rider)': { putawaySuitability: 'PRIMARY', pickingSuitability: 'SECONDARY', loadingSuitability: 'SECONDARY', unloadingSuitability: 'SECONDARY', consolidationSuitability: 'SECONDARY', inventoryCheckSuitability: 'NOT_USED' },
  'Forklift (Electric, up to 2T)': { putawaySuitability: 'PRIMARY', pickingSuitability: 'NOT_USED', loadingSuitability: 'PRIMARY', unloadingSuitability: 'PRIMARY', consolidationSuitability: 'SECONDARY', inventoryCheckSuitability: 'NOT_USED' },
  'Forklift (Diesel/LPG, 2.5T+)': { putawaySuitability: 'PRIMARY', pickingSuitability: 'NOT_USED', loadingSuitability: 'PRIMARY', unloadingSuitability: 'PRIMARY', consolidationSuitability: 'SECONDARY', inventoryCheckSuitability: 'NOT_USED' },
  'Reach Truck (RT)': { putawaySuitability: 'PRIMARY', pickingSuitability: 'SECONDARY', loadingSuitability: 'SECONDARY', unloadingSuitability: 'SECONDARY', consolidationSuitability: 'SECONDARY', inventoryCheckSuitability: 'NOT_USED' },
  'Double Deep Reach Truck (DDRT)': { putawaySuitability: 'PRIMARY', pickingSuitability: 'SECONDARY', loadingSuitability: 'NOT_USED', unloadingSuitability: 'NOT_USED', consolidationSuitability: 'SECONDARY', inventoryCheckSuitability: 'NOT_USED' },
};
