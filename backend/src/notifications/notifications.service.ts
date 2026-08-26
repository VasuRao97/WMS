import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EmailAdapter } from './channels/email.adapter';
import { SmsAdapter } from './channels/sms.adapter';
import { WhatsappAdapter } from './channels/whatsapp.adapter';
import { NotificationChannelAdapter } from './channels/notification-channel.interface';

// The send + audit-trail layer (2026-08-27) — every adapter is currently a
// stub (see channels/), so "sending" today just means logging what would go
// out and recording it in NotificationLog. The channel-agnostic shape is
// deliberate: swapping in a real provider later touches an adapter file,
// not this service or its callers (DetentionAlertScheduler today, more
// event sources later).
@Injectable()
export class NotificationsService {
  constructor(
    private prisma: PrismaService,
    private emailAdapter: EmailAdapter,
    private smsAdapter: SmsAdapter,
    private whatsappAdapter: WhatsappAdapter,
  ) {}

  private adapterFor(channel: string): NotificationChannelAdapter {
    if (channel === 'SMS') return this.smsAdapter;
    if (channel === 'WHATSAPP') return this.whatsappAdapter;
    return this.emailAdapter;
  }

  // Which channel(s) an event should go out on for a company — its own
  // enabled CompanyNotificationChannel rows, or EMAIL as a fallback default
  // when it hasn't configured any yet. Keeps the audit trail/escalation
  // timer running even before a real provider is chosen, since every
  // adapter is a stub regardless of which channel is picked right now.
  async channelsFor(companyId: string): Promise<string[]> {
    const enabled = await this.prisma.companyNotificationChannel.findMany({
      where: { companyId, isEnabled: true },
      select: { channel: true },
    });
    return enabled.length ? enabled.map((c) => c.channel) : ['EMAIL'];
  }

  async sendAndLog(params: {
    companyId: string;
    warehouseId?: string;
    eventType: string;
    referenceType?: string;
    referenceId?: string;
    recipientUserId: string;
    channel: string;
    message: string;
  }) {
    const recipient = await this.prisma.user.findUnique({ where: { id: params.recipientUserId }, select: { email: true } });
    const log = await this.prisma.notificationLog.create({
      data: {
        companyId: params.companyId,
        warehouseId: params.warehouseId,
        eventType: params.eventType as any,
        referenceType: params.referenceType,
        referenceId: params.referenceId,
        channel: params.channel as any,
        recipientUserId: params.recipientUserId,
        message: params.message,
        status: 'PENDING',
      },
    });

    const result = await this.adapterFor(params.channel).send({ email: recipient?.email || '' }, params.message);

    return this.prisma.notificationLog.update({
      where: { id: log.id },
      data: {
        status: result.success ? 'SENT' : 'FAILED',
        sentAt: result.success ? new Date() : undefined,
        providerMessageId: result.providerMessageId,
        errorMessage: result.error,
      },
    });
  }

  // Only the actual recipient can acknowledge their own notification — no
  // "acknowledge on someone's behalf" surface, same minimal-permission
  // shape as everywhere else in this codebase. Idempotent: acknowledging an
  // already-acknowledged one just returns it unchanged rather than erroring.
  async acknowledge(id: string, user: any) {
    const log = await this.prisma.notificationLog.findUnique({ where: { id } });
    if (!log) throw new NotFoundException('Notification not found.');
    if (log.recipientUserId !== user.userId) {
      throw new ForbiddenException('You can only acknowledge your own notifications.');
    }
    if (log.acknowledgedAt) return log;
    return this.prisma.notificationLog.update({ where: { id }, data: { acknowledgedAt: new Date() } });
  }

  async listMine(user: any, unacknowledgedOnly?: boolean) {
    return this.prisma.notificationLog.findMany({
      where: { recipientUserId: user.userId, ...(unacknowledgedOnly ? { acknowledgedAt: null } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }
}
