import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { normalizeCode } from '../common/normalize.util';
import { companyFilter, ownWarehouseIds, WAREHOUSE_SCOPED_ROLES } from '../common/tenant.util';
import { CODE_REGEX, PINCODE_REGEX } from '../common/validation.util';
import { toNumberOrUndefined } from '../common/xlsx-parse.util';
import { DEFAULT_EQUIPMENT_SUITABILITY, NOT_USED_ROW } from '../common/equipment-suitability-defaults';

const NODE_TYPE_VALUES = ['FACTORY', 'DISTRIBUTOR', 'REGIONAL_DC', 'NATIONAL_DC', 'CNF', 'CROSS_DOCK'];
const STORAGE_TYPE_VALUES = ['GROUND_FLOOR', 'SPR', 'DRIVE_IN', 'MIX', 'ASRS'];
const DISPATCH_FLOW_VALUES = ['FULL_PALLET', 'CASE_PICK', 'BROKEN_CASE'];
// Which Location.storageType values are individually-addressable rack bins
// (1 pallet position each) vs. footprint-based (Ground/Stillage, derived
// depth×width×height capacity) — used only by getMappingSummary() below.
// Duplicated from LocationsService's own RACK_STORAGE_TYPES rather than
// shared via common/ — matches this file's existing STORAGE_TYPE_VALUES,
// which already keeps its own independent copy rather than importing one.
const RACK_STORAGE_TYPES = ['SPR', 'DRIVE_IN', 'ASRS'];

const NODE_TYPE_LABELS: Record<string, string> = {
  FACTORY: 'Factory',
  DISTRIBUTOR: 'Distributor',
  REGIONAL_DC: 'Regional DC',
  NATIONAL_DC: 'National DC',
  CNF: 'CNF',
  CROSS_DOCK: 'Cross-dock',
};

@Injectable()
export class WarehousesService {
  constructor(private prisma: PrismaService) {}

  private validateWarehouseData(data: any): string[] {
    const errors: string[] = [];
    if (!data.code || !CODE_REGEX.test(data.code)) {
      errors.push('Location Code is required: alphanumeric/hyphens only, max 30 characters.');
    }
    const nodeType = data.nodeType ? normalizeCode(data.nodeType) : '';
    if (!nodeType) {
      errors.push('Type of Node is required.');
    } else if (!NODE_TYPE_VALUES.includes(nodeType)) {
      errors.push(`Type of Node must be one of: ${Object.values(NODE_TYPE_LABELS).join(', ')}`);
    }
    if (!data.city) errors.push('City Name is required.');
    if (!data.address) errors.push('Address is required.');
    if (!data.pincode || !PINCODE_REGEX.test(String(data.pincode))) errors.push('Pincode is required: 6 digits.');
    // Required as of 2026-08-28 (Putaway kickoff conversation) — the client's
    // own call ("keep the dock entry field as mandatory, so this logic never
    // fails"), since this is the sole input driving
    // generateDockDoorsAndStaging() below. Shared by both create() and
    // bulkImport() (same "one function, two callers" convention as
    // everywhere else), so an Excel import row without it is rejected the
    // same way a manual create is.
    if (data.noOfDocks === undefined || data.noOfDocks === null || data.noOfDocks === '') {
      errors.push('No of Docks is required.');
    } else if (!Number.isInteger(Number(data.noOfDocks)) || Number(data.noOfDocks) < 1) {
      errors.push('No of Docks must be a whole number, 1 or more.');
    }
    if (data.areaSqFt !== undefined && data.areaSqFt !== null && data.areaSqFt !== '' && Number(data.areaSqFt) <= 0) {
      errors.push('Area sq ft must be a positive number.');
    }
    if (data.yardCapacity !== undefined && data.yardCapacity !== null && data.yardCapacity !== '') {
      const n = Number(data.yardCapacity);
      if (!Number.isInteger(n) || n < 0) errors.push('Parking Slots must be a whole number, 0 or more.');
    }
    if (data.latitude !== undefined && data.latitude !== null && data.latitude !== '' && isNaN(Number(data.latitude))) {
      errors.push('Latitude must be a number.');
    }
    if (data.longitude !== undefined && data.longitude !== null && data.longitude !== '' && isNaN(Number(data.longitude))) {
      errors.push('Longitude must be a number.');
    }

    const storageTypes = data.storageTypes || [];
    let hasMix = false;
    let hasSpecific = false;
    for (const s of storageTypes) {
      const type = normalizeCode(s.storageType);
      if (!STORAGE_TYPE_VALUES.includes(type)) {
        errors.push(`Storage Type must be one of: Ground/Floor, SPR, Drive-in, Mix, ASRS (got "${s.storageType}").`);
      }
      if (!s.palletPositions || Number(s.palletPositions) <= 0) {
        errors.push('Pallet Positions must be a positive number when Storage Type is given.');
      }
      for (const [field, label] of [
        ['lengthM', 'Dim L'],
        ['widthM', 'Dim W'],
        ['heightM', 'Dim H'],
      ] as const) {
        const v = s[field];
        if (v !== undefined && v !== null && v !== '' && Number(v) <= 0) {
          errors.push(`${label} (m) must be a positive number when given.`);
        }
      }
      if (type === 'MIX') hasMix = true;
      else hasSpecific = true;
    }
    if (hasMix && hasSpecific) {
      errors.push('A warehouse cannot combine "Mix" with specific Storage Type entries — pick one approach.');
    }

    const dispatchFlows = data.dispatchFlows || [];
    for (const f of dispatchFlows) {
      const type = normalizeCode(f.flowType);
      if (!DISPATCH_FLOW_VALUES.includes(type)) {
        errors.push(`Dispatch Flow must be one of: Full Pallet, Case Pick, Broken Case (got "${f.flowType}").`);
      }
    }
    return errors;
  }

