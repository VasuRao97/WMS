import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  type AuthUser,
  ownWarehouseIds,
  OUTBOUND_SCOPED_ROLES,
} from '../common/tenant.util';
import { buildRackName, laneKeyOf } from '../common/rack-name.util';

const TASK_INCLUDE = {
  orderLine: {
    select: {
      id: true,
      orderedQty: true,
      pickedQty: true,
      isPriority: true,
      order: {
        select: {
          id: true,
          orderNo: true,
          destinationCity: true,
          warehouseId: true,
        },
      },
    },
  },
  sku: { select: { id: true, code: true, description: true } },
  fromLocation: {
    select: {
      id: true,
      code: true,
      warehouseId: true,
      storageType: true,
      aisle: true,
      rack: true,
      level: true,
      depth: true,
      block: true,
      stack: true,
      flankNumber: true,
    },
  },
  toLocation: { select: { id: true, code: true } },
} as const;

// Picking — see CLAUDE.md's Outbound/Picking/Dispatch design section for
// the full round-by-round conversation this comes out of (2026-09-14).
// Mirrors PutawayTasksService's own scan-driven claim/complete shape as
// closely as the reversed direction allows: Putaway's source (staging) is
// fixed and its destination (a bin) varies; Picking's destination (staging)
// is fixed and its SOURCE varies.
@Injectable()
export class PickTasksService {
  constructor(private prisma: PrismaService) {}

  // Mirrors GateEntriesService's own private assertStagingBinAvailable() —
  // duplicated rather than cross-module-imported, same "each module queries
  // Prisma directly for small checks" convention this codebase already
  // follows (see recomputeReceiptStatus's own two independent copies). The
  // client's own rule, now exercised for real from the Outbound side for
  // the first time: "only one bin can be used at a time, if unloading is
  // going on, inbound bin cant be used" (and the reverse).
  async assertStagingBinAvailable(location: {
    code: string;
    warehouseId: string;
  }) {
    let siblingCode: string | undefined;
    if (location.code.endsWith('-SA-IB'))
      siblingCode = location.code.slice(0, -'-SA-IB'.length) + '-SA-OB';
    else if (location.code.endsWith('-SA-OB'))
      siblingCode = location.code.slice(0, -'-SA-OB'.length) + '-SA-IB';
    if (!siblingCode) return;
    const sibling = await this.prisma.location.findUnique({
      where: {
        warehouseId_code: {
          warehouseId: location.warehouseId,
          code: siblingCode,
        },
      },
    });
    if (!sibling) return;
    const balance = await this.prisma.stockMovement.aggregate({
      where: { locationId: sibling.id },
      _sum: { quantity: true },
    });
    if (Number(balance._sum.quantity || 0) > 0) {
      throw new BadRequestException(
        `Dock staging bin "${sibling.code}" is currently in use for the other direction — free it first.`,
      );
    }
  }

  // Identical to PutawayTasksService's own — see its comment on
  // Warehouse.agingGranularity for the full reasoning. Duplicated rather
  // than cross-imported (this codebase's own small-helper convention);
  // confirmed directly (2026-09-14) that Picking reuses the exact same
  // per-warehouse tolerance Putaway already has, not a second dial.
  private sameAgeBucket(a: Date, b: Date, granularity: string | null): boolean {
    if (!granularity) return a.getTime() === b.getTime();
    if (granularity === 'DAY') return a.toDateString() === b.toDateString();
    if (granularity === 'MONTH')
      return (
        a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth()
      );
    if (granularity === 'WEEK') {
      const weekStart = (d: Date) => {
        const x = new Date(d);
        const day = (x.getDay() + 6) % 7;
        x.setDate(x.getDate() - day);
        x.setHours(0, 0, 0, 0);
        return x.getTime();
      };
      return weekStart(a) === weekStart(b);
    }
    return false;
  }

