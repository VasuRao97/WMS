import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PutawayTasksService } from './putaway-tasks.service';

// Putaway operator-assignment fairness (2026-09-02, see
// [[wms-putaway-design]] in memory) — every minute (tighter than
// DetentionAlertScheduler's 5-minute cadence, since the grace period here
// is measured in minutes, not hours), for every warehouse with real
// pending Putaway work waiting: find the longest-free, MHE-capable
// operator (PutawayTasksService.computeRecommendedOperator — the exact
// same ranking the Putaway page itself shows), and if they've been free
// past Company.putawayAssignmentGraceMinutes with no new trip claimed,
// alert the Warehouse Supervisor. If their NEXT turn also lapses by the
// same duration, escalate to the Warehouse Manager — mirrors
// DetentionAlertScheduler's alert-then-escalate shape exactly.
//
// Deliberately does nothing when there's no pending work at all — an idle
// operator isn't a problem to flag if there's nothing for them to do.
@Injectable()
export class PutawayAssignmentScheduler {
  private readonly logger = new Logger(PutawayAssignmentScheduler.name);

  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
    private putawayTasks: PutawayTasksService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async checkAssignments() {
    const companies = await this.prisma.company.findMany({ select: { id: true, putawayAssignmentGraceMinutes: true } });
    for (const company of companies) {
      try {
        await this.checkCompany(company);
      } catch (err) {
        this.logger.error(`Putaway assignment check failed for company ${company.id}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  private async checkCompany(company: { id: string; putawayAssignmentGraceMinutes: number }) {
    const warehouses = await this.prisma.warehouse.findMany({ where: { companyId: company.id }, select: { id: true } });
    for (const warehouse of warehouses) {
      await this.checkWarehouse(company, warehouse.id);
    }
  }

  private async checkWarehouse(company: { id: string; putawayAssignmentGraceMinutes: number }, warehouseId: string) {
    const pendingExists = await this.prisma.putawayTask.findFirst({
      where: { status: 'PENDING', openForAccumulation: false, receiptLine: { receipt: { warehouseId } } },
      select: { id: true },
    });
    if (!pendingExists) return;

    const top = await this.putawayTasks.computeRecommendedOperator(warehouseId);
    if (!top) return;

    const minutesFree = (Date.now() - top.effectiveRankTime.getTime()) / 60000;
    if (minutesFree < company.putawayAssignmentGraceMinutes) return;

    const existingAlert = await this.prisma.notificationLog.findFirst({
      where: { eventType: 'PUTAWAY_OPERATOR_MISSED_TURN', referenceType: 'User', referenceId: top.id, createdAt: { gte: top.effectiveRankTime } },
      orderBy: { createdAt: 'desc' },
    });

    if (!existingAlert) {
      await this.fireAlert(company.id, warehouseId, top);
      return;
    }
    if (existingAlert.escalatedAt) return; // already escalated for this exact miss window — don't repeat
    const minutesSinceAlert = (Date.now() - (existingAlert.sentAt ?? existingAlert.createdAt).getTime()) / 60000;
    if (minutesSinceAlert >= company.putawayAssignmentGraceMinutes) {
      await this.escalate(company.id, warehouseId, top, existingAlert.id);
    }
  }

  private async fireAlert(companyId: string, warehouseId: string, top: { id: string; name: string }) {
    const supervisors = await this.prisma.user.findMany({
      where: { companyId, role: 'WAREHOUSE_SUPERVISOR', isActive: true, assignedWarehouses: { some: { id: warehouseId } } },
      select: { id: true },
    });
    if (supervisors.length === 0) return; // known gap, same shape as DetentionAlertScheduler's — nobody to alert

    const channels = await this.notifications.channelsFor(companyId);
    const message = `${top.name} has been free past the Putaway assignment grace period without picking up the next task.`;
    for (const supervisor of supervisors) {
      for (const channel of channels) {
        await this.notifications.sendAndLog({
          companyId,
          warehouseId,
          eventType: 'PUTAWAY_OPERATOR_MISSED_TURN',
          referenceType: 'User',
          referenceId: top.id,
          recipientUserId: supervisor.id,
          channel,
          message,
        });
      }
    }
  }

  private async escalate(companyId: string, warehouseId: string, top: { id: string; name: string }, existingAlertId: string) {
    const managers = await this.prisma.user.findMany({
      where: { companyId, role: 'WAREHOUSE_MANAGER', isActive: true, assignedWarehouses: { some: { id: warehouseId } } },
      select: { id: true },
    });
    if (managers.length === 0) return;

    const channels = await this.notifications.channelsFor(companyId);
    const message = `ESCALATION: ${top.name} still hasn't picked up their next Putaway task after the Supervisor alert.`;
    for (const manager of managers) {
      for (const channel of channels) {
        await this.notifications.sendAndLog({
          companyId,
          warehouseId,
          eventType: 'PUTAWAY_OPERATOR_MISSED_TURN',
          referenceType: 'User',
          referenceId: top.id,
          recipientUserId: manager.id,
          channel,
          message,
        });
      }
    }

    await this.prisma.notificationLog.update({ where: { id: existingAlertId }, data: { escalatedAt: new Date(), escalatedToId: managers[0].id } });
  }
}