  // Resolves each storage-type row's Category (a plain name, like Storage
  // Type's own human label — "Uncategorized" if left blank) against the
  // ProductCategory reference list, the same shape as CustomersService's
  // resolveShipTos resolving a Ship-to's warehouseCode. Also catches a
  // duplicate (storageType, category) pair within one submission before the
  // DB's unique constraint would — same category across two different
  // storage types is fine and produces two separate rows.
  private async resolveStorageTypes(storageTypes: any[], errors: string[]) {
    const resolved: any[] = [];
    const seenKeys = new Set<string>();
    for (const s of storageTypes || []) {
      const categoryName = s.category ? String(s.category).trim() : 'Uncategorized';
      const category = await this.prisma.productCategory.findFirst({
        where: { name: { equals: categoryName, mode: 'insensitive' } },
      });
      if (!category) {
        errors.push(`Category "${categoryName}" not found — check the Product Category master list.`);
        continue;
      }
      const type = normalizeCode(s.storageType);
      const key = `${type}::${category.id}`;
      if (seenKeys.has(key)) {
        errors.push(`Duplicate Storage Type + Category combination: ${s.storageType} / ${categoryName}.`);
        continue;
      }
      seenKeys.add(key);
      resolved.push({
        storageType: type,
        categoryId: category.id,
        palletPositions: s.palletPositions,
        lengthM: toNumberOrUndefined(s.lengthM),
        widthM: toNumberOrUndefined(s.widthM),
        heightM: toNumberOrUndefined(s.heightM),
      });
    }
    return resolved;
  }