  // The core pick-SOURCE algorithm — the reverse of suggestBin(). Returns
  // ONE real position — always the current FRONT-MOST occupied position
  // within whichever lane gets chosen, for a LIFO-constrained storage type
  // — plus how much is genuinely available AT THAT ONE POSITION (never a
  // whole lane's combined total). A real bug surfaced this the hard way
  // (2026-09-14): a first version returned a single fromLocationId per task
  // but let the task's own `quantity` be the FULL remaining line demand
  // (summed across a whole lane) — a task then recorded its entire trip
  // quantity against that one Location row, silently driving a shallower
  // position's own balance negative while a deeper position sitting right
  // next to it went untouched, corrupting on-hand for the whole SKU. Fixed
  // by making this function position-scoped, not lane-scoped — the lane is
  // only ever used to PICK which position to return, never to size the
  // task itself. See createTaskForLine() below for the loop this now
  // requires: an order line whose demand spans more real positions than
  // one now correctly gets several PickTasks, one per real position, each
  // capped at what that position genuinely holds — the same "one task, one
  // coherent physical location" shape PutawayTask already has.
  //
  // Two rules confirmed directly, in this exact priority order, still
  // govern which LANE gets chosen (not which position within it — that's
  // always front-most):
  // 1. Oldest aging bucket wins — real FIFO across buckets
  //    (Warehouse.agingGranularity, same tolerance suggestBin() uses).
  // 2. WITHIN the same bucket, prefer a lane whose combined available
  //    quantity can fully cover the remaining need in one clean take (a
  //    whole-unit match), smallest-sufficient first — approximating "pick
  //    a full pallet/lane over breaking two" at the reservation level. This
  //    is a v1 simplification: the REAL whole-pallet-vs-partial distinction
  //    is enforced for real at trip completion against whatever's actually
  //    scanned, not predicted precisely here.
  //
  // Scoped to ACTUAL_STORAGE for v1 — Pick Face priority (picking from the
  // fast-access slot before reserve) is a real, flagged follow-on, not
  // built this pass; nothing currently writes PICK from a PICK_FACE
  // location either.
  private async suggestPickPosition(
    tx: any,
    params: { warehouseId: string; skuId: string; quantity: number },
  ): Promise<{ locationId: string; available: number } | null> {
    const { warehouseId, skuId, quantity } = params;

    const locations = await tx.location.findMany({
      where: { warehouseId, isActive: true, zoneType: 'ACTUAL_STORAGE' },
      select: {
        id: true,
        storageType: true,
        aisle: true,
        rack: true,
        level: true,
        block: true,
        stack: true,
        flankNumber: true,
        depth: true,
      },
    });
    if (locations.length === 0) return null;
    const locationIds = locations.map((l: any) => l.id);

    const movements = await tx.stockMovement.findMany({
      where: { locationId: { in: locationIds }, skuId },
      select: {
        locationId: true,
        quantity: true,
        receivedDate: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });
    if (movements.length === 0) return null;

    const byLocation = new Map<
      string,
      { balance: number; receivedDate: Date | null }
    >();
    for (const m of movements) {
      const qty = Number(m.quantity);
      const row = byLocation.get(m.locationId) || {
        balance: 0,
        receivedDate: null,
      };
      row.balance += qty;
      if (qty > 0) row.receivedDate = m.receivedDate ?? row.receivedDate;
      byLocation.set(m.locationId, row);
    }

    // Pending-reservation awareness — every other still-open PickTask's own
    // remaining quantity reduces what's genuinely available, the exact
    // mirror of the "pending-reservation blind spot" fix suggestBin() itself
    // needed on the destination side (2026-08-29).
    const pendingTasks = await tx.pickTask.findMany({
      where: { fromLocationId: { in: locationIds }, status: 'PENDING' },
      select: {
        fromLocationId: true,
        quantity: true,
        trips: { select: { quantity: true, status: true } },
      },
    });
    const reservedByLocation = new Map<string, number>();
    for (const t of pendingTasks) {
      const moved = t.trips
        .filter((tr: any) => tr.status === 'COMPLETED')
        .reduce((s: number, tr: any) => s + Number(tr.quantity), 0);
      const stillOwed = Math.max(0, Number(t.quantity) - moved);
      reservedByLocation.set(
        t.fromLocationId,
        (reservedByLocation.get(t.fromLocationId) || 0) + stillOwed,
      );
    }

    type LaneCandidate = {
      laneKey: string;
      available: number;
      oldestReceivedDate: Date | null;
    };
    const lanes = new Map<string, LaneCandidate>();
    for (const loc of locations) {
      const bal = byLocation.get(loc.id);
      if (!bal || bal.balance <= 0) continue;
      const reserved = reservedByLocation.get(loc.id) || 0;
      const available = bal.balance - reserved;
      if (available <= 0) continue;
      const key = laneKeyOf(loc);
      const existing = lanes.get(key);
      if (!existing) {
        lanes.set(key, {
          laneKey: key,
          available,
          oldestReceivedDate: bal.receivedDate,
        });
      } else {
        existing.available += available;
        if (
          bal.receivedDate &&
          (!existing.oldestReceivedDate ||
            bal.receivedDate < existing.oldestReceivedDate)
        )
          existing.oldestReceivedDate = bal.receivedDate;
      }
    }
    if (lanes.size === 0) return null;

    const warehouse = await tx.warehouse.findUnique({
      where: { id: warehouseId },
      select: { agingGranularity: true },
    });
    const granularity = warehouse?.agingGranularity ?? null;

    const candidates = [...lanes.values()];
    candidates.sort((a, b) => {
      const dateA = a.oldestReceivedDate?.getTime() ?? 0;
      const dateB = b.oldestReceivedDate?.getTime() ?? 0;
      const sameBucket =
        a.oldestReceivedDate && b.oldestReceivedDate
          ? this.sameAgeBucket(
              a.oldestReceivedDate,
              b.oldestReceivedDate,
              granularity,
            )
          : dateA === dateB;
      if (!sameBucket) return dateA - dateB; // older bucket wins
      const aCovers = a.available >= quantity;
      const bCovers = b.available >= quantity;
      if (aCovers && bCovers) return a.available - b.available; // tightest whole-unit match
      if (aCovers) return -1;
      if (bCovers) return 1;
      return b.available - a.available; // neither covers fully — biggest partial first
    });

    const chosen = candidates[0];
    const laneLocations = locations.filter(
      (l: any) => laneKeyOf(l) === chosen.laneKey,
    );
    const withStock = laneLocations.filter((l: any) => {
      const bal = byLocation.get(l.id);
      const reserved = reservedByLocation.get(l.id) || 0;
      return bal && bal.balance - reserved > 0;
    });
    // Front-most (shallowest depth) first — the worked example this whole
    // design started from: never send an operator to dig past shallower
    // stock to reach a position "assigned" to a different task.
    withStock.sort((a: any, b: any) => (a.depth ?? 0) - (b.depth ?? 0));
    const front = withStock[0] ?? laneLocations[0];
    if (!front) return null;
    const frontBal = byLocation.get(front.id);
    const frontReserved = reservedByLocation.get(front.id) || 0;
    const frontAvailable = (frontBal?.balance ?? 0) - frontReserved;
    if (frontAvailable <= 0) return null;
    return { locationId: front.id, available: frontAvailable };
  }

  // Called from OutboundOrdersService.allot(), inside its own transaction —
  // real on-hand reserved the moment a gated-in vehicle is confirmed
  // (2026-09-14, confirmed directly: "reserve bin/pallet when gate in +
  // allotement is done," not at order upload). Loops rather than creating
  // one task per line, since one real position can hold less than the
  // line's full remaining demand — see suggestPickPosition()'s own comment
  // for the bug this fixes. Each iteration re-derives pending reservations
  // fresh (via suggestPickPosition's own query), so a task created earlier
  // in THIS same loop is correctly seen as already-reserved by the next
  // iteration, never double-counted. A capped iteration guard (20) is a
  // sane worst-case backstop, not a real limit expected to bind — a real
  // warehouse lane rarely has more than a handful of distinct positions.
  async createTaskForLine(
    tx: any,
    line: { id: string; skuId: string; orderedQty: any; pickedQty: any },
    warehouseId: string,
    toLocationId: string,
  ) {
    let remaining = Number(line.orderedQty) - Number(line.pickedQty);
    if (remaining <= 0) return [];
    const tasks: any[] = [];
    let guard = 0;
    while (remaining > 0 && guard < 20) {
      guard++;
      const position = await this.suggestPickPosition(tx, {
        warehouseId,
        skuId: line.skuId,
        quantity: remaining,
      });
      if (!position) {
        tasks.push(
          await tx.pickTask.create({
            data: {
              orderLineId: line.id,
              skuId: line.skuId,
              fromLocationId: null,
              toLocationId,
              quantity: remaining,
              status: 'NEEDS_SOURCE',
            },
          }),
        );
        remaining = 0;
        break;
      }
      const takeQty = Math.min(remaining, position.available);
      tasks.push(
        await tx.pickTask.create({
          data: {
            orderLineId: line.id,
            skuId: line.skuId,
            fromLocationId: position.locationId,
            toLocationId,
            quantity: takeQty,
            status: 'PENDING',
          },
        }),
      );
      remaining -= takeQty;
    }
    return tasks;
  }

  async findAll(user: AuthUser, warehouseId?: string) {
    const scopedWarehouseIds = OUTBOUND_SCOPED_ROLES.includes(user.role)
      ? await ownWarehouseIds(this.prisma, user.userId)
      : null;
    const warehouseFilter: any = {
      companyId: user.companyId!,
      ...(scopedWarehouseIds ? { id: { in: scopedWarehouseIds } } : {}),
      ...(warehouseId ? { id: warehouseId } : {}),
    };
    const tasks = await this.prisma.pickTask.findMany({
      where: { orderLine: { order: { warehouse: warehouseFilter } } },
      include: { ...TASK_INCLUDE, trips: true },
      orderBy: { createdAt: 'asc' },
    });
    return tasks.map((t: any) => {
      const moved = t.trips
        .filter((tr: any) => tr.status === 'COMPLETED')
        .reduce((s: number, tr: any) => s + Number(tr.quantity), 0);
      return {
        ...t,
        movedQuantity: moved,
        inProgressTrip: t.trips.find((tr: any) => tr.status === 'IN_PROGRESS')
          ? true
          : false,
      };
    });
  }

  // Claiming — no barcode scan, unlike Putaway (there's nothing physical in
  // hand yet before an operator even reaches the source). Confirmed
  // directly: task fulfillment order is FIFO on the queue, independent of
  // which operator arrives — this always grabs the oldest workable PENDING
  // task, same "candidateTasks.find()" shape claimTrip() already uses for
  // Putaway, just without the barcode/SKU narrowing.
  async claimTrip(user: AuthUser, warehouseId?: string) {
    const scopedWarehouseIds = OUTBOUND_SCOPED_ROLES.includes(user.role)
      ? await ownWarehouseIds(this.prisma, user.userId)
      : null;
    const candidateTasks = await this.prisma.pickTask.findMany({
      where: {
        status: 'PENDING',
        orderLine: {
          order: {
            warehouse: {
              companyId: user.companyId!,
              ...(scopedWarehouseIds ? { id: { in: scopedWarehouseIds } } : {}),
              ...(warehouseId ? { id: warehouseId } : {}),
            },
          },
        },
      },
      include: { trips: true },
      orderBy: { createdAt: 'asc' },
    });
    const task = candidateTasks.find((t: any) => {
      const moved = t.trips
        .filter((tr: any) => tr.status === 'COMPLETED')
        .reduce((s: number, tr: any) => s + Number(tr.quantity), 0);
      const hasOpenTrip = t.trips.some(
        (tr: any) => tr.status === 'IN_PROGRESS',
      );
      return moved < Number(t.quantity) && !hasOpenTrip;
    });
    if (!task)
      throw new BadRequestException('No workable picking task right now.');

    const moved = task.trips
      .filter((tr: any) => tr.status === 'COMPLETED')
      .reduce((s: number, tr: any) => s + Number(tr.quantity), 0);
    const remaining = Number(task.quantity) - moved;
    const fromLocation = await this.prisma.location.findUnique({
      where: { id: task.fromLocationId! },
    });
    const assumed = await this.assumedCapacity(fromLocation!.warehouseId);
    const tripQuantity = assumed
      ? Math.min(remaining, assumed.capacity)
      : remaining;

    return this.prisma.pickTrip.create({
      data: {
        taskId: task.id,
        quantity: tripQuantity,
        claimedById: user.userId,
      },
      include: { task: { include: TASK_INCLUDE } },
    });
  }

  private async assumedCapacity(
    warehouseId: string,
  ): Promise<{ capacity: number } | null> {
    const primaryRow =
      await this.prisma.warehouseEquipmentSuitability.findFirst({
        where: { warehouseId, pickingSuitability: 'PRIMARY' },
        include: { equipmentType: true },
      });
    if (!primaryRow) return null;
    return {
      capacity: Number(primaryRow.equipmentType.genericPalletsPerTrip) || 1,
    };
  }

  // Resolves a scanned/typed location against the task's assigned LANE, not
  // just its one stored representative row — the exact match first (the
  // common case), or, for a LIFO-constrained lane, any real active location
  // sharing the same laneKeyOf() key (the real front-most position, only
  // known once actually scanned). No override toggle exists here at all —
  // "he has to pick from that only," confirmed directly — a scan outside
  // the assigned lane always hard-blocks, unlike Putaway's optional
  // company-wide override.
  private async resolveScanWithinLane(fromLocation: any, trimmed: string) {
    const assignedRackName = buildRackName(fromLocation);
    if (
      fromLocation.code.toUpperCase() === trimmed ||
      (assignedRackName && assignedRackName.toUpperCase() === trimmed)
    ) {
      return fromLocation;
    }
    const laneKey = laneKeyOf(fromLocation);
    const candidates = await this.prisma.location.findMany({
      where: { warehouseId: fromLocation.warehouseId, isActive: true },
    });
    const inLane = candidates.filter((l: any) => laneKeyOf(l) === laneKey);
    return (
      inLane.find((l: any) => {
        const rn = buildRackName(l);
        return (
          l.code.toUpperCase() === trimmed ||
          (rn && rn.toUpperCase() === trimmed)
        );
      }) ?? null
    );
  }

  // The two-tier verification rule, confirmed with a worked example
  // (2026-09-14): "if possible we try to pick full pallet of same aging...
  // location + pallet scan should be enough... if its partial pallet
  // picking, then better we scan each unit after we scan the location."
  async completeTrip(tripId: string, body: any, user: AuthUser) {
    const trip = await this.prisma.pickTrip.findUnique({
      where: { id: tripId },
      include: { task: { include: { fromLocation: true, trips: true } } },
    });
    if (!trip) throw new NotFoundException('Trip not found.');
    if (trip.status !== 'IN_PROGRESS')
      throw new BadRequestException('This trip is not awaiting completion.');
    if (trip.claimedById !== user.userId)
      throw new ForbiddenException(
        'Only the operator who claimed this trip can complete it.',
      );

    const task = trip.task as any;
    const fromLocation = task.fromLocation;
    if (!fromLocation)
      throw new BadRequestException('This task has no source location.');
    if (!task.toLocationId)
      throw new BadRequestException(
        'This task has no staging destination — resolve a dock/staging location for the allotted vehicle first.',
      );

    const locationCode =
      body?.locationCode != null ? String(body.locationCode).trim() : '';
    if (!locationCode)
      throw new BadRequestException('A location scan is required.');
    const trimmed = locationCode.toUpperCase();

    const targetLocation = await this.resolveScanWithinLane(
      fromLocation,
      trimmed,
    );
    if (!targetLocation) {
      throw new BadRequestException(
        `"${locationCode}" isn't the assigned pick location.`,
      );
    }

    const palletCode = body?.palletCode ? String(body.palletCode).trim() : '';
    const unitBarcodes: string[] = Array.isArray(body?.unitBarcodes)
      ? body.unitBarcodes.map((b: any) => String(b).trim()).filter(Boolean)
      : [];
    if (!palletCode && unitBarcodes.length === 0) {
      throw new BadRequestException(
        'Scan the pallet (whole-unit pick) or each individual unit (partial pick).',
      );
    }
    if (palletCode && unitBarcodes.length > 0) {
      throw new BadRequestException(
        'Scan either the pallet or individual units, not both.',
      );
    }

    const movedSoFar = (task.trips as any[])
      .filter((t) => t.status === 'COMPLETED')
      .reduce((s, t) => s + Number(t.quantity), 0);
    const remaining = Number(task.quantity) - movedSoFar;

    let actualQuantity: number;
    let palletLoadId: string | undefined;
    let unitBarcodeScanned: string | undefined;

    if (palletCode) {
      const pallet = await this.prisma.pallet.findFirst({
        where: {
          code: { equals: palletCode, mode: 'insensitive' },
          warehouseId: fromLocation.warehouseId,
        },
      });
      if (!pallet)
        throw new BadRequestException(
          `Pallet "${palletCode}" not found in this warehouse.`,
        );
      const loads = await this.prisma.palletLoad.findMany({
        where: { palletId: pallet.id, skuId: task.skuId },
        orderBy: { openedAt: 'desc' },
      });
      if (loads.length === 0)
        throw new BadRequestException(
          `Pallet "${palletCode}" is not registered to this SKU — cannot accept.`,
        );
      const loadIds = loads.map((l: any) => l.id);
      const balance = await this.prisma.stockMovement.aggregate({
        where: {
          locationId: targetLocation.id,
          skuId: task.skuId,
          palletLoadId: { in: loadIds },
        },
        _sum: { quantity: true },
      });
      const onHand = Number(balance._sum.quantity || 0);
      if (onHand <= 0)
        throw new BadRequestException(
          `Pallet "${palletCode}" has no on-hand stock of this SKU at this location.`,
        );
      if (onHand > remaining)
        throw new BadRequestException(
          `Pallet "${palletCode}" holds more (${onHand}) than this trip needs (${remaining}) — this is a partial pick, scan individual units instead.`,
        );
      actualQuantity = onHand;
      palletLoadId = loads[0].id;
    } else {
      const barcodeMatches = await this.prisma.skuBarcode.findMany({
        where: {
          barcode: { in: unitBarcodes },
          sku: { companyId: user.companyId! },
        },
        select: { barcode: true, skuId: true },
      });
      const bySkuBarcode = new Map(
        barcodeMatches.map((b: any) => [b.barcode, b.skuId]),
      );
      for (const bc of unitBarcodes) {
        const skuId = bySkuBarcode.get(bc);
        if (!skuId)
          throw new BadRequestException(`Unrecognized barcode "${bc}".`);
        if (skuId !== task.skuId)
          throw new BadRequestException(
            `Barcode "${bc}" does not match this task's SKU.`,
          );
      }
      if (unitBarcodes.length > remaining)
        throw new BadRequestException(
          `Scanned ${unitBarcodes.length} units, but only ${remaining} are needed for this trip.`,
        );
      actualQuantity = unitBarcodes.length;
      unitBarcodeScanned = unitBarcodes.join(',');
    }

    return this.prisma.$transaction(async (tx) => {
      const updatedTrip = await tx.pickTrip.update({
        where: { id: tripId },
        data: {
          status: 'COMPLETED',
          scannedLocationId: targetLocation.id,
          quantity: actualQuantity,
          palletLoadId,
          unitBarcodeScanned,
          completedAt: new Date(),
        },
      });

      await tx.stockMovement.create({
        data: {
          warehouseId: fromLocation.warehouseId,
          skuId: task.skuId,
          locationId: targetLocation.id,
          quantity: -actualQuantity,
          movementType: 'PICK',
          referenceType: 'PickTrip',
          referenceId: tripId,
          createdById: user.userId,
          palletLoadId,
        },
      });
      await tx.stockMovement.create({
        data: {
          warehouseId: fromLocation.warehouseId,
          skuId: task.skuId,
          locationId: task.toLocationId,
          quantity: actualQuantity,
          movementType: 'PICK_IN',
          referenceType: 'PickTrip',
          referenceId: tripId,
          createdById: user.userId,
          palletLoadId,
        },
      });

      const allTrips = await tx.pickTrip.findMany({
        where: { taskId: task.id },
      });
      const moved = allTrips
        .filter((t: any) => t.status === 'COMPLETED')
        .reduce((s: number, t: any) => s + Number(t.quantity), 0);
      if (moved >= Number(task.quantity)) {
        await tx.pickTask.update({
          where: { id: task.id },
          data: { status: 'COMPLETED' },
        });
      }

      const orderLine = await tx.outboundOrderLine.update({
        where: { id: task.orderLineId },
        data: { pickedQty: { increment: actualQuantity } },
      });
      await this.maybeCompleteOrderPicking(tx, orderLine.orderId);

      return updatedTrip;
    });
  }

  // Flips OutboundOrder.status to PICKED once every line's pickedQty has
  // caught up with its orderedQty — mirrors PutawayTasksService's own
  // maybeCompleteReceiptPutaway(). Does NOT enforce the priority-line
  // completion gate ("SKUs cannot be missed for dispatch") — that's a
  // Dispatch-time check, not a Picking-time one, since a priority line
  // could in principle still be short here and picking simply continues;
  // the gate belongs wherever Dispatch is actually built (not this pass).
  private async maybeCompleteOrderPicking(tx: any, orderId: string) {
    const lines = await tx.outboundOrderLine.findMany({
      where: { orderId },
    });
    const allPicked = lines.every(
      (l: any) => Number(l.pickedQty) >= Number(l.orderedQty),
    );
    if (!allPicked) return;
    const order = await tx.outboundOrder.findUnique({ where: { id: orderId } });
    if (order && order.status !== 'PICKED' && order.status !== 'DISPATCHED') {
      await tx.outboundOrder.update({
        where: { id: orderId },
        data: { status: 'PICKED' },
      });
    }
  }
}
