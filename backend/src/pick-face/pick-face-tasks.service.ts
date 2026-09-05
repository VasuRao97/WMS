import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { companyFilter, ownWarehouseIds, PUTAWAY_SCOPED_ROLES } from '../common/tenant.util';
import { buildRackName } from '../common/rack-name.util';

// Pick Face (SPR only) — 2026-09-05, see [[wms-putaway-design]] in memory
// and CLAUDE.md's "Pick Face" section for the full design conversation.
// This is the operator-facing half: scan-driven claim/complete execution,
// mirroring PutawayTasksService's own claimTrip()/completeTrip() shape
// exactly, so operators use the discipline they already know from Putaway.
// PickFaceReplenishmentScheduler is the OTHER half — the daily reslotting
// job that actually decides which tasks get created (REFILL/EVICTION) in
// the first place; this service never creates a task, only executes one
// that already exists.
const TASK_INCLUDE = {
  sku: { select: { id: true, code: true, description: true } },
  fromLocation: { select: { id: true, code: true, storageType: true, rack: true, level: true, depth: true, flankNumber: true } },
  toLocation: { select: { id: true, code: true, storageType: true, rack: true, level: true, depth: true, flankNumber: true } },
} as const;

@Injectable()
export class PickFaceTasksService {
  constructor(private prisma: PrismaService) {}

  async findAll(user: any, warehouseId?: string) {
    const where: any = { warehouse: { ...companyFilter(user) } };
    if (PUTAWAY_SCOPED_ROLES.includes(user.role)) {
      const ids = await ownWarehouseIds(this.prisma, user.userId);
      where.warehouse.id = { in: ids };
    }
    if (warehouseId) where.warehouseId = warehouseId;

    const tasks = await this.prisma.pickFaceTask.findMany({
      where,
      include: { ...TASK_INCLUDE, trips: { orderBy: { claimedAt: 'asc' } } },
      orderBy: { createdAt: 'asc' },
    });
    return tasks.map((t: any) => {
      const movedQuantity = t.trips.filter((tr: any) => tr.status === 'COMPLETED').reduce((s: number, tr: any) => s + Number(tr.quantity), 0);
      const inProgressTrip = t.trips.find((tr: any) => tr.status === 'IN_PROGRESS');
      return { ...t, movedQuantity, inProgressTrip };
    });
  }

  // The source scan — claims one trip. Resolves the barcode to a SKU (same
  // SkuBarcode resolution as Putaway's own claimTrip()), finds the oldest
  // still-workable PENDING task for that SKU the caller can access. Unlike
  // Putaway, there's no equipment-capacity trip-splitting for v1 — one
  // claim always covers whatever's left on the task (a REFILL/EVICTION
  // task is already sized to "one reserve location's worth," never
  // artificially split further).
  async claimTrip(barcode: any, user: any) {
    const trimmed = barcode != null ? String(barcode).trim() : '';
    if (!trimmed) throw new BadRequestException('A barcode is required.');

    const barcodeMatches = await this.prisma.skuBarcode.findMany({
      where: { barcode: trimmed, sku: { companyId: user.companyId } },
      select: { skuId: true },
    });
    if (barcodeMatches.length === 0) throw new BadRequestException('Unrecognized barcode.');
    const skuIds = [...new Set(barcodeMatches.map((b: any) => b.skuId))];

    const scopedWarehouseIds = PUTAWAY_SCOPED_ROLES.includes(user.role) ? await ownWarehouseIds(this.prisma, user.userId) : null;

    const candidateTasks = await this.prisma.pickFaceTask.findMany({
      where: {
        skuId: { in: skuIds },
        status: 'PENDING',
        warehouse: { companyId: user.companyId, ...(scopedWarehouseIds ? { id: { in: scopedWarehouseIds } } : {}) },
      },
      include: { trips: true },
      orderBy: { createdAt: 'asc' },
    });

    const task = candidateTasks.find((t: any) => !t.trips.some((tr: any) => tr.status === 'IN_PROGRESS'));
    if (!task) throw new BadRequestException('No workable pick face task found for this SKU — it may already be claimed or completed.');

    const moved = task.trips.filter((tr: any) => tr.status === 'COMPLETED').reduce((s: number, tr: any) => s + Number(tr.quantity), 0);
    const remaining = Number(task.quantity) - moved;

    return this.prisma.pickFaceTrip.create({
      data: { taskId: task.id, quantity: remaining, claimedById: user.userId, sourceBarcodeScanned: trimmed },
      include: { task: { include: TASK_INCLUDE } },
    });
  }

  // The destination scan — completes the trip. Only a scan matching the
  // task's own toLocationId is ever accepted, exactly like Putaway's
  // completeTrip() — no operator override. Writes the real
  // PICK_FACE_REPLENISH_OUT/IN pair for this trip's quantity.
  async completeTrip(tripId: string, locationCode: any, user: any) {
    const trip = await this.prisma.pickFaceTrip.findUnique({ where: { id: tripId }, include: { task: true } });
    if (!trip) throw new NotFoundException('Trip not found.');
    if (trip.status !== 'IN_PROGRESS') throw new BadRequestException('This trip is not awaiting a location scan.');
    if (trip.claimedById !== user.userId) throw new ForbiddenException('Only the operator who claimed this trip can complete it.');

    const task = trip.task as any;
    const trimmed = locationCode != null ? String(locationCode).trim().toUpperCase() : '';
    const scannedLocation = await this.prisma.location.findUnique({ where: { id: task.toLocationId } });
    const rackName = buildRackName(scannedLocation as any);
    const matches = !!scannedLocation && (scannedLocation.code.toUpperCase() === trimmed || (rackName != null && rackName.toUpperCase() === trimmed));
    if (!matches) {
      throw new BadRequestException(`Wrong location — this must be placed at the assigned bin, not "${trimmed}".`);
    }
    const targetLocation = scannedLocation!;

    return this.prisma.$transaction(async (tx) => {
      const updatedTrip = await tx.pickFaceTrip.update({
        where: { id: tripId },
        data: { status: 'COMPLETED', scannedLocationId: targetLocation.id, completedAt: new Date() },
      });

      await tx.stockMovement.create({
        data: {
          warehouseId: targetLocation.warehouseId,
          skuId: task.skuId,
          locationId: task.fromLocationId,
          quantity: -Number(trip.quantity),
          movementType: 'PICK_FACE_REPLENISH_OUT',
          referenceType: 'PickFaceTrip',
          referenceId: tripId,
          createdById: user.userId,
        },
      });
      await tx.stockMovement.create({
        data: {
          warehouseId: targetLocation.warehouseId,
          skuId: task.skuId,
          locationId: task.toLocationId,
          quantity: Number(trip.quantity),
          movementType: 'PICK_FACE_REPLENISH_IN',
          referenceType: 'PickFaceTrip',
          referenceId: tripId,
          createdById: user.userId,
        },
      });

      const allTrips = await tx.pickFaceTrip.findMany({ where: { taskId: task.id } });
      const moved = allTrips.filter((t: any) => t.status === 'COMPLETED').reduce((s: number, t: any) => s + Number(t.quantity), 0);
      if (moved >= Number(task.quantity)) {
        await tx.pickFaceTask.update({ where: { id: task.id }, data: { status: 'COMPLETED' } });
      }

      return updatedTrip;
    });
  }
}