  private buildCreateData(data: any, companyId: string, name: string, resolvedStorageTypes: any[]) {
    const nodeType = normalizeCode(data.nodeType);
    const dispatchFlowTypes = new Set<string>((data.dispatchFlows || []).map((f: any) => normalizeCode(f.flowType)));

    return {
      code: data.code.toUpperCase(),
      name,
      address: data.address,
      city: data.city,
      pincode: String(data.pincode),
      nodeType,
      latitude: toNumberOrUndefined(data.latitude),
      longitude: toNumberOrUndefined(data.longitude),
      threePlName: data.threePlName || undefined,
      noOfDocks: toNumberOrUndefined(data.noOfDocks),
      areaSqFt: toNumberOrUndefined(data.areaSqFt),
      yardCapacity: toNumberOrUndefined(data.yardCapacity),
      gstin: data.gstin || undefined,
      workingDays: data.workingDays || undefined,
      workingHours: data.workingHours || undefined,
      contactName: data.contactName || undefined,
      contactPhone: data.contactPhone || undefined,
      company: { connect: { id: companyId } },
      storageTypes: resolvedStorageTypes.length ? { create: resolvedStorageTypes } : undefined,
      dispatchFlows: dispatchFlowTypes.size ? { create: [...dispatchFlowTypes].map((flowType) => ({ flowType })) } : undefined,
    };
  }

  // Generates YardSlot rows Y1..YN for a freshly-created warehouse, per its
  // yardCapacity — real, individually-addressable rows per the 2026-08-25
  // Yard Management design conversation (see schema.prisma's comment on
  // YardSlot). Only settable at creation for now — there's no Warehouse
  // Edit yet, so a capacity change/increase isn't handled here.
  private async generateYardSlots(warehouseId: string, capacity: number | undefined) {
    if (!capacity || capacity <= 0) return;
    await this.prisma.yardSlot.createMany({
      data: Array.from({ length: capacity }, (_, i) => ({ warehouseId, code: `Y${i + 1}` })),
    });
  }

  // Highest existing dock NUMBER for this warehouse, parsed from DockDoor.code
  // — not a row count, since a code isn't guaranteed contiguous (a
  // manually-deleted dock, or a pre-2026-08-28 non-numeric manual code,
  // shouldn't cause a number to be reused/collide). 0 if none exist yet.
  private async highestDockNumber(warehouseId: string): Promise<number> {
    const doors = await this.prisma.dockDoor.findMany({ where: { warehouseId }, select: { code: true } });
    const nums = doors.map((d) => parseInt(d.code, 10)).filter((n) => Number.isInteger(n));
    return nums.length ? Math.max(...nums) : 0;
  }

  // Auto-generates a DockDoor plus its own Inbound/Outbound staging Location
  // pair for every dock number up to noOfDocks — the client's own explicit
  // call, 2026-08-28 (Putaway kickoff conversation): "i want you to
  // automatically make 1 location for inbound and 1 location for outbound
  // for every dock yourself... i dont want the client doing this activity at
  // all." Naming is deliberately simple, per the client's own spec:
  // DockDoor.code stays a bare number ("1", "2"...) so it keeps matching
  // whatever a Security Supervisor free-types into
  // VehicleGateEntry.assignedDockNumber; the paired Locations are
  // "Dock{N}-SA-IB" / "Dock{N}-SA-OB" (zoneType UNLOADING_STAGING /
  // LOADING_STAGING, storageType GROUND_FLOOR — the client's own choice).
  // `aisle` is deliberately left unset on these — LocationsPlanView.tsx
  // filters out any Location with no aisle, so these auto-generated staging
  // bins don't corrupt the structural floor-plan visualizer (which has no
  // concept of a dock apron to render).
  //
  // Append-only: only NEW dock numbers beyond whatever already exists get
  // created (see highestDockNumber above) — safe to call again later (e.g.
  // once Warehouse Edit exists and noOfDocks increases) without touching or
  // duplicating existing docks. Manual edit/delete of an auto-created
  // DockDoor or Location stays available through their own pages — this
  // only ever adds, never overwrites (the client's own explicit ask).
  //
  // Known minor side effect, not fixed: these Locations carry no Category,
  // so they fall into the "Uncategorized" bucket in
  // WarehousesService.getMappingSummary()'s Storage Type Mapping table —
  // a warehouse with a planned GROUND_FLOOR/Uncategorized row will show 2
  // extra "mapped" positions per dock. Cosmetic only (that table is a QA
  // aid, nothing enforces off it), not worth a special-case exclusion for
  // now.
  private async generateDockDoorsAndStaging(warehouseId: string, noOfDocks: number | undefined) {
    if (!noOfDocks || noOfDocks <= 0) return;
    const start = (await this.highestDockNumber(warehouseId)) + 1;
    for (let n = start; n <= noOfDocks; n++) {
      const [inboundLoc, outboundLoc] = await Promise.all([
        this.prisma.location.create({
          data: { warehouse: { connect: { id: warehouseId } }, code: `Dock${n}-SA-IB`, zoneType: 'UNLOADING_STAGING', storageType: 'GROUND_FLOOR', depth: 1, width: 1, height: 1 },
        }),
        this.prisma.location.create({
          data: { warehouse: { connect: { id: warehouseId } }, code: `Dock${n}-SA-OB`, zoneType: 'LOADING_STAGING', storageType: 'GROUND_FLOOR', depth: 1, width: 1, height: 1 },
        }),
      ]);
      await this.prisma.dockDoor.create({
        data: {
          warehouse: { connect: { id: warehouseId } },
          code: String(n),
          name: `Dock ${n}`,
          defaultStagingLocation: { connect: { id: inboundLoc.id } },
          outboundStagingLocation: { connect: { id: outboundLoc.id } },
        },
      });
    }
  }

