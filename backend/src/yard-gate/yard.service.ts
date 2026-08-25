import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { companyFilter, ownWarehouseIds, GATE_YARD_SCOPED_ROLES } from '../common/tenant.util';

// Yard Management (2026-08-26) — the summary/parked-list read side of the
// yard-slot tracking built in GateEntriesService. Deliberately its own
// small service rather than folded into DockDoorsService/GateEntriesService
// — this is a reporting view over data those two already own, not a third
// place that mutates YardSlot/VehicleGateEntry.
@Injectable()
export class YardService {
  constructor(private prisma: PrismaService) {}

  private async accessibleWarehouseIds(user: any): Promise<string[] | undefined> {
    if (GATE_YARD_SCOPED_ROLES.includes(user.role)) return ownWarehouseIds(this.prisma, user.userId);
    return undefined; // undefined = no extra restriction beyond companyFilter
  }

  // Per warehouse: total slots, how many occupied/available, and whether
  // Yard Management even applies (a warehouse with zero slots — no
  // yardCapacity set at creation — has no yard concept at all; confirmed
  // 2026-08-25 that this should be a clean "not configured" state, not an
  // empty/zero stat box).
  async summary(user: any) {
    const warehouseIds = await this.accessibleWarehouseIds(user);
    const warehouses = await this.prisma.warehouse.findMany({
      where: { ...companyFilter(user), ...(warehouseIds ? { id: { in: warehouseIds } } : {}) },
      select: {
        id: true,
        code: true,
        name: true,
        yardSlots: { where: { isActive: true }, select: { status: true } },
      },
      orderBy: { code: 'asc' },
    });

    return warehouses.map((w) => {
      const total = w.yardSlots.length;
      const occupied = w.yardSlots.filter((s) => s.status === 'OCCUPIED').length;
      return {
        warehouseId: w.id,
        warehouseCode: w.code,
        warehouseName: w.name,
        yardConfigured: total > 0,
        totalSlots: total,
        occupied,
        available: total - occupied,
      };
    });
  }

  // Vehicles currently sitting in the yard (slot assigned, not yet docked
  // in or gated out) — the "working table" from the Yard Management design
  // conversation. Elapsed time is never stored, only computed here at read
  // time (NOW - gateInAt), same "always derive" philosophy as net weight.
  async parked(user: any, warehouseId?: string) {
    const warehouseIds = await this.accessibleWarehouseIds(user);
    const where: any = {
      yardSlotId: { not: null },
      dockedInAt: null,
      gateOutAt: null,
      warehouse: { ...companyFilter(user) },
    };
    if (warehouseId) where.warehouseId = warehouseId;
    else if (warehouseIds) where.warehouseId = { in: warehouseIds };

    const entries = await this.prisma.vehicleGateEntry.findMany({
      where,
      include: {
        yardSlot: { select: { code: true } },
        vehicle: { select: { vehicleNumber: true } },
        warehouse: { select: { id: true, code: true, name: true } },
      },
      orderBy: { gateInAt: 'asc' },
    });

    const now = Date.now();
    return entries.map((e) => ({
      gateEntryId: e.id,
      warehouse: e.warehouse,
      slotCode: e.yardSlot?.code,
      vehicleNumber: e.vehicle.vehicleNumber,
      destinationCity: e.destinationCity,
      transporterName: e.transporterName,
      gateInAt: e.gateInAt,
      elapsedHours: (now - e.gateInAt.getTime()) / (1000 * 60 * 60),
    }));
  }
}
