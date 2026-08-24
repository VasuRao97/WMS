import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { normalizeCode } from '../common/normalize.util';
import { companyFilter } from '../common/tenant.util';
import { CODE_REGEX, PINCODE_REGEX } from '../common/validation.util';
import { toNumberOrUndefined } from '../common/xlsx-parse.util';

const NODE_TYPE_VALUES = ['FACTORY', 'DISTRIBUTOR', 'REGIONAL_DC', 'NATIONAL_DC', 'CNF', 'CROSS_DOCK'];
const STORAGE_TYPE_VALUES = ['GROUND_FLOOR', 'SPR', 'DRIVE_IN', 'MIX', 'ASRS'];
const DISPATCH_FLOW_VALUES = ['FULL_PALLET', 'CASE_PICK', 'BROKEN_CASE'];

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
    if (data.noOfDocks !== undefined && data.noOfDocks !== null && data.noOfDocks !== '' && Number(data.noOfDocks) < 0) {
      errors.push('No of Docks cannot be negative.');
    }
    if (data.areaSqFt !== undefined && data.areaSqFt !== null && data.areaSqFt !== '' && Number(data.areaSqFt) <= 0) {
      errors.push('Area sq ft must be a positive number.');
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

    return this.prisma.warehouse.create({
      data: this.buildCreateData(data, user.companyId, data.name, resolvedStorageTypes),
      include: { storageTypes: { include: { category: true } }, dispatchFlows: true },
    });
  }

  findAll(user: any) {
    return this.prisma.warehouse.findMany({
      where: companyFilter(user),
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
        await this.prisma.warehouse.create({ data: this.buildCreateData(group, user.companyId, name, resolvedStorageTypes) });
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
          },
        },
      },
    });
    const deletable: string[] = [];
    const blocked: string[] = [];
    for (const wh of warehouses) {
      const c = wh._count;
      const totalLinked = c.assignedUsers + c.shipToAssignments + c.locations + c.inboundReceipts + c.outboundOrders + c.stockMovements;
      if (totalLinked > 0) blocked.push(wh.code);
      else deletable.push(wh.id);
    }
    if (deletable.length > 0) {
      // storageTypes/dispatchFlows are inherent detail of the warehouse (like
      // SkuStorageUnit/SkuBarcode for a SKU) — not "linked data" that blocks
      // deletion, just child rows that must go first (FK is ON DELETE RESTRICT).
      await this.prisma.$transaction([
        this.prisma.warehouseStorageType.deleteMany({ where: { warehouseId: { in: deletable } } }),
        this.prisma.warehouseDispatchFlow.deleteMany({ where: { warehouseId: { in: deletable } } }),
        this.prisma.warehouse.deleteMany({ where: { id: { in: deletable } } }),
      ]);
    }
    return { deletedCount: deletable.length, blockedCount: blocked.length, blockedCodes: blocked };
  }

  async getCustomerSummary(user: any) {
    const warehouses = await this.prisma.warehouse.findMany({
      where: companyFilter(user),
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
}