  // Auto-creates one WarehouseEquipmentSuitability row per EquipmentType for
  // a brand-new warehouse (2026-08-28, same auto-generation convention as
  // generateDockDoorsAndStaging/generateYardSlots above) — seeded from
  // DEFAULT_EQUIPMENT_SUITABILITY so the matrix starts as a reasonable,
  // fully-editable default rather than everything blank (NOT_USED). Always
  // runs (unlike the two methods above, which are conditional on a numeric
  // field) — every warehouse gets a matrix, there's no "opt out" input for
  // this one. See WarehouseEquipmentSuitability's schema.prisma comment for
  // the full "where is the matrix for input??" correction story.
  private async generateEquipmentSuitability(warehouseId: string) {
    const types = await this.prisma.equipmentType.findMany();
    if (types.length === 0) return;
    await this.prisma.warehouseEquipmentSuitability.createMany({
      data: types.map((t) => ({ warehouseId, equipmentTypeId: t.id, ...(DEFAULT_EQUIPMENT_SUITABILITY[t.name] ?? NOT_USED_ROW) })),
    });
  }

  async create(data: any, user: any) {
    if (!user.companyId) {
      throw new ForbiddenException('Super admin accounts cannot create warehouses directly — log in as a company admin instead.');
    }
    const errors = this.validateWarehouseData(data);
    if (!data.name || !String(data.name).trim()) errors.push('Name is required.');
    const resolvedStorageTypes = await this.resolveStorageTypes(data.storageTypes, errors);
    if (errors.length > 0) throw new BadRequestException(errors);

    const existing = await this.prisma.warehouse.findUnique({
      where: { companyId_code: { companyId: user.companyId, code: data.code.toUpperCase() } },
    });
    if (existing) throw new BadRequestException(`Location Code "${data.code}" already exists.`);

    const created = await this.prisma.warehouse.create({
      data: this.buildCreateData(data, user.companyId, data.name, resolvedStorageTypes),
      include: { storageTypes: { include: { category: true } }, dispatchFlows: true },
    });
    await this.generateYardSlots(created.id, toNumberOrUndefined(data.yardCapacity));
    await this.generateDockDoorsAndStaging(created.id, toNumberOrUndefined(data.noOfDocks));
    await this.generateEquipmentSuitability(created.id);
    return created;
  }

