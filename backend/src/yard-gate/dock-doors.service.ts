import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CODE_REGEX } from '../common/validation.util';
import { normalizeCode } from '../common/normalize.util';
import { companyFilter, ownWarehouseIds, GATE_YARD_SCOPED_ROLES } from '../common/tenant.util';

const DOCK_TYPE_VALUES = ['INBOUND', 'OUTBOUND', 'BOTH'];

const DOCK_DOOR_INCLUDE = {
  warehouse: { select: { id: true, code: true, name: true } },
  defaultStagingLocation: { select: { id: true, code: true } },
  outboundStagingLocation: { select: { id: true, code: true } },
} as const;

// Dock Door master data — foundation piece of Yard & Gate Management
// (2026-08-25). See schema.prisma's "YARD & GATE MANAGEMENT" section and
// CLAUDE.md for the full reasoning: this is deliberately just the physical
// door + its status, with Yard (parking) and Dock Scheduling (appointment
// booking) left for a later pass. Same "validate + build" shape as every
// other master-data service in this codebase.
@Injectable()
export class DockDoorsService {
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
    if (GATE_YARD_SCOPED_ROLES.includes(user.role)) {
      const ids = await ownWarehouseIds(this.prisma, user.userId);
      if (!ids.includes(warehouseId)) errors.push('You can only manage dock doors in your own assigned warehouse(s).');
    }
  }

  // Staging-location FK resolution lives here (not just a plain scalar
  // assignment) since it needs both a same-warehouse check and the
  // company/role scoping — same reasoning as
  // InboundReceiptsService.validateLines's stagingLocationId handling.
  // `label` is only used in the error message, so this one function backs
  // both the Inbound (defaultStagingLocationId) and Outbound
  // (outboundStagingLocationId) fields — added 2026-08-28 alongside the
  // Outbound sibling (see schema.prisma's comment on
  // DockDoor.outboundStagingLocationId).
  private async resolveStagingLocationId(warehouseId: string, locationId: any, label: string, errors: string[]): Promise<string | undefined> {
    if (!locationId) return undefined;
    const location = await this.prisma.location.findUnique({ where: { id: locationId } });
    if (!location) {
      errors.push(`${label} Staging Location not found.`);
      return undefined;
    }
    if (location.warehouseId !== warehouseId) {
      errors.push(`${label} Staging Location does not belong to this dock's warehouse.`);
      return undefined;
    }
    return location.id;
  }

  private validate(data: any, errors: string[]): { code: string; name?: string; dockType: string } {
    const code = data.code ? String(data.code).trim().toUpperCase() : '';
    if (!code) errors.push('Dock Door code is required.');
    else if (!CODE_REGEX.test(code)) errors.push('Dock Door code must be 1-30 characters, letters/numbers/hyphens only.');

    const dockType = data.dockType ? normalizeCode(data.dockType) : 'BOTH';
    if (!DOCK_TYPE_VALUES.includes(dockType)) {
      errors.push(`Dock Type must be one of: ${DOCK_TYPE_VALUES.join(', ')}.`);
    }

    return { code, name: data.name ? String(data.name).trim() : undefined, dockType };
  }

  async create(data: any, user: any) {
    if (!user.companyId) {
      throw new ForbiddenException('Super admin accounts cannot create dock doors directly — log in as a company admin instead.');
    }
    const errors: string[] = [];
    const warehouseId = data.warehouseId;
    if (!warehouseId) errors.push('Warehouse is required.');
    else await this.assertWarehouseAccess(warehouseId, user, errors);
    const { code, name, dockType } = this.validate(data, errors);
    const defaultStagingLocationId = warehouseId ? await this.resolveStagingLocationId(warehouseId, data.defaultStagingLocationId, 'Default (Inbound)', errors) : undefined;
    const outboundStagingLocationId = warehouseId ? await this.resolveStagingLocationId(warehouseId, data.outboundStagingLocationId, 'Outbound', errors) : undefined;
    if (errors.length > 0) throw new BadRequestException(errors);

    const existing = await this.prisma.dockDoor.findUnique({ where: { warehouseId_code: { warehouseId, code } } });
    if (existing) throw new BadRequestException(`A dock door with code "${code}" already exists in this warehouse.`);

    return this.prisma.dockDoor.create({
      data: {
        warehouse: { connect: { id: warehouseId } },
        code,
        name,
        dockType: dockType as any,
        defaultStagingLocation: defaultStagingLocationId ? { connect: { id: defaultStagingLocationId } } : undefined,
        outboundStagingLocation: outboundStagingLocationId ? { connect: { id: outboundStagingLocationId } } : undefined,
      },
      include: DOCK_DOOR_INCLUDE,
    });
  }

  async findAll(user: any) {
    const where: any = { warehouse: { ...companyFilter(user) } };
    if (GATE_YARD_SCOPED_ROLES.includes(user.role)) {
      where.warehouseId = { in: await ownWarehouseIds(this.prisma, user.userId) };
    }
    const doors = await this.prisma.dockDoor.findMany({
      where,
      include: DOCK_DOOR_INCLUDE,
      orderBy: [{ warehouse: { code: 'asc' } }],
    });
    // `code` is a string column, so Prisma's own orderBy sorts it
    // lexicographically ("1", "10", "2"...) — wrong once a warehouse has 10+
    // docks (caught live, 2026-08-28: a real 10-dock warehouse showed Dock 10
    // right after Dock 1). Re-sorted here numerically when the code parses as
    // a number (true for every auto-generated dock), falling back to a plain
    // string compare for a non-numeric legacy manual code.
    return doors.sort((a, b) => {
      const warehouseCompare = a.warehouse.code.localeCompare(b.warehouse.code);
      if (warehouseCompare !== 0) return warehouseCompare;
      const an = parseInt(a.code, 10);
      const bn = parseInt(b.code, 10);
      if (!isNaN(an) && !isNaN(bn)) return an - bn;
      return a.code.localeCompare(b.code);
    });
  }

  private async assertAccess(id: string, user: any) {
    const door = await this.prisma.dockDoor.findUnique({ where: { id }, include: { warehouse: true } });
    if (!door) throw new NotFoundException('Dock door not found.');
    if (user.role !== 'SUPER_ADMIN' && door.warehouse.companyId !== user.companyId) {
      throw new ForbiddenException('You do not have access to this dock door.');
    }
    if (GATE_YARD_SCOPED_ROLES.includes(user.role)) {
      const ids = await ownWarehouseIds(this.prisma, user.userId);
      if (!ids.includes(door.warehouseId)) throw new ForbiddenException('You do not have access to this dock door.');
    }
    return door;
  }

  // A dock currently OCCUPIED (a real vehicle physically docked in — see
  // GateEntriesService.setDockDoorStatus, 2026-08-28) can't be edited, have
  // its status manually changed, deactivated, or deleted — the client's own
  // explicit follow-up: "if its occupied i shouldnt be allowed to change
  // anything... after dockout only the options should come in". Nothing
  // here can silently release it either — only a real Gate Out does that.
  // AVAILABLE and MAINTENANCE docks are unaffected — this only guards
  // OCCUPIED.
  private assertNotOccupied(door: { status: string; code: string }) {
    if (door.status === 'OCCUPIED') {
      throw new BadRequestException(`Dock "${door.code}" is currently occupied — no changes are allowed until the vehicle gates out.`);
    }
  }

  // Resolves one staging-location field's update value: field explicitly
  // present but empty means "clear it" (returns null -> disconnect),
  // present and non-empty means "set it" (returns the resolved id ->
  // connect), key absent entirely means "leave unchanged" (returns
  // undefined -> omitted from the Prisma update entirely) — same
  // blank-clears-a-setting convention as Company Settings. Shared by both
  // the Inbound and Outbound fields (2026-08-28).
  private async resolveStagingUpdate(warehouseId: string, data: any, field: string, label: string, errors: string[]): Promise<string | null | undefined> {
    if (!Object.prototype.hasOwnProperty.call(data, field)) return undefined;
    if (!data[field]) return null;
    const resolved = await this.resolveStagingLocationId(warehouseId, data[field], label, errors);
    return resolved ?? undefined;
  }

  async update(id: string, data: any, user: any) {
    const existingDoor = await this.assertAccess(id, user);
    this.assertNotOccupied(existingDoor);
    const errors: string[] = [];
    const { code, name, dockType } = this.validate(data, errors);
    const defaultStagingLocationId = await this.resolveStagingUpdate(existingDoor.warehouseId, data, 'defaultStagingLocationId', 'Default (Inbound)', errors);
    const outboundStagingLocationId = await this.resolveStagingUpdate(existingDoor.warehouseId, data, 'outboundStagingLocationId', 'Outbound', errors);
    if (errors.length > 0) throw new BadRequestException(errors);

    const duplicate = await this.prisma.dockDoor.findUnique({ where: { warehouseId_code: { warehouseId: existingDoor.warehouseId, code } } });
    if (duplicate && duplicate.id !== id) throw new BadRequestException(`A dock door with code "${code}" already exists in this warehouse.`);

    const toRelation = (v: string | null | undefined) => (v === null ? { disconnect: true } : v ? { connect: { id: v } } : undefined);

    return this.prisma.dockDoor.update({
      where: { id },
      data: {
        code,
        name,
        dockType: dockType as any,
        defaultStagingLocation: toRelation(defaultStagingLocationId),
        outboundStagingLocation: toRelation(outboundStagingLocationId),
      },
      include: DOCK_DOOR_INCLUDE,
    });
  }

  // Status is a separate, lighter-weight action than update() — marking a
  // door AVAILABLE/OCCUPIED/MAINTENANCE happens far more often than editing
  // its code/name/type, and is exactly the field GateEntriesService flips
  // automatically on gate-out/dock-assignment (see gate-entries.service.ts).
  async setStatus(id: string, status: string, user: any) {
    const door = await this.assertAccess(id, user);
    this.assertNotOccupied(door);
    if (!['AVAILABLE', 'OCCUPIED', 'MAINTENANCE'].includes(status)) {
      throw new BadRequestException('Status must be one of: AVAILABLE, OCCUPIED, MAINTENANCE.');
    }
    return this.prisma.dockDoor.update({ where: { id }, data: { status: status as any } });
  }

  async deactivate(id: string, user: any) {
    const door = await this.assertAccess(id, user);
    this.assertNotOccupied(door);
    return this.prisma.dockDoor.update({ where: { id }, data: { isActive: false } });
  }

  async reactivate(id: string, user: any) {
    await this.assertAccess(id, user);
    return this.prisma.dockDoor.update({ where: { id }, data: { isActive: true } });
  }

  // Nothing links to DockDoor yet via a real FK (deliberately decoupled from
  // VehicleGateEntry, see schema.prisma's comment on the model), so unlike
  // Location/Warehouse's removeAll there's no "blocked, has linked records"
  // case from foreign keys — but an OCCUPIED dock (2026-08-28) is now its
  // own "blocked" case, same shape as everywhere else in this codebase:
  // skip it, report it, delete the rest.
  async removeAll(user: any) {
    const doors = await this.prisma.dockDoor.findMany({ where: { warehouse: { ...companyFilter(user) } }, select: { id: true, code: true, status: true } });
    const deletable = doors.filter((d) => d.status !== 'OCCUPIED');
    const blocked = doors.filter((d) => d.status === 'OCCUPIED');
    if (deletable.length > 0) await this.prisma.dockDoor.deleteMany({ where: { id: { in: deletable.map((d) => d.id) } } });
    return { deletedCount: deletable.length, blockedCount: blocked.length, blockedCodes: blocked.map((d) => d.code) };
  }

  async remove(id: string, user: any) {
    const door = await this.assertAccess(id, user);
    this.assertNotOccupied(door);
    await this.prisma.dockDoor.delete({ where: { id } });
    return { deleted: true, code: door.code };
  }
}
