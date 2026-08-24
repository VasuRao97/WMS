import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { normalizeCode } from '../common/normalize.util';
import { companyFilter, ownWarehouseIds, WAREHOUSE_SCOPED_ROLES } from '../common/tenant.util';

// Function tag (what a bin is FOR) — see schema.prisma's LocationZoneType enum
// and CLAUDE.md's Locations/Bins design-pass notes for the full reasoning.
const ZONE_TYPE_LABELS: Record<string, string> = {
  UNLOADING_STAGING: 'Unloading Staging',
  LOADING_STAGING: 'Loading Staging',
  ACTUAL_STORAGE: 'Actual Storage',
  FORWARD_PICK: 'Forward Pick Zone',
  PICK_FACE: 'Pick Face',
  PACKING_KITTING: 'Packing/Kitting',
  CROSS_DOCK: 'Cross-Dock',
  SLOB: 'SLOB',
  RETURNS: 'Returns',
  RE_PUTAWAY: 'Re-Putaway',
  QC_HOLD: 'QC Hold',
  TEMP_CONTROLLED_STORAGE: 'Temp-Controlled Storage',
  HAZMAT: 'Hazmat',
  DAMAGE_SCRAP: 'Damage & Scrap',
};
const ZONE_TYPE_VALUES = Object.keys(ZONE_TYPE_LABELS);

// How a bin is physically built. Free text (like WarehouseStorageType.storageType,
// not a Postgres enum) — deliberately excludes MIX, which only ever means
// "warehouse hasn't broken this down yet" at the capacity-planning level; a
// real physical bin is always concretely one of these five.
const STORAGE_TYPE_LABELS: Record<string, string> = {
  GROUND_FLOOR: 'Ground/Floor',
  SPR: 'SPR',
  DRIVE_IN: 'Drive-in',
  ASRS: 'ASRS',
  STILLAGE: 'Stillage',
};
const STORAGE_TYPE_VALUES = Object.keys(STORAGE_TYPE_LABELS);
const RACK_STORAGE_TYPES = ['SPR', 'DRIVE_IN', 'ASRS'];

@Injectable()
export class LocationsService {
  constructor(private prisma: PrismaService) {}

  // Validates zoneType/storageType/warehouse-independent fields and builds
  // the cleaned identifier/dimension fields for whichever storage-type group
  // applies (rack vs ground vs stillage) — same "validate + build" shape as
  // WarehousesService.validateWarehouseData/resolveStorageTypes.
  private buildLocationFields(data: any, errors: string[]): { zoneType: string; storageType: string; fields: Record<string, any> } {
    const zoneType = data.zoneType ? normalizeCode(data.zoneType) : '';
    if (!zoneType) errors.push('Zone Type is required.');
    else if (!ZONE_TYPE_VALUES.includes(zoneType)) {
      errors.push(`Zone Type must be one of: ${Object.values(ZONE_TYPE_LABELS).join(', ')}.`);
    }

    const storageType = data.storageType ? normalizeCode(data.storageType) : '';
    if (!storageType) errors.push('Storage Type is required.');
    else if (!STORAGE_TYPE_VALUES.includes(storageType)) {
      errors.push(`Storage Type must be one of: ${Object.values(STORAGE_TYPE_LABELS).join(', ')} (not Mix — that value is warehouse-level planning only, never a real bin).`);
    }

    const aisle = data.aisle ? String(data.aisle).trim() : '';
    if (!aisle) errors.push('Aisle is required.');
    const fields: Record<string, any> = { aisle: aisle || undefined };

    const numField = (key: string, label: string, required: boolean, fallback?: number) => {
      const v = data[key];
      if (v === undefined || v === null || v === '') {
        if (required) errors.push(`${label} is required for this Storage Type.`);
        else if (fallback !== undefined) fields[key] = fallback;
        return;
      }
      const n = Number(v);
      if (!Number.isInteger(n) || n <= 0) errors.push(`${label} must be a positive whole number.`);
      else fields[key] = n;
    };

    if (RACK_STORAGE_TYPES.includes(storageType)) {
      const rack = data.rack ? String(data.rack).trim() : '';
      const level = data.level ? String(data.level).trim() : '';
      if (!rack) errors.push('Rack is required for rack-based storage (SPR/Drive-in/ASRS).');
      if (!level) errors.push('Level is required for rack-based storage (SPR/Drive-in/ASRS).');
      fields.rack = rack || undefined;
      fields.level = level || undefined;
      fields.bin = data.bin ? String(data.bin).trim() : '1';
      numField('depth', 'Depth (position in a multi-deep lane)', false);
    } else if (storageType === 'GROUND_FLOOR') {
      const block = data.block ? String(data.block).trim() : '';
      if (!block) errors.push('Block is required for Ground/Floor storage.');
      fields.block = block || undefined;
      numField('depth', 'Depth (pallets deep)', true);
      numField('width', 'Width (stacks wide)', true);
      numField('height', 'Height (layers stacked)', false, 1);
    } else if (storageType === 'STILLAGE') {
      const stack = data.stack ? String(data.stack).trim() : '';
      if (!stack) errors.push('Stack is required for Stillage storage.');
      fields.stack = stack || undefined;
      numField('height', 'Height (stillages stacked)', true);
      numField('depth', 'Depth (stillage columns deep)', false, 1);
      numField('width', 'Width (stillage columns wide)', false, 1);
    }

    return { zoneType, storageType, fields };
  }