  async findAll(user: any) {
    const where: any = { ...companyFilter(user) };
    if (WAREHOUSE_SCOPED_ROLES.includes(user.role)) {
      where.id = { in: await ownWarehouseIds(this.prisma, user.userId) };
    }
    return this.prisma.warehouse.findMany({
      where,
      include: { storageTypes: { include: { category: true } }, dispatchFlows: true },
      orderBy: { code: 'asc' },
    });
  }

  // Groups repeated-Location-Code rows the same way CustomersService.bulkImport
  // groups repeated-Bill-To-ID rows: warehouse-level fields are read from the
  // first row seen for a code (later repeats/blanks on those columns are
  // ignored either way); Storage Type / Dispatch Flow rows accumulate from
  // every row that carries them, independently of each other.
  async bulkImport(groupedRows: any[], user: any) {
    if (!user.companyId) {
      throw new ForbiddenException('Super admin accounts cannot import warehouses directly — log in as a company admin instead.');
    }
    const results: any[] = [];
    const codesSeenInFile = new Set<string>();

    for (const group of groupedRows) {
      const upperCode = group.code ? String(group.code).toUpperCase() : '';
      const errors = this.validateWarehouseData(group);
      const resolvedStorageTypes = await this.resolveStorageTypes(group.storageTypes, errors);

      if (upperCode && codesSeenInFile.has(upperCode)) {
        errors.push(`Duplicate Location Code within this file: ${upperCode}`);
      }
      if (errors.length === 0 && upperCode) {
        const existing = await this.prisma.warehouse.findUnique({
          where: { companyId_code: { companyId: user.companyId, code: upperCode } },
        });
        if (existing) errors.push(`Location Code already exists in the database: ${upperCode}`);
      }
      if (errors.length > 0) {
        results.push({ code: group.code || '(blank)', status: 'error', errors });
        continue;
      }

      const nodeType = normalizeCode(group.nodeType);
      const name = group.city ? `${group.city} ${NODE_TYPE_LABELS[nodeType]}` : upperCode;

      try {
        const created = await this.prisma.warehouse.create({ data: this.buildCreateData(group, user.companyId, name, resolvedStorageTypes) });
        await this.generateYardSlots(created.id, toNumberOrUndefined(group.yardCapacity));
        await this.generateDockDoorsAndStaging(created.id, toNumberOrUndefined(group.noOfDocks));
        await this.generateEquipmentSuitability(created.id);
        const dispatchFlowCount = new Set((group.dispatchFlows || []).map((f: any) => normalizeCode(f.flowType))).size;
        results.push({
          code: upperCode,
          status: 'success',
          storageTypeCount: resolvedStorageTypes.length,
          dispatchFlowCount,
        });
        codesSeenInFile.add(upperCode);
      } catch (err: any) {
        results.push({ code: group.code || '(blank)', status: 'error', errors: [err.message || 'Unknown error'] });
      }
    }

    return {
      totalWarehouses: groupedRows.length,
      successCount: results.filter((r) => r.status === 'success').length,
      failCount: results.filter((r) => r.status === 'error').length,
      results,
    };
  }

  private async assertAccess(id: string, user: any) {
    const warehouse = await this.prisma.warehouse.findUnique({ where: { id } });
    if (!warehouse) throw new NotFoundException('Warehouse not found.');
    if (user.role !== 'SUPER_ADMIN' && warehouse.companyId !== user.companyId) {
      throw new ForbiddenException('You do not have access to this warehouse.');
    }
    return warehouse;
  }

  async deactivate(id: string, user: any) {
    await this.assertAccess(id, user);
    return this.prisma.warehouse.update({ where: { id }, data: { isActive: false } });
  }

  async reactivate(id: string, user: any) {
    await this.assertAccess(id, user);
    return this.prisma.warehouse.update({ where: { id }, data: { isActive: true } });
  }

