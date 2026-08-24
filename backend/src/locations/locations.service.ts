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

// Generation batches are capped so a mistyped range (e.g. "1-99999") fails
// fast with a clear message instead of hanging the request or the DB.
const MAX_GENERATE_BATCH = 2000;

// Expands one range-generator input into the list of values a field should
// take across the batch — "1-20" (or "01-20", padding preserved from
// whichever side has more digits) -> ['01', '02', ..., '20']; a bare value
// with no dash ("07") -> ['07'], a single fixed value repeated for every
// generated row; blank/undefined -> [undefined], meaning "don't set this
// field, let buildLocationFields's own default/optional handling apply."
function expandRange(input: any): (string | undefined)[] {
  if (input === undefined || input === null || String(input).trim() === '') return [undefined];
  const str = String(input).trim();
  const m = str.match(/^(\d+)\s*-\s*(\d+)$/);
  if (!m) return [str];
  const [, startStr, endStr] = m;
  const start = parseInt(startStr, 10);
  const end = parseInt(endStr, 10);
  const width = Math.max(startStr.length, endStr.length);
  const step = start <= end ? 1 : -1;
  const result: string[] = [];
  for (let i = start; step > 0 ? i <= end : i >= end; i += step) {
    result.push(String(i).padStart(width, '0'));
  }
  return result;
}

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

  // Shared by create()/generate()/bulkImport() — validates one row's data and
  // returns everything needed to insert it (or the errors blocking it). Never
  // throws; callers decide single-record (throw) vs batch (collect) handling.
  // Same "one function, many callers" shape as SkusService.validateSkuData.
  private async prepareRow(data: any, user: any): Promise<{ errors: string[]; warehouseId?: string; zoneType?: string; storageType?: string; categoryId?: string; fields?: Record<string, any>; code?: string }> {
    const errors: string[] = [];
    const { zoneType, storageType, fields } = this.buildLocationFields(data, errors);
    const categoryId = await this.resolveCategory(data.category, errors);
    const warehouseId = data.warehouseId;
    if (!warehouseId) errors.push('Warehouse is required.');
    else await this.assertWarehouseAccess(warehouseId, user, errors);
    if (errors.length > 0) return { errors };
    return { errors, warehouseId, zoneType, storageType, categoryId, fields, code: this.buildCode(storageType, fields) };
  }

  async create(data: any, user: any) {
    if (!user.companyId) {
      throw new ForbiddenException('Super admin accounts cannot create locations directly — log in as a company admin instead.');
    }
    const prepared = await this.prepareRow(data, user);
    if (prepared.errors.length > 0) throw new BadRequestException(prepared.errors);

    const existing = await this.prisma.location.findUnique({ where: { warehouseId_code: { warehouseId: prepared.warehouseId!, code: prepared.code! } } });
    if (existing) {
      throw new BadRequestException(`A location with code "${prepared.code}" already exists in this warehouse — check for a duplicate aisle/rack/level/bin (or block/stack).`);
    }

    const created = await this.prisma.location.create({
      data: {
        warehouse: { connect: { id: prepared.warehouseId } },
        code: prepared.code!,
        zone: data.zone ? String(data.zone).trim() : undefined,
        zoneType: prepared.zoneType as any,
        storageType: prepared.storageType!,
        category: prepared.categoryId ? { connect: { id: prepared.categoryId } } : undefined,
        ...prepared.fields,
      },
      include: { warehouse: { select: { id: true, code: true, name: true } }, category: { select: { id: true, name: true } } },
    });
    return this.attachCapacity(created);
  }

  // Range generator — expands a Rack range (rack x level x bin x depth), a
  // Ground Block range, or a Stillage Stack range into many individual
  // Location rows in one call, reusing prepareRow's per-row validation and
  // the same duplicate-detection create() uses. See CLAUDE.md's Locations/
  // Bins notes for the design (why depth/width/height stay FIXED per batch —
  // one footprint applies to every generated Ground/Stillage row — while
  // only the identifier field(s) vary across the range).
  async generate(data: any, user: any) {
    if (!user.companyId) {
      throw new ForbiddenException('Super admin accounts cannot create locations directly — log in as a company admin instead.');
    }
    const storageType = data.storageType ? normalizeCode(data.storageType) : '';
    if (!STORAGE_TYPE_VALUES.includes(storageType)) {
      throw new BadRequestException([`Storage Type must be one of: ${Object.values(STORAGE_TYPE_LABELS).join(', ')}.`]);
    }

    // A bare number in Depth (e.g. "5", no dash) means "this lane is 5 pallets
    // deep" — expand to every position 1..5, not just a single fixed depth=5
    // row. Real gap caught 2026-08-24: entering "2" for a 2-deep drive-in lane
    // silently created only the back slot, never the front one. An explicit
    // range ("3-5") still means exactly those positions (e.g. retrofitting
    // one missing position into an already-partly-built lane).
    const depthRangeInput = /^\d+$/.test(String(data.depthRange || '').trim()) ? `1-${String(data.depthRange).trim()}` : data.depthRange;

    // "Second range" fields let one generate() call build both flanks of a
    // single aisle in one go — e.g. Rack Range 01-10 (one side) + Second Rack
    // Range 11-20 (the other side), same Aisle, same Depth for both, since a
    // rack/block number already disambiguates the two sides (real warehouses
    // number both flanks of an aisle continuously, never reusing a number) —
    // no "side" field needed on Location itself. Omit the second range and
    // behavior is identical to a single-sided generation (unchanged).
    let rows: Record<string, any>[];
    if (RACK_STORAGE_TYPES.includes(storageType)) {
      const rackRanges = [data.rackRange, data.rackRange2].filter((r) => r !== undefined && r !== null && String(r).trim() !== '');
      const levels = expandRange(data.levelRange);
      const bins = expandRange(data.binRange);
      const depths = expandRange(depthRangeInput);
      rows = [];
      for (const rackRangeStr of rackRanges.length ? rackRanges : [undefined]) {
        for (const rack of expandRange(rackRangeStr)) for (const level of levels) for (const bin of bins) for (const depth of depths) rows.push({ rack, level, bin, depth });
      }
    } else if (storageType === 'GROUND_FLOOR') {
      const blockRanges = [data.blockRange, data.blockRange2].filter((r) => r !== undefined && r !== null && String(r).trim() !== '');
      rows = [];
      for (const blockRangeStr of blockRanges.length ? blockRanges : [undefined]) {
        for (const block of expandRange(blockRangeStr)) rows.push({ block, depth: data.depth, width: data.width, height: data.height });
      }
    } else {
      // STILLAGE — no "second side" concept; a stillage stack isn't a
      // two-flank structure the way an aisle's rack rows or floor blocks are.
      rows = expandRange(data.stackRange).map((stack) => ({ stack, height: data.height, depth: data.depth, width: data.width }));
    }

    if (rows.length === 0) throw new BadRequestException(['The given range(s) produced no rows to generate.']);
    if (rows.length > MAX_GENERATE_BATCH) {
      throw new BadRequestException([`This range would generate ${rows.length} locations in one batch — narrow it down (max ${MAX_GENERATE_BATCH} per generation).`]);
    }

    const results: { code?: string; status: 'success' | 'error'; errors?: string[] }[] = [];
    const codesSeenInBatch = new Set<string>();
    for (const row of rows) {
      const rowData = { ...data, ...row };
      const prepared = await this.prepareRow(rowData, user);
      if (prepared.errors.length > 0) {
        results.push({ status: 'error', errors: prepared.errors });
        continue;
      }
      if (codesSeenInBatch.has(prepared.code!)) {
        results.push({ code: prepared.code, status: 'error', errors: ['Duplicate within this generation batch.'] });
        continue;
      }
      const existing = await this.prisma.location.findUnique({ where: { warehouseId_code: { warehouseId: prepared.warehouseId!, code: prepared.code! } } });
      if (existing) {
        results.push({ code: prepared.code, status: 'error', errors: ['A location with this code already exists.'] });
        continue;
      }
      try {
        await this.prisma.location.create({
          data: {
            warehouse: { connect: { id: prepared.warehouseId } },
            code: prepared.code!,
            zone: data.zone ? String(data.zone).trim() : undefined,
            zoneType: prepared.zoneType as any,
            storageType: prepared.storageType!,
            category: prepared.categoryId ? { connect: { id: prepared.categoryId } } : undefined,
            ...prepared.fields,
          },
        });
        results.push({ code: prepared.code, status: 'success' });
        codesSeenInBatch.add(prepared.code!);
      } catch (err: any) {
        results.push({ code: prepared.code, status: 'error', errors: [err.message || 'Unknown error'] });
      }
    }

    return {
      totalRequested: rows.length,
      successCount: results.filter((r) => r.status === 'success').length,
      failCount: results.filter((r) => r.status === 'error').length,
      results,
    };
  }

  private async resolveWarehouseCodeToId(code: any, user: any, errors: string[]): Promise<string | undefined> {
    const codeStr = code ? String(code).trim().toUpperCase() : '';
    if (!codeStr) {
      errors.push('Warehouse Code is required.');
      return undefined;
    }
    const warehouse = await this.prisma.warehouse.findUnique({ where: { companyId_code: { companyId: user.companyId, code: codeStr } } });
    if (!warehouse) {
      errors.push(`Warehouse Code "${codeStr}" not found.`);
      return undefined;
    }
    if (WAREHOUSE_SCOPED_ROLES.includes(user.role)) {
      const ids = await ownWarehouseIds(this.prisma, user.userId);
      if (!ids.includes(warehouse.id)) {
        errors.push(`You do not have access to Warehouse "${codeStr}".`);
        return undefined;
      }
    }
    return warehouse.id;
  }

  // Excel bulk import — one row per Location, same xlsx -> per-row validation
  // -> success/error results shape as Warehouse/SKU/Customer/User. Unlike
  // those, this template's rows aren't grouped by a repeated key — each row
  // is already exactly one Location, so no grouping pass is needed first.
  async bulkImport(rows: any[], user: any) {
    if (!user.companyId) {
      throw new ForbiddenException('Super admin accounts cannot import locations directly — log in as a company admin instead.');
    }
    const results: { code?: string; status: 'success' | 'error'; errors?: string[] }[] = [];
    const codesSeenInFile = new Map<string, string>(); // warehouseId::code -> row label, for within-file dupes

    for (const row of rows) {
      const errors: string[] = [];
      const warehouseId = await this.resolveWarehouseCodeToId(row.warehouseCode, user, errors);
      const prepared = warehouseId ? await this.prepareRow({ ...row, warehouseId }, user) : { errors };
      if (warehouseId) prepared.errors = [...errors, ...prepared.errors];

      if (prepared.errors.length > 0 || !prepared.code) {
        results.push({ status: 'error', errors: prepared.errors.length ? prepared.errors : ['Could not process this row.'] });
        continue;
      }

      const batchKey = `${prepared.warehouseId}::${prepared.code}`;
      if (codesSeenInFile.has(batchKey)) {
        results.push({ code: prepared.code, status: 'error', errors: ['Duplicate within this file (same Warehouse + resulting code).'] });
        continue;
      }
      const existing = await this.prisma.location.findUnique({ where: { warehouseId_code: { warehouseId: prepared.warehouseId!, code: prepared.code } } });
      if (existing) {
        results.push({ code: prepared.code, status: 'error', errors: ['A location with this code already exists in this warehouse.'] });
        continue;
      }

      try {
        await this.prisma.location.create({
          data: {
            warehouse: { connect: { id: prepared.warehouseId } },
            code: prepared.code!,
            zone: row.zone ? String(row.zone).trim() : undefined,
            zoneType: prepared.zoneType as any,
            storageType: prepared.storageType!,
            category: prepared.categoryId ? { connect: { id: prepared.categoryId } } : undefined,
            ...prepared.fields,
          },
        });
        results.push({ code: prepared.code, status: 'success' });
        codesSeenInFile.set(batchKey, prepared.code);
      } catch (err: any) {
        results.push({ code: prepared.code, status: 'error', errors: [err.message || 'Unknown error'] });
      }
    }

    return {
      totalRows: rows.length,
      successCount: results.filter((r) => r.status === 'success').length,
      failCount: results.filter((r) => r.status === 'error').length,
      results,
    };
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

    const prepared = await this.prepareRow({ ...data, warehouseId: data.warehouseId || existingLocation.warehouseId }, user);
    if (prepared.errors.length > 0) throw new BadRequestException(prepared.errors);

    const duplicate = await this.prisma.location.findUnique({ where: { warehouseId_code: { warehouseId: prepared.warehouseId!, code: prepared.code! } } });
    if (duplicate && duplicate.id !== id) {
      throw new BadRequestException(`A location with code "${prepared.code}" already exists in this warehouse — check for a duplicate aisle/rack/level/bin (or block/stack).`);
    }

    const updated = await this.prisma.location.update({
      where: { id },
      data: {
        warehouse: { connect: { id: prepared.warehouseId } },
        code: prepared.code!,
        zone: data.zone ? String(data.zone).trim() : null,
        zoneType: prepared.zoneType as any,
        storageType: prepared.storageType!,
        category: prepared.categoryId ? { connect: { id: prepared.categoryId } } : { disconnect: true },
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
        ...prepared.fields,
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
