import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  type AuthUser,
  companyFilter,
  ownWarehouseIds,
  OUTBOUND_SCOPED_ROLES,
} from '../common/tenant.util';
import { PickTasksService } from './pick-tasks.service';

const ORDER_INCLUDE = {
  warehouse: { select: { id: true, code: true, name: true, companyId: true } },
  createdBy: { select: { id: true, name: true } },
  vehicle: { select: { id: true, vehicleNumber: true } },
  gateEntry: {
    select: {
      id: true,
      assignedDockNumber: true,
      dockedInAt: true,
      gateOutAt: true,
    },
  },
  lines: {
    include: {
      sku: { select: { id: true, code: true, description: true } },
    },
  },
} as const;

// Outbound orders — the "order maker" half of Outbound/Picking/Dispatch,
// see CLAUDE.md's design section for the full conversation (2026-09-14).
// Orders are uploaded VEHICLE-WISE, confirmed directly: destination city +
// SKU/qty/priority lines captured up front, with the actual vehicle
// resolved AFTERWARD by matching an already-gated-in one — the opposite of
// Inbound's own pattern (vehicle required at creation there). Mirrors
// InboundReceiptsService's shape closely (warehouse-scoped, no direct
// companyId, order-number uniqueness checked in the service layer not a DB
// constraint, createdById/createdViaErpPush pair) with that one deliberate
// difference.
@Injectable()
export class OutboundOrdersService {
  constructor(
    private prisma: PrismaService,
    private pickTasks: PickTasksService,
  ) {}

  private async assertWarehouseAccess(warehouseId: string, user: AuthUser) {
    if (!warehouseId) throw new BadRequestException('warehouseId is required.');
    const warehouse = await this.prisma.warehouse.findUnique({
      where: { id: warehouseId },
    });
    if (!warehouse) throw new NotFoundException('Warehouse not found.');
    if (user.role !== 'SUPER_ADMIN' && warehouse.companyId !== user.companyId) {
      throw new ForbiddenException('You do not have access to this warehouse.');
    }
    if (OUTBOUND_SCOPED_ROLES.includes(user.role)) {
      const ids = await ownWarehouseIds(this.prisma, user.userId);
      if (!ids.includes(warehouseId))
        throw new ForbiddenException(
          'You do not have access to this warehouse.',
        );
    }
  }

  private validateOrderData(data: any): string[] {
    const errors: string[] = [];
    if (!data.warehouseId) errors.push('Warehouse is required.');
    if (!data.orderNo || !String(data.orderNo).trim())
      errors.push('Order No is required.');
    if (!data.destinationCity || !String(data.destinationCity).trim())
      errors.push('Destination City is required.');
    if (!Array.isArray(data.lines) || data.lines.length === 0) {
      errors.push('At least one order line is required.');
    } else {
      data.lines.forEach((l: any, i: number) => {
        if (!l.skuId) errors.push(`Line ${i + 1}: SKU is required.`);
        if (!l.orderedQty || Number(l.orderedQty) <= 0)
          errors.push(`Line ${i + 1}: Quantity must be a positive number.`);
      });
    }
    return errors;
  }

  // Manual creation only, this pass — Excel bulk import and ERP push
  // (confirmed wanted "from day one" in the design conversation) are NOT
  // built yet, flagged explicitly rather than silently dropped. Both are
  // mechanical fast-follows once this core path is proven, same shape as
  // Inbound's own three intake paths.
  async create(data: any, user: AuthUser) {
    const errors = this.validateOrderData(data);
    if (errors.length) throw new BadRequestException(errors);
    await this.assertWarehouseAccess(data.warehouseId, user);

    const dup = await this.prisma.outboundOrder.findFirst({
      where: {
        warehouseId: data.warehouseId,
        orderNo: String(data.orderNo).trim(),
      },
    });
    if (dup)
      throw new BadRequestException(
        `Order No "${data.orderNo}" already exists for this warehouse.`,
      );

    return this.prisma.outboundOrder.create({
      data: {
        warehouseId: data.warehouseId,
        orderNo: String(data.orderNo).trim(),
        destinationCity: String(data.destinationCity).trim(),
        customerName: data.customerName || null,
        createdById: user.userId,
        lines: {
          create: data.lines.map((l: any) => ({
            skuId: l.skuId,
            orderedQty: l.orderedQty,
            isPriority: !!l.isPriority,
          })),
        },
      },
      include: ORDER_INCLUDE,
    });
  }

