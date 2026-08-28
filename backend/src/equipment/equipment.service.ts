import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CODE_REGEX } from '../common/validation.util';
import { companyFilter, ownWarehouseIds, EQUIPMENT_SCOPED_ROLES } from '../common/tenant.util';
import { toNumberOrUndefined } from '../common/xlsx-parse.util';

const EQUIPMENT_TYPE_SELECT = {
  id: true,
  name: true,
  genericPalletsPerTrip: true,
  genericAvgTripMinutes: true,
  genericLoadedSpeedKmh: true,
  genericUnloadedSpeedKmh: true,
} as const;

const EQUIPMENT_INCLUDE = {
  warehouse: { select: { id: true, code: true, name: true } },
  equipmentType: { select: EQUIPMENT_TYPE_SELECT },
} as const;

// "so we get all the mhe's in warehouse instantly" (2026-08-28, corrected
// same day — the matrix moved off EquipmentType onto per-warehouse
// WarehouseEquipmentSuitability, see that model's schema.prisma comment) —
// the six fixed activities the matrix is scored against. Maps a query-param
// activity name to the WarehouseEquipmentSuitability column that scores it.
const SUITABILITY_FIELDS = ['putawaySuitability', 'pickingSuitability', 'loadingSuitability', 'unloadingSuitability', 'consolidationSuitability', 'inventoryCheckSuitability'] as const;
type SuitabilityField = (typeof SUITABILITY_FIELDS)[number];
const ACTIVITY_SUITABILITY_FIELD: Record<string, SuitabilityField> = {
  PUTAWAY: 'putawaySuitability',
  PICKING: 'pickingSuitability',
  LOADING: 'loadingSuitability',
  UNLOADING: 'unloadingSuitability',
  CONSOLIDATION: 'consolidationSuitability',
  INVENTORY_CHECK: 'inventoryCheckSuitability',
};
const SUITABILITY_VALUES = ['PRIMARY', 'SECONDARY', 'NOT_USED'] as const;
const SUITABILITY_RANK: Record<string, number> = { PRIMARY: 0, SECONDARY: 1, NOT_USED: 2 };

// MHE (Material Handling Equipment) master — the foundation piece for
// Putaway (2026-08-28, "we need to get the MHE master at start, and work
// accordingly, the throughput of each mhe would be different"), built
// before any Putaway task logic. Same shape as DockDoorsService
// (warehouse-scoped physical asset, MASTER_DATA_WRITE_ROLES-gated
// create/edit/delete at the controller) but — unlike DockDoor, which is now
// fully auto-generated — Equipment IS manually registered here; there's no
// generator for MHE, a company just tells us what it owns.
@Injectable()
export class EquipmentService {
  constructor(private prisma: PrismaService) {}

  private async assertWarehouseAccess(warehouseId: string, user: any, errors: string[]) {
    const warehouse = await this.prisma.warehouse.findUnique({ where: { id: warehouseId } });
    if (!warehouse) {
      errors.push('Warehouse not found.');
      return;
    }
    if (user.role !== 'SUPER_ADMIN' && warehouse.companyId !== user.companyId) {
      errors.push('You do not have access to this warehouse.');
      return;
    }
    if (EQUIPMENT_SCOPED_ROLES.includes(user.role)) {
      const ids = await ownWarehouseIds(this.prisma, user.userId);
      if (!ids.includes(warehouseId)) errors.push('You can only manage equipment in your own assigned warehouse(s).');
    }
  }

