import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CODE_REGEX } from '../common/validation.util';
import { normalizeCode } from '../common/normalize.util';
import { companyFilter, ownWarehouseIds, GATE_YARD_SCOPED_ROLES } from '../common/tenant.util';

const DOCK_TYPE_VALUES = ['INBOUND', 'OUTBOUND', 'BOTH'];

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
    if (errors.length > 0) throw new BadRequestException(errors);

    const existing = await this.prisma.dockDoor.findUnique({ where: { warehouseId_code: { warehouseId, code } } });
    if (existing) throw new BadRequestException(`A dock door with code "${code}" already exists in this warehouse.`);

    return this.prisma.dockDoor.create({
      data: { warehouse: { connect: { id: warehouseId } }, code, name, dockType: dockType as any },
      include: { warehouse: { select: { id: true, code: true, name: true } } },
    });
  }

  async findAll(user: any) {
    const where: any = { warehouse: { ...companyFilter(user) } };
    if (GATE_YARD_SCOPED_ROLES.includes(user.role)) {
      where.warehouseId = { in: await ownWarehouseIds(this.prisma, user.userId) };
    }
    return this.prisma.dockDoor.findMany({
      where,
      include: { warehouse: { select: { id: true, code: true, name: true } } },
      orderBy: [{ warehouse: { code: 'asc' } }, { code: 'asc' }],
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

  async update(id: string, data: any, user: any) {
    const existingDoor = await this.assertAccess(id, user);
    const errors: string[] = [];
    const { code, name, dockType } = this.validate(data, errors);
    if (errors.length > 0) throw new BadRequestException(errors);

    const duplicate = await this.prisma.dockDoor.findUnique({ where: { warehouseId_code: { warehouseId: existingDoor.warehouseId, code } } });
    if (duplicate && duplicate.id !== id) throw new BadRequestException(`A dock door with code "${code}" already exists in this warehouse.`);

    return this.prisma.dockDoor.update({
      where: { id },
      data: { code, name, dockType: dockType as any },
      include: { warehouse: { select: { id: true, code: true, name: true } } },
    });
  }

  // Status is a separate, lighter-weight action than update() — marking a
  // door AVAILABLE/OCCUPIED/MAINTENANCE happens far more often than editing
  // its code/name/type, and is exactly the field GateEntriesService flips
  // automatically on gate-out/dock-assignment (see gate-entries.service.ts).
  async setStatus(id: string, status: string, user: any) {
    await this.assertAccess(id, user);
    if (!['AVAILABLE', 'OCCUPIED', 'MAINTENANCE'].includes(status)) {
      throw new BadRequestException('Status must be one of: AVAILABLE, OCCUPIED, MAINTENANCE.');
    }
    return this.prisma.dockDoor.update({ where: { id }, data: { status: status as any } });
  }

  async deactivate(id: string, user: any) {
    await this.assertAccess(id, user);
    return this.prisma.dockDoor.update({ where: { id }, data: { isActive: false } });
  }

  async reactivate(id: string, user: any) {
    await this.assertAccess(id, user);
    return this.prisma.dockDoor.update({ where: { id }, data: { isActive: true } });
  }

  // Nothing links to DockDoor yet (deliberately decoupled from
  // VehicleGateEntry, see schema.prisma's comment on the model) — so unlike
  // Location/Warehouse's removeAll, there's currently no "blocked, has
  // linked records" case to check for. Revisit once Dock Scheduling exists.
  async removeAll(user: any) {
    const doors = await this.prisma.dockDoor.findMany({ where: { warehouse: { ...companyFilter(user) } }, select: { id: true } });
    if (doors.length > 0) await this.prisma.dockDoor.deleteMany({ where: { id: { in: doors.map((d) => d.id) } } });
    return { deletedCount: doors.length, blockedCount: 0, blockedCodes: [] };
  }

  async remove(id: string, user: any) {
    const door = await this.assertAccess(id, user);
    await this.prisma.dockDoor.delete({ where: { id } });
    return { deleted: true, code: door.code };
  }
}
