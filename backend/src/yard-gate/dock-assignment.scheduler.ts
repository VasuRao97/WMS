import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { DriverNotificationService } from './driver-notification.service';

// The two-stage dock-assignment warning timer (2026-08-27): 15 minutes
// after a dock is assigned, if the vehicle still hasn't been marked Docked
// In, fire a FINAL_WARNING (same channels as the initial notification).
// After that — the client's own scoping — nothing further is automated
// here: actually reassigning the dock to the next vehicle is explicitly
// the future Dock Scheduler's job ("in the dock scheduler this will be
// built in"), not this pass's. "No response" is read as "not yet Docked
// In" (dockedInAt still null) — there's no other signal a driver could
// give back through this system.
const WARNING_THRESHOLD_MINUTES = 15;

@Injectable()
export class DockAssignmentScheduler {
  private readonly logger = new Logger(DockAssignmentScheduler.name);

  constructor(
    private prisma: PrismaService,
    private driverNotifications: DriverNotificationService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async checkDockAssignments() {
    const cutoff = new Date(Date.now() - WARNING_THRESHOLD_MINUTES * 60 * 1000);

    const pending = await this.prisma.vehicleGateEntry.findMany({
      where: {
        gateOutAt: null,
        dockedInAt: null,
        assignedDockNumber: { not: null },
        dockAssignedAt: { lte: cutoff },
      },
      select: {
        id: true,
        assignedDockNumber: true,
        dockAssignedAt: true,
        vehicle: { select: { vehicleNumber: true } },
        driver: { select: { phone: true } },
        driverDockNotifications: { where: { stage: 'FINAL_WARNING' }, select: { createdAt: true }, orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });

    for (const entry of pending) {
      // A FINAL_WARNING from BEFORE the current dockAssignedAt belongs to a
      // previous assignment cycle (the dock was reassigned since) — doesn't
      // count as "already warned" for this one.
      const lastFinalWarning = entry.driverDockNotifications[0]?.createdAt;
      if (lastFinalWarning && lastFinalWarning >= entry.dockAssignedAt!) continue;

      try {
        await this.driverNotifications.sendDockAssignment({
          gateEntryId: entry.id,
          dockNumber: entry.assignedDockNumber!,
          vehicleNumber: entry.vehicle.vehicleNumber,
          driverPhone: entry.driver.phone,
          stage: 'FINAL_WARNING',
        });
      } catch (err) {
        this.logger.error(`Final warning failed for gate entry ${entry.id}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
}
