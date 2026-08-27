import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { assertGateAccessAllowed, companyFilter, ownWarehouseIds, GATE_YARD_SCOPED_ROLES } from '../common/tenant.util';

// Yard Management (2026-08-26, extended 2026-08-27) — the summary/tracker
// read side of the yard-slot tracking built in GateEntriesService.
// Deliberately its own small service rather than folded into
// DockDoorsService/GateEntriesService — this is a reporting view over data
// those two already own, not a third place that mutates
// YardSlot/VehicleGateEntry.
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
    await assertGateAccessAllowed(this.prisma, user);
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

  // The "working table" — every gate entry still open (not yet gated out),
  // whether it's still waiting in the yard or has already been marked
  // Docked In. Elapsed times are never stored, only computed here at read
  // time, same "always derive" philosophy as net weight:
  //  - hoursInParking: gateInAt -> dockedInAt (fixed, once docked) or
  //    gateInAt -> NOW (still climbing, while waiting).
  //  - hoursInDock: null until dockedInAt is set, then dockedInAt -> NOW
  //    (a docked-but-not-yet-gated-out vehicle is still "in dock" by
  //    definition — this row disappears from the table entirely once Gate
  //    Out closes it).
  async tracker(user: any, warehouseId?: string) {
    await assertGateAccessAllowed(this.prisma, user);
    const warehouseIds = await this.accessibleWarehouseIds(user);
    // Real bug caught 2026-08-27 (client-reported, "supervisor should only
    // see that warehouse, not all"): an explicit ?warehouseId= query param
    // used to override the scoped role's own-warehouse restriction entirely
    // — a Supervisor could just pass a different warehouse's id and see it.
    // An explicit id must now fall WITHIN the caller's own accessible set,
    // never bypass it.
    if (warehouseId && warehouseIds && !warehouseIds.includes(warehouseId)) {
      throw new ForbiddenException('You do not have access to this warehouse.');
    }
    const where: any = { gateOutAt: null, warehouse: { ...companyFilter(user) } };
    if (warehouseId) where.warehouseId = warehouseId;
    else if (warehouseIds) where.warehouseId = { in: warehouseIds };

    const entries = await this.prisma.vehicleGateEntry.findMany({
      where,
      include: {
        yardSlot: { select: { code: true } },
        // vehicleType.name/segment added 2026-08-27 (a real "practical
        // recall" ask — staff scanning this table want to know the truck
        // type at a glance, not just its plate number).
        vehicle: { select: { vehicleNumber: true, detentionCostPerDay: true, vehicleType: { select: { name: true, segment: true, detentionCostPerDay: true } } } },
        warehouse: { select: { id: true, code: true, name: true, company: { select: { detentionCostPerDay: true, detentionFreeHours: true } } } },
      },
      orderBy: { gateInAt: 'asc' },
    });

    const now = Date.now();
    const hoursBetween = (start: Date, end: number) => (end - start.getTime()) / (1000 * 60 * 60);

    return entries.map((e) => {
      // Detention cost (2026-08-27, corrected TWICE same day — "one mistake,
      // you were right," then "don't keep a proportional logic for now,
      // just keep it simple"): free for the first Company.detentionFreeHours
      // (default 4), then a flat step of the daily rate is added for every
      // FULL 24-hour block past that free window — not prorated. So a
      // vehicle at 27 chargeable-adjusted hours still owes ₹0 (hasn't
      // completed a full day yet), and one at 28 hours (exactly one full day
      // past the free window) owes the full rate; a second full rate step
      // only lands at 52 hours, not gradually between 28 and 52. Always
      // computed live here, never stored, same "always derive" philosophy as
      // everything else on this table. Rate resolution: the vehicle's own
      // override, else its VehicleType's, else the company-wide default —
      // most companies only ever set the last one (Company.
      // detentionCostPerDay, defaults to 15000, the client's own
      // placeholder). Null only if a company has explicitly cleared its own
      // default AND set no vehicle/type-level rate either.
      const rate = e.vehicle.detentionCostPerDay ?? e.vehicle.vehicleType.detentionCostPerDay ?? e.warehouse.company.detentionCostPerDay;
      const freeHours = e.warehouse.company.detentionFreeHours ?? 0;
      const totalHours = hoursBetween(e.gateInAt, now);
      const chargeableHours = Math.max(0, totalHours - freeHours);
      const fullDaysElapsed = Math.floor(chargeableHours / 24);
      const detentionCost = rate != null ? fullDaysElapsed * Number(rate) : null;

      return {
        gateEntryId: e.id,
        // Added 2026-08-27 (Inbound deep-dive) so the frontend can split
        // "vehicles to unload" from "vehicles to load" without a separate
        // join against the full gate-entries list — the page already did
        // this join before, just fragile (see GateYardPage.tsx history).
        purpose: e.purpose,
        warehouse: { id: e.warehouse.id, code: e.warehouse.code, name: e.warehouse.name },
        slotCode: e.yardSlot?.code,
        vehicleNumber: e.vehicle.vehicleNumber,
        vehicleType: e.vehicle.vehicleType ? { name: e.vehicle.vehicleType.name, segment: e.vehicle.vehicleType.segment } : null,
        destinationCity: e.destinationCity,
        transporterName: e.transporterName,
        gateInAt: e.gateInAt,
        dockedInAt: e.dockedInAt,
        assignedDockNumber: e.assignedDockNumber,
        dockAssignedAt: e.dockAssignedAt,
        status: e.dockedInAt ? 'DOCKED' : 'IN_YARD',
        hoursInParking: hoursBetween(e.gateInAt, e.dockedInAt ? e.dockedInAt.getTime() : now),
        hoursInDock: e.dockedInAt ? hoursBetween(e.dockedInAt, now) : null,
        detentionCost,
      };
    });
  }
}