  private async validate(data: any, errors: string[]): Promise<{ code: string; name?: string }> {
    const code = data.code ? String(data.code).trim().toUpperCase() : '';
    if (!code) errors.push('Equipment code is required.');
    else if (!CODE_REGEX.test(code)) errors.push('Equipment code must be 1-30 characters, letters/numbers/hyphens only.');

    if (!data.equipmentTypeId) {
      errors.push('Equipment Type is required.');
    } else {
      const type = await this.prisma.equipmentType.findUnique({ where: { id: data.equipmentTypeId } });
      if (!type) errors.push('Equipment Type not found.');
    }

    for (const [field, label] of [
      ['palletsPerTrip', 'Pallets Per Trip'],
      ['avgTripMinutes', 'Avg Trip Minutes'],
      ['loadedSpeedKmh', 'Loaded Speed (km/h)'],
      ['unloadedSpeedKmh', 'Unloaded Speed (km/h)'],
    ] as const) {
      const v = data[field];
      if (v !== undefined && v !== null && v !== '' && Number(v) <= 0) errors.push(`${label} must be a positive number when given.`);
    }

    return { code, name: data.name ? String(data.name).trim() : undefined };
  }

  async create(data: any, user: any) {
    if (!user.companyId) {
      throw new ForbiddenException('Super admin accounts cannot register equipment directly — log in as a company admin instead.');
    }
    const errors: string[] = [];
    const warehouseId = data.warehouseId;
    if (!warehouseId) errors.push('Warehouse is required.');
    else await this.assertWarehouseAccess(warehouseId, user, errors);
    const { code, name } = await this.validate(data, errors);
    if (errors.length > 0) throw new BadRequestException(errors);

    const existing = await this.prisma.equipment.findUnique({ where: { warehouseId_code: { warehouseId, code } } });
    if (existing) throw new BadRequestException(`Equipment with code "${code}" already exists in this warehouse.`);

    return this.prisma.equipment.create({
      data: {
        company: { connect: { id: user.companyId } },
        warehouse: { connect: { id: warehouseId } },
        code,
        name,
        equipmentType: { connect: { id: data.equipmentTypeId } },
        palletsPerTrip: toNumberOrUndefined(data.palletsPerTrip),
        avgTripMinutes: toNumberOrUndefined(data.avgTripMinutes),
        loadedSpeedKmh: toNumberOrUndefined(data.loadedSpeedKmh),
        unloadedSpeedKmh: toNumberOrUndefined(data.unloadedSpeedKmh),
      },
      include: EQUIPMENT_INCLUDE,
    });
  }

  // warehouseId/activity (2026-08-28, "so we get all the mhe's in warehouse
  // instantly") are both optional narrowing filters over the same base
  // list — plain findAll() (used by the Equipment master page) is
  // unaffected either way. An explicit warehouseId is checked against the
  // caller's own accessible set first, never blindly trusted (same real bug
  // class YardService.tracker() had before its 2026-08-27 fix — see
  // CLAUDE.md's "Gate & Yard live-testing fixes" section). `activity`
  // REQUIRES warehouseId (the matrix is scored per-warehouse now, not a
  // shared platform-wide fact — there's no meaningful "usable for Putaway"
  // answer without saying in which warehouse). Results narrow to *active*
  // units whose type scores PRIMARY/SECONDARY at that warehouse (NOT_USED
  // excluded), Primary-ranked first.
  async findAll(user: any, warehouseId?: string, activity?: string) {
    const where: any = { warehouse: { ...companyFilter(user) } };
    const accessibleIds = EQUIPMENT_SCOPED_ROLES.includes(user.role) ? await ownWarehouseIds(this.prisma, user.userId) : null;
    if (accessibleIds) where.warehouseId = { in: accessibleIds };

    if (warehouseId) {
      if (accessibleIds && !accessibleIds.includes(warehouseId)) {
        throw new ForbiddenException('You do not have access to this warehouse.');
      }
      const warehouse = await this.prisma.warehouse.findUnique({ where: { id: warehouseId } });
      if (!warehouse || (user.role !== 'SUPER_ADMIN' && warehouse.companyId !== user.companyId)) {
        throw new ForbiddenException('You do not have access to this warehouse.');
      }
      where.warehouseId = warehouseId;
    }

    let rankByType: Map<string, number> | undefined;
    if (activity) {
      if (!warehouseId) throw new BadRequestException('warehouseId is required when filtering by activity — the matrix is scored per warehouse.');
      const suitabilityField = ACTIVITY_SUITABILITY_FIELD[activity.toUpperCase()];
      if (!suitabilityField) {
        throw new BadRequestException(`Activity must be one of: ${Object.keys(ACTIVITY_SUITABILITY_FIELD).join(', ')}.`);
      }
      const matrixRows = await this.prisma.warehouseEquipmentSuitability.findMany({
        where: { warehouseId, [suitabilityField]: { in: ['PRIMARY', 'SECONDARY'] } },
        select: { equipmentTypeId: true, [suitabilityField]: true },
      });
      rankByType = new Map(matrixRows.map((r: any) => [r.equipmentTypeId, SUITABILITY_RANK[r[suitabilityField]]]));
      where.isActive = true;
      where.equipmentTypeId = { in: [...rankByType.keys()] };
    }

    const equipment = await this.prisma.equipment.findMany({ where, include: EQUIPMENT_INCLUDE, orderBy: [{ warehouse: { code: 'asc' } }, { code: 'asc' }] });
    if (!rankByType) return equipment;

    // Prisma can't order by a custom PRIMARY-before-SECONDARY rank without a
    // computed field — sorted here in JS instead, same pattern
    // DockDoorsService already uses for its own numeric-code re-sort.
    const ranks = rankByType;
    return equipment.sort((a, b) => (ranks.get(a.equipmentTypeId) ?? 9) - (ranks.get(b.equipmentTypeId) ?? 9));
  }

