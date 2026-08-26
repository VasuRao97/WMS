import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from './notifications.service';

// Periodic detention-threshold check (2026-08-27) — the first thing in this
// codebase that runs on a timer rather than in response to a request.
// Every 5 minutes: find companies that have configured
// Company.detentionAlertHours, check their open (not yet gated out)
// VehicleGateEntry rows for ones that have crossed it, and alert each
// assigned WAREHOUSE_MANAGER who hasn't already been alerted for that same
// entry. A second pass checks whether an already-sent, unacknowledged alert
// has aged past Company.detentionEscalationHours and, if so, escalates to
// the company's COMPANY_ADMIN(s).
//
// Known gap, flagged not solved: a warehouse with no WAREHOUSE_MANAGER
// assigned never gets an alert logged at all, so escalation (which is keyed
// off an existing unacknowledged alert) never fires either — there's
// nobody to escalate FROM. Revisit once this proves out in practice.
@Injectable()
export class DetentionAlertScheduler {
  private readonly logger = new Logger(DetentionAlertScheduler.name);

  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async checkDetention() {
    const companies = await this.prisma.company.findMany({
      where: { detentionAlertHours: { not: null } },
      select: { id: true, detentionAlertHours: true, detentionEscalationHours: true },
    });

    for (const company of companies) {
      try {
        await this.checkCompany(company);
      } catch (err) {
        this.logger.error(`Detention check failed for company ${company.id}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  private async checkCompany(company: { id: string; detentionAlertHours: number | null; detentionEscalationHours: number | null }) {
    const openEntries = await this.prisma.vehicleGateEntry.findMany({
      where: { gateOutAt: null, warehouse: { companyId: company.id } },
      select: { id: true, warehouseId: true, gateInAt: true, vehicle: { select: { vehicleNumber: true } } },
    });

    const now = Date.now();
    const alertHours = company.detentionAlertHours!;

    for (const entry of openEntries) {
      const hoursOpen = (now - entry.gateInAt.getTime()) / (1000 * 60 * 60);
      if (hoursOpen < alertHours) continue;

      const existingAlerts = await this.prisma.notificationLog.findMany({
        where: { referenceType: 'VehicleGateEntry', referenceId: entry.id, eventType: 'DETENTION_ALERT' },
      });

      if (existingAlerts.length === 0) {
        await this.fireAlert(company.id, entry);
        continue;
      }

      if (company.detentionEscalationHours == null) continue;
      const alreadyHandled = existingAlerts.some((a) => a.acknowledgedAt || a.escalatedAt);
      if (alreadyHandled) continue;

      const oldest = existingAlerts.reduce((min, a) => {
        const t = a.sentAt ?? a.createdAt;
        return t < min ? t : min;
      }, existingAlerts[0].sentAt ?? existingAlerts[0].createdAt);
      const hoursSinceAlert = (now - oldest.getTime()) / (1000 * 60 * 60);
      if (hoursSinceAlert >= company.detentionEscalationHours) {
        await this.escalate(company.id, entry, existingAlerts.map((a) => a.id));
      }
    }
  }

  private async fireAlert(companyId: string, entry: { id: string; warehouseId: string; vehicle: { vehicleNumber: string } }) {
    const managers = await this.prisma.user.findMany({
      where: { companyId, role: 'WAREHOUSE_MANAGER', isActive: true, assignedWarehouses: { some: { id: entry.warehouseId } } },
      select: { id: true },
    });
    if (managers.length === 0) return; // known gap — see class comment

    const channels = await this.notifications.channelsFor(companyId);
    const message = `Vehicle ${entry.vehicle.vehicleNumber} has been on-site past the detention alert threshold.`;
    for (const manager of managers) {
      for (const channel of channels) {
        await this.notifications.sendAndLog({
          companyId,
          warehouseId: entry.warehouseId,
          eventType: 'DETENTION_ALERT',
          referenceType: 'VehicleGateEntry',
          referenceId: entry.id,
          recipientUserId: manager.id,
          channel,
          message,
        });
      }
    }
  }

  private async escalate(companyId: string, entry: { id: string; warehouseId: string; vehicle: { vehicleNumber: string } }, existingAlertIds: string[]) {
    const admins = await this.prisma.user.findMany({
      where: { companyId, role: 'COMPANY_ADMIN', isActive: true },
      select: { id: true },
    });
    if (admins.length === 0) return;

    const channels = await this.notifications.channelsFor(companyId);
    const message = `ESCALATION: the detention alert for vehicle ${entry.vehicle.vehicleNumber} was not acknowledged in time.`;
    for (const admin of admins) {
      for (const channel of channels) {
        await this.notifications.sendAndLog({
          companyId,
          warehouseId: entry.warehouseId,
          eventType: 'DETENTION_ALERT',
          referenceType: 'VehicleGateEntry',
          referenceId: entry.id,
          recipientUserId: admin.id,
          channel,
          message,
        });
      }
    }

    await this.prisma.notificationLog.updateMany({
      where: { id: { in: existingAlertIds } },
      data: { escalatedAt: new Date(), escalatedToId: admins[0].id },
    });
  }
}