  private buildCode(storageType: string, f: Record<string, any>): string {
    if (RACK_STORAGE_TYPES.includes(storageType)) {
      return [f.aisle, f.rack ? `R${f.rack}` : null, f.level ? `L${f.level}` : null, f.bin ? `B${f.bin}` : null, f.depth ? `D${f.depth}` : null]
        .filter(Boolean)
        .join('-');
    }
    if (storageType === 'GROUND_FLOOR') {
      return ['GF', f.aisle, f.block ? `BLK${f.block}` : null].filter(Boolean).join('-');
    }
    if (storageType === 'STILLAGE') {
      return ['ST', f.aisle, f.stack].filter(Boolean).join('-');
    }
    return f.aisle || '';
  }

  // Same case-insensitive name resolution as WarehousesService.resolveStorageTypes
  // / CustomersService.resolveShipTos — Category stays optional here (unlike
  // Warehouse's storage-type breakdown, not every zone cares about a product
  // category, e.g. Staging/Cross-Dock), so a blank value just means "none",
  // no "Uncategorized" default forced on it.
  private async resolveCategory(categoryName: any, errors: string[]): Promise<string | undefined> {
    if (!categoryName || !String(categoryName).trim()) return undefined;
    const category = await this.prisma.productCategory.findFirst({
      where: { name: { equals: String(categoryName).trim(), mode: 'insensitive' } },
    });
    if (!category) {
      errors.push(`Category "${categoryName}" not found — check the Product Category master list.`);
      return undefined;
    }
    return category.id;
  }