  async removeAll(user: any) {
    const warehouses = await this.prisma.warehouse.findMany({
      where: companyFilter(user),
      select: {
        id: true,
        code: true,
        _count: {
          select: {
            assignedUsers: true,
            shipToAssignments: true,
            locations: true,
            inboundReceipts: true,
            outboundOrders: true,
            stockMovements: true,
            // gateEntries added 2026-08-27 — a real, pre-existing bug found
            // while testing detention cost: this check predates Yard & Gate
            // and never learned about it, so a warehouse with real gate-entry
            // history was wrongly marked "deletable" and the raw DELETE hit a
            // live FK constraint (surfaced as a raw 500, not a clean
            // "blocked" result). Real transaction history, same tier as
            // stockMovements/inboundReceipts/outboundOrders — blocks
            // deletion the same way those do.
            gateEntries: true,
            // vehicles/drivers added 2026-08-28, proactively this time (not
            // caught as a bug) — Vehicle.warehouseId/Driver.warehouseId's
            // FK is ON DELETE RESTRICT, same as every other relation here;
            // applying the "go back and add it" lesson from the gateEntries
            // fix above rather than waiting to hit the same class of raw-500
            // a third time.
            vehicles: true,
            drivers: true,
          },
        },
      },
    });
    const deletable: string[] = [];
    const blocked: string[] = [];
    for (const wh of warehouses) {
      const c = wh._count;
      const totalLinked = c.assignedUsers + c.shipToAssignments + c.locations + c.inboundReceipts + c.outboundOrders + c.stockMovements + c.gateEntries + c.vehicles + c.drivers;
      if (totalLinked > 0) blocked.push(wh.code);
      else deletable.push(wh.id);
    }
    if (deletable.length > 0) {
      // storageTypes/dispatchFlows are inherent detail of the warehouse (like
      // SkuStorageUnit/SkuBarcode for a SKU) — not "linked data" that blocks
      // deletion, just child rows that must go first (FK is ON DELETE RESTRICT).
      // yardSlots/dockDoors/gatePassSequences (2026-08-27) are the same kind
      // of child config, not real linked data — nothing else references a
      // DockDoor or GatePassSequence via FK, and gateEntries is already
      // confirmed zero above for every id in `deletable`, so no
      // VehicleGateEntry can be pointing at any of these warehouses' YardSlot
      // rows either. Safe to just clean them up alongside storageTypes/
      // dispatchFlows rather than blocking on them.
      await this.prisma.$transaction([
        this.prisma.warehouseStorageType.deleteMany({ where: { warehouseId: { in: deletable } } }),
        this.prisma.warehouseDispatchFlow.deleteMany({ where: { warehouseId: { in: deletable } } }),
        this.prisma.yardSlot.deleteMany({ where: { warehouseId: { in: deletable } } }),
        this.prisma.dockDoor.deleteMany({ where: { warehouseId: { in: deletable } } }),
        this.prisma.gatePassSequence.deleteMany({ where: { warehouseId: { in: deletable } } }),
        this.prisma.warehouse.deleteMany({ where: { id: { in: deletable } } }),
      ]);
    }
    return { deletedCount: deletable.length, blockedCount: blocked.length, blockedCodes: blocked };
  }