  async findAll(user: AuthUser, warehouseId?: string) {
    const where: any = { warehouse: companyFilter(user) };
    if (warehouseId) {
      await this.assertWarehouseAccess(warehouseId, user);
      where.warehouseId = warehouseId;
    } else if (OUTBOUND_SCOPED_ROLES.includes(user.role)) {
      const ids = await ownWarehouseIds(this.prisma, user.userId);
      where.warehouseId = { in: ids };
    }
    return this.prisma.outboundOrder.findMany({
      where,
      include: ORDER_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string, user: AuthUser) {
    const order = await this.prisma.outboundOrder.findUnique({
      where: { id },
      include: ORDER_INCLUDE,
    });
    if (!order) throw new NotFoundException('Order not found.');
    await this.assertWarehouseAccess(order.warehouseId, user);
    return order;
  }

  // Candidate gated-in vehicles for this order — matched by destinationCity
  // (case-insensitive) at the order's own warehouse, OUTBOUND_DISPATCH
  // purpose, still open (gateOutAt null), and not already allotted to a
  // different order. Read-only. The actual allotment below is ALWAYS an
  // explicit action, even with exactly one candidate — matching this
  // codebase's own "a match is a deliberate click, never auto-applied"
  // convention (Inbound's own Match Order works the same way).
  async findCandidateVehicles(orderId: string, user: AuthUser) {
    const order = await this.findOne(orderId, user);
    if (order.status !== 'CREATED')
      throw new BadRequestException(
        'This order has already been allotted a vehicle.',
      );
    return this.prisma.vehicleGateEntry.findMany({
      where: {
        warehouseId: order.warehouseId,
        purpose: 'OUTBOUND_DISPATCH',
        gateOutAt: null,
        outboundOrderId: null,
        destinationCity: {
          equals: order.destinationCity,
          mode: 'insensitive',
        },
      },
      include: { vehicle: { select: { id: true, vehicleNumber: true } } },
      orderBy: { gateInAt: 'asc' },
    });
  }

  // The allot action — confirmed directly (2026-09-14): a Supervisor+
  // always picks explicitly (see findCandidateVehicles above), and
  // reservation (real PickTask creation against real on-hand) happens in
  // the SAME transaction, immediately — "reserve bin/pallet when gate in +
  // allotement is done," not a separate later step.
  //
  // Requires a resolvable outbound staging destination up front (via the
  // vehicle's assignedDockNumber matching a real DockDoor's own
  // outboundStagingLocationId, same resolution Inbound's Match Order
  // already uses for its own default) — hard-blocked here rather than
  // silently creating tasks with no landing spot, since "we want
  // visibility" (confirmed directly) depends on every PICK trip having a
  // real PICK_IN destination.
  async allot(orderId: string, gateEntryId: any, user: AuthUser) {
    if (!gateEntryId) throw new BadRequestException('gateEntryId is required.');
    const order = await this.findOne(orderId, user);
    if (order.status !== 'CREATED')
      throw new BadRequestException(
        'This order has already been allotted a vehicle.',
      );

    const gateEntry = await this.prisma.vehicleGateEntry.findUnique({
      where: { id: gateEntryId },
    });
    if (!gateEntry || gateEntry.warehouseId !== order.warehouseId)
      throw new BadRequestException('Gate entry not found for this warehouse.');
    if (gateEntry.purpose !== 'OUTBOUND_DISPATCH')
      throw new BadRequestException(
        'This gate entry is not an Outbound Dispatch visit.',
      );
    if (gateEntry.gateOutAt)
      throw new BadRequestException('This vehicle has already gated out.');
    if (gateEntry.outboundOrderId)
      throw new BadRequestException(
        'This vehicle is already allotted to a different order.',
      );
    if (
      (gateEntry.destinationCity || '').trim().toLowerCase() !==
      order.destinationCity.trim().toLowerCase()
    )
      throw new BadRequestException(
        "This vehicle's destination doesn't match the order's destination.",
      );
    if (!gateEntry.assignedDockNumber)
      throw new BadRequestException(
        'Assign a dock to this vehicle before allotting it to an order.',
      );

    const dock = await this.prisma.dockDoor.findFirst({
      where: {
        warehouseId: order.warehouseId,
        code: gateEntry.assignedDockNumber,
      },
    });
    if (!dock?.outboundStagingLocationId)
      throw new BadRequestException(
        `Dock ${gateEntry.assignedDockNumber} has no outbound staging location configured.`,
      );
    const stagingLocation = await this.prisma.location.findUnique({
      where: { id: dock.outboundStagingLocationId },
    });
    if (!stagingLocation)
      throw new BadRequestException('Outbound staging location not found.');
    await this.pickTasks.assertStagingBinAvailable(stagingLocation);

    return this.prisma.$transaction(async (tx) => {
      await tx.vehicleGateEntry.update({
        where: { id: gateEntryId },
        data: { outboundOrderId: orderId },
      });
      await tx.outboundOrder.update({
        where: { id: orderId },
        data: { vehicleId: gateEntry.vehicleId, status: 'ALLOTTED' },
      });

      for (const line of order.lines) {
        await this.pickTasks.createTaskForLine(
          tx,
          line,
          order.warehouseId,
          stagingLocation.id,
        );
      }

      await tx.outboundOrder.update({
        where: { id: orderId },
        data: { status: 'ALLOCATED' },
      });
      return tx.outboundOrder.findUnique({
        where: { id: orderId },
        include: ORDER_INCLUDE,
      });
    });
  }
}