  // The real "input" surface for the activity matrix (2026-08-28, corrected
  // same day — see WarehouseEquipmentSuitability's schema.prisma comment):
  // one row per EquipmentType, defaulting any type with no saved row yet to
  // NOT_USED across every activity (never invents a row on a plain read —
  // only updateSuitabilityMatrix persists anything, so a warehouse created
  // before this feature existed reads cleanly with no backfill needed).
  async getSuitabilityMatrix(user: any, warehouseId: string) {
    if (!warehouseId) throw new BadRequestException('warehouseId is required.');
    const errors: string[] = [];
    await this.assertWarehouseAccess(warehouseId, user, errors);
    if (errors.length > 0) throw new ForbiddenException(errors.join(' '));

    const [types, rows] = await Promise.all([
      this.prisma.equipmentType.findMany({ orderBy: { name: 'asc' } }),
      this.prisma.warehouseEquipmentSuitability.findMany({ where: { warehouseId } }),
    ]);
    const byType = new Map(rows.map((r) => [r.equipmentTypeId, r]));
    return types.map((t) => {
      const row: any = byType.get(t.id);
      const result: any = { equipmentTypeId: t.id, equipmentTypeName: t.name };
      for (const f of SUITABILITY_FIELDS) result[f] = row?.[f] ?? 'NOT_USED';
      return result;
    });
  }

  // Bulk-saves the matrix for one warehouse — upserts one row per
  // EquipmentType named in `rows`, same "one save, several rows" shape as
  // WarehousesService's storage-type breakdown. Gated MASTER_DATA_WRITE_ROLES
  // at the controller (same tier as editing any other warehouse-level
  // physical/operational config).
  async updateSuitabilityMatrix(user: any, warehouseId: string, rows: any[]) {
    if (!warehouseId) throw new BadRequestException('warehouseId is required.');
    const errors: string[] = [];
    await this.assertWarehouseAccess(warehouseId, user, errors);
    if (errors.length > 0) throw new ForbiddenException(errors.join(' '));
    if (!Array.isArray(rows) || rows.length === 0) throw new BadRequestException('At least one matrix row is required.');

    for (const [i, row] of rows.entries()) {
      if (!row.equipmentTypeId) throw new BadRequestException(`Row ${i + 1}: equipmentTypeId is required.`);
      for (const f of SUITABILITY_FIELDS) {
        if (row[f] !== undefined && !SUITABILITY_VALUES.includes(row[f])) {
          throw new BadRequestException(`Row ${i + 1}: ${f} must be one of: ${SUITABILITY_VALUES.join(', ')}.`);
        }
      }
    }

    await this.prisma.$transaction(
      rows.map((row) => {
        const values: any = {};
        for (const f of SUITABILITY_FIELDS) values[f] = row[f] ?? 'NOT_USED';
        return this.prisma.warehouseEquipmentSuitability.upsert({
          where: { warehouseId_equipmentTypeId: { warehouseId, equipmentTypeId: row.equipmentTypeId } },
          update: values,
          create: { warehouseId, equipmentTypeId: row.equipmentTypeId, ...values },
        });
      }),
    );
    return this.getSuitabilityMatrix(user, warehouseId);
  }