  // Single-record delete — "Delete All" alone wasn't enough once real data
  // built up (only one or two rows need removing, not the whole list); same
  // blocking-check shape as removeAll's per-row check, just for one id.
  // Confirmed 2026-08-25.
  async remove(id: string, user: any) {
    await this.assertAccess(id, user);
    const warehouse = await this.prisma.warehouse.findUnique({
      where: { id },
      select: {
        code: true,
        _count: {
          select: {
            assignedUsers: true,
            shipToAssignments: true,
            locations: true,
            inboundReceipts: true,
            outboundOrders: true,
            stockMovements: true,
            gateEntries: true, // see removeAll()'s comment — same 2026-08-27 fix
            vehicles: true, // see removeAll()'s comment — added 2026-08-28
            drivers: true,
          },
        },
      },
    });
    if (!warehouse) throw new NotFoundException('Warehouse not found.');
    const c = warehouse._count;
    const totalLinked = c.assignedUsers + c.shipToAssignments + c.locations + c.inboundReceipts + c.outboundOrders + c.stockMovements + c.gateEntries + c.vehicles + c.drivers;
    if (totalLinked > 0) {
      throw new BadRequestException(
        `Cannot permanently delete "${warehouse.code}" — it has ${totalLinked} linked record(s) (users, ship-tos, locations, gate entries, vehicles, drivers, or transactions). Deactivate it instead.`,
      );
    }
    await this.prisma.$transaction([
      this.prisma.warehouseStorageType.deleteMany({ where: { warehouseId: id } }),
      this.prisma.warehouseDispatchFlow.deleteMany({ where: { warehouseId: id } }),
      this.prisma.yardSlot.deleteMany({ where: { warehouseId: id } }),
      this.prisma.dockDoor.deleteMany({ where: { warehouseId: id } }),
      this.prisma.gatePassSequence.deleteMany({ where: { warehouseId: id } }),
      this.prisma.warehouse.delete({ where: { id } }),
    ]);
    return { deleted: true, code: warehouse.code };
  }

  async getCustomerSummary(user: any) {
    const where: any = { ...companyFilter(user) };
    if (WAREHOUSE_SCOPED_ROLES.includes(user.role)) {
      where.id = { in: await ownWarehouseIds(this.prisma, user.userId) };
    }
    const warehouses = await this.prisma.warehouse.findMany({
      where,
      include: { shipToAssignments: { select: { customerId: true, deliveryZone: true } } },
      orderBy: { code: 'asc' },
    });
    return warehouses.map((w) => ({
      warehouseId: w.id,
      code: w.code,
      name: w.name,
      shipToCount: w.shipToAssignments.length,
      customerCount: new Set(w.shipToAssignments.map((s) => s.customerId)).size,
      localCount: w.shipToAssignments.filter((s) => s.deliveryZone === 'LOCAL').length,
      upcountryCount: w.shipToAssignments.filter((s) => s.deliveryZone === 'UPCOUNTRY').length,
    }));
  }

  // Cross-checks each Storage Type breakdown row's planned Pallet Positions
  // against how many pallet positions actually exist among generated
  // Locations — "did we forget to generate something" QA (2026-08-25
  // design pass), not the reverse: a Location whose (storageType,
  // categoryId) doesn't match any planned row at all isn't flagged as
  // "extra", it's just invisible to this summary. Rack Locations count as 1
  // pallet position each (individually addressable); Ground/Stillage use
  // their derived depth×width×height capacity, same as attachCapacity().
  // Confirmed decisions: a Location with no Category set still counts,
  // matched into the "Uncategorized" bucket like everywhere else that
  // resolves a blank category; deactivated Locations still count (the
  // physical bin exists either way, active or not); a warehouse-level
  // "Mix" row is skipped entirely — it isn't broken down by real storage
  // type yet, so there's nothing concrete to compare it against.
  async getMappingSummary(user: any) {
    const where: any = { ...companyFilter(user) };
    if (WAREHOUSE_SCOPED_ROLES.includes(user.role)) {
      where.id = { in: await ownWarehouseIds(this.prisma, user.userId) };
    }
    const warehouses = await this.prisma.warehouse.findMany({
      where,
      include: { storageTypes: { include: { category: true } } },
      orderBy: { code: 'asc' },
    });
    if (warehouses.length === 0) return [];

    const uncategorized = await this.prisma.productCategory.findFirst({ where: { name: { equals: 'Uncategorized', mode: 'insensitive' } } });
    const locations = await this.prisma.location.findMany({
      where: { warehouseId: { in: warehouses.map((w) => w.id) } },
      select: { warehouseId: true, storageType: true, categoryId: true, depth: true, width: true, height: true },
    });

    const mappedMap = new Map<string, number>(); // `${warehouseId}::${storageType}::${categoryId}` -> pallet positions
    for (const loc of locations) {
      const categoryId = loc.categoryId || uncategorized?.id;
      if (!categoryId) continue; // no Category anywhere to attribute this to — shouldn't happen once seeded, skip defensively
      const key = `${loc.warehouseId}::${loc.storageType}::${categoryId}`;
      const positions = RACK_STORAGE_TYPES.includes(loc.storageType) ? 1 : (loc.depth || 1) * (loc.width || 1) * (loc.height || 1);
      mappedMap.set(key, (mappedMap.get(key) || 0) + positions);
    }

    return warehouses.map((w) => {
      const rows = w.storageTypes
        .filter((s) => s.storageType !== 'MIX')
        .map((s) => ({
          storageType: s.storageType,
          category: s.category.name,
          planned: Number(s.palletPositions),
          mapped: mappedMap.get(`${w.id}::${s.storageType}::${s.categoryId}`) || 0,
        }));
      return {
        warehouseId: w.id,
        code: w.code,
        name: w.name,
        rows,
        totalPlanned: rows.reduce((sum, r) => sum + r.planned, 0),
        totalMapped: rows.reduce((sum, r) => sum + r.mapped, 0),
      };
    });
  }