  // Derived, not stored — "how many positions this bin holds" only means
  // something for ground/stillage storage (rack bins are individually
  // addressable, capacity is implicitly 1). Same "always derived, never
  // stored" philosophy as on-hand stock.
  private attachCapacity(loc: any) {
    const capacity = loc.storageType === 'GROUND_FLOOR' || loc.storageType === 'STILLAGE' ? (loc.depth || 1) * (loc.width || 1) * (loc.height || 1) : undefined;
    return { ...loc, capacity };
  }

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
    if (WAREHOUSE_SCOPED_ROLES.includes(user.role)) {
      const ids = await ownWarehouseIds(this.prisma, user.userId);
      if (!ids.includes(warehouseId)) errors.push('You can only manage locations in your own assigned warehouse(s).');
    }
  }

  async create(data: any, user: any) {
    if (!user.companyId) {
      throw new ForbiddenException('Super admin accounts cannot create locations directly — log in as a company admin instead.');
    }
    const errors: string[] = [];
    const { zoneType, storageType, fields } = this.buildLocationFields(data, errors);
    const categoryId = await this.resolveCategory(data.category, errors);
    if (!data.warehouseId) errors.push('Warehouse is required.');
    else await this.assertWarehouseAccess(data.warehouseId, user, errors);
    if (errors.length > 0) throw new BadRequestException(errors);

    const code = this.buildCode(storageType, fields);
    const existing = await this.prisma.location.findUnique({ where: { warehouseId_code: { warehouseId: data.warehouseId, code } } });
    if (existing) {
      throw new BadRequestException(`A location with code "${code}" already exists in this warehouse — check for a duplicate aisle/rack/level/bin (or block/stack).`);
    }

    const created = await this.prisma.location.create({
      data: {
        warehouse: { connect: { id: data.warehouseId } },
        code,
        zone: data.zone ? String(data.zone).trim() : undefined,
        zoneType: zoneType as any,
        storageType,
        category: categoryId ? { connect: { id: categoryId } } : undefined,
        ...fields,
      },
      include: { warehouse: { select: { id: true, code: true, name: true } }, category: { select: { id: true, name: true } } },
    });
    return this.attachCapacity(created);
  }

  async findAll(user: any) {
    const where: any = { warehouse: { ...companyFilter(user) } };
    if (WAREHOUSE_SCOPED_ROLES.includes(user.role)) {
      where.warehouseId = { in: await ownWarehouseIds(this.prisma, user.userId) };
    }
    const locations = await this.prisma.location.findMany({
      where,
      include: { warehouse: { select: { id: true, code: true, name: true } }, category: { select: { id: true, name: true } } },
      orderBy: { code: 'asc' },
    });
    return locations.map((l) => this.attachCapacity(l));
  }

  private async assertAccess(id: string, user: any) {
    const location = await this.prisma.location.findUnique({
      where: { id },
      include: { warehouse: true },
    });
    if (!location) throw new NotFoundException('Location not found.');
    if (user.role !== 'SUPER_ADMIN' && location.warehouse.companyId !== user.companyId) {
      throw new ForbiddenException('You do not have access to this location.');
    }
    if (WAREHOUSE_SCOPED_ROLES.includes(user.role)) {
      const ids = await ownWarehouseIds(this.prisma, user.userId);
      if (!ids.includes(location.warehouseId)) throw new ForbiddenException('You do not have access to this location.');
    }
    return location;
  }

  async update(id: string, data: any, user: any) {
    const existingLocation = await this.assertAccess(id, user);

    const errors: string[] = [];
    const { zoneType, storageType, fields } = this.buildLocationFields(data, errors);
    const categoryId = await this.resolveCategory(data.category, errors);
    const warehouseId = data.warehouseId || existingLocation.warehouseId;
    if (data.warehouseId && data.warehouseId !== existingLocation.warehouseId) {
      await this.assertWarehouseAccess(data.warehouseId, user, errors);
    }
    if (errors.length > 0) throw new BadRequestException(errors);

    const code = this.buildCode(storageType, fields);
    const duplicate = await this.prisma.location.findUnique({ where: { warehouseId_code: { warehouseId, code } } });
    if (duplicate && duplicate.id !== id) {
      throw new BadRequestException(`A location with code "${code}" already exists in this warehouse — check for a duplicate aisle/rack/level/bin (or block/stack).`);
    }

    const updated = await this.prisma.location.update({
      where: { id },
      data: {
        warehouse: { connect: { id: warehouseId } },
        code,
        zone: data.zone ? String(data.zone).trim() : null,
        zoneType: zoneType as any,
        storageType,
        category: categoryId ? { connect: { id: categoryId } } : { disconnect: true },
        // Clear every identifier/dimension field first so switching Storage
        // Type on an existing row doesn't leave stale fields from the old
        // group behind (e.g. a "block" value surviving a switch to rack).
        aisle: null,
        rack: null,
        level: null,
        bin: null,
        block: null,
        stack: null,
        depth: null,
        width: null,
        height: null,
        ...fields,
      },
      include: { warehouse: { select: { id: true, code: true, name: true } }, category: { select: { id: true, name: true } } },
    });
    return this.attachCapacity(updated);
  }

  async deactivate(id: string, user: any) {
    await this.assertAccess(id, user);
    return this.prisma.location.update({ where: { id }, data: { isActive: false } });
  }

  async reactivate(id: string, user: any) {
    await this.assertAccess(id, user);
    return this.prisma.location.update({ where: { id }, data: { isActive: true } });
  }

  async removeAll(user: any) {
    const locations = await this.prisma.location.findMany({
      where: { warehouse: { ...companyFilter(user) } },
      select: {
        id: true,
        code: true,
        _count: {
          select: {
            stockMovements: true,
            putawayFrom: true,
            putawayTo: true,
            receiptLinesStaged: true,
            allocations: true,
            returns: true,
          },
        },
      },
    });
    const deletable: string[] = [];
    const blocked: string[] = [];
    for (const loc of locations) {
      const c = loc._count;
      const totalLinked = c.stockMovements + c.putawayFrom + c.putawayTo + c.receiptLinesStaged + c.allocations + c.returns;
      if (totalLinked > 0) blocked.push(loc.code);
      else deletable.push(loc.id);
    }
    if (deletable.length > 0) {
      await this.prisma.location.deleteMany({ where: { id: { in: deletable } } });
    }
    return { deletedCount: deletable.length, blockedCount: blocked.length, blockedCodes: blocked };
  }
}