  private async assertAccess(id: string, user: any) {
    const equipment = await this.prisma.equipment.findUnique({ where: { id }, include: { warehouse: true } });
    if (!equipment) throw new NotFoundException('Equipment not found.');
    if (user.role !== 'SUPER_ADMIN' && equipment.warehouse.companyId !== user.companyId) {
      throw new ForbiddenException('You do not have access to this equipment.');
    }
    if (EQUIPMENT_SCOPED_ROLES.includes(user.role)) {
      const ids = await ownWarehouseIds(this.prisma, user.userId);
      if (!ids.includes(equipment.warehouseId)) throw new ForbiddenException('You do not have access to this equipment.');
    }
    return equipment;
  }

  async update(id: string, data: any, user: any) {
    const existing = await this.assertAccess(id, user);
    const errors: string[] = [];
    const { code, name } = await this.validate(data, errors);
    if (errors.length > 0) throw new BadRequestException(errors);

    const duplicate = await this.prisma.equipment.findUnique({ where: { warehouseId_code: { warehouseId: existing.warehouseId, code } } });
    if (duplicate && duplicate.id !== id) throw new BadRequestException(`Equipment with code "${code}" already exists in this warehouse.`);

    return this.prisma.equipment.update({
      where: { id },
      data: {
        code,
        name: name ?? null,
        equipmentType: { connect: { id: data.equipmentTypeId } },
        palletsPerTrip: toNumberOrUndefined(data.palletsPerTrip) ?? null,
        avgTripMinutes: toNumberOrUndefined(data.avgTripMinutes) ?? null,
        loadedSpeedKmh: toNumberOrUndefined(data.loadedSpeedKmh) ?? null,
        unloadedSpeedKmh: toNumberOrUndefined(data.unloadedSpeedKmh) ?? null,
      },
      include: EQUIPMENT_INCLUDE,
    });
  }

  async deactivate(id: string, user: any) {
    await this.assertAccess(id, user);
    return this.prisma.equipment.update({ where: { id }, data: { isActive: false } });
  }

  async reactivate(id: string, user: any) {
    await this.assertAccess(id, user);
    return this.prisma.equipment.update({ where: { id }, data: { isActive: true } });
  }

  // No FK anywhere points at Equipment yet (Putaway task execution — the
  // thing that will eventually reference it — isn't built), so there's no
  // "blocked, has linked records" case to check yet, unlike Vehicle/
  // Warehouse's own removeAll. Revisit this the moment a real relation
  // exists, same lesson CLAUDE.md's "Every master-data entity gets a Delete
  // All" section documents about adding a new relation to an existing
  // blocking check by hand.
  async removeAll(user: any) {
    const equipment = await this.prisma.equipment.findMany({ where: { warehouse: { ...companyFilter(user) } }, select: { id: true, code: true } });
    if (equipment.length > 0) await this.prisma.equipment.deleteMany({ where: { id: { in: equipment.map((e) => e.id) } } });
    return { deletedCount: equipment.length, blockedCount: 0, blockedCodes: [] };
  }

  async remove(id: string, user: any) {
    const equipment = await this.assertAccess(id, user);
    await this.prisma.equipment.delete({ where: { id } });
    return { deleted: true, code: equipment.code };
  }
}