  // One row per (Warehouse, Storage Type) pair — mirrors the import's own
  // repeated-Location-Code grouping, so an exported file can be edited and
  // re-imported unchanged. A warehouse with no Storage Type rows still gets
  // one row (blank Storage Type columns) so it isn't dropped from the export.
  // Dispatch Flows have no natural per-row slot to repeat into, so they're
  // joined as one comma-separated column instead, same value on every row for
  // that warehouse.
  async exportRows(user: any) {
    const where: any = { ...companyFilter(user) };
    if (WAREHOUSE_SCOPED_ROLES.includes(user.role)) {
      where.id = { in: await ownWarehouseIds(this.prisma, user.userId) };
    }
    const warehouses = await this.prisma.warehouse.findMany({
      where,
      include: { storageTypes: { include: { category: true } }, dispatchFlows: true },
      orderBy: { code: 'asc' },
    });
    const rows: any[] = [];
    for (const w of warehouses) {
      const dispatchFlows = w.dispatchFlows.map((f) => f.flowType).join(', ');
      const base = {
        'Location Code': w.code,
        'Type of Node': w.nodeType || '',
        'City Name': w.city || '',
        'Address': w.address || '',
        'Pincode': w.pincode || '',
        'Latitude': w.latitude ?? '',
        'Longitude': w.longitude ?? '',
        '3PL Name': w.threePlName || '',
        'No of Docks': w.noOfDocks ?? '',
        'Area sq ft': w.areaSqFt ?? '',
        'Parking Slots': w.yardCapacity ?? '',
        'GSTIN': w.gstin || '',
        'Working Days': w.workingDays || '',
        'Working Hours': w.workingHours || '',
        'Contact Name': w.contactName || '',
        'Contact Phone': w.contactPhone || '',
        'Active': w.isActive ? 'TRUE' : 'FALSE',
        'Dispatch Flow': dispatchFlows,
      };
      if (w.storageTypes.length === 0) {
        rows.push({ ...base, 'Storage Type': '', 'Category': '', 'Pallet Positions': '', 'Dim L (m)': '', 'Dim W (m)': '', 'Dim H (m)': '' });
      } else {
        for (const s of w.storageTypes) {
          rows.push({
            ...base,
            'Storage Type': s.storageType,
            'Category': s.category.name,
            'Pallet Positions': s.palletPositions,
            'Dim L (m)': s.lengthM ?? '',
            'Dim W (m)': s.widthM ?? '',
            'Dim H (m)': s.heightM ?? '',
          });
        }
      }
    }
    return rows;
  }
}
