import { Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { DetentionAlertScheduler } from './detention-alert.scheduler';
import { EmailAdapter } from './channels/email.adapter';
import { SmsAdapter } from './channels/sms.adapter';
import { WhatsappAdapter } from './channels/whatsapp.adapter';
import { PrismaService } from '../prisma/prisma.service';

@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService, DetentionAlertScheduler, EmailAdapter, SmsAdapter, WhatsappAdapter, PrismaService],
  // Exported (2026-08-27) so YardGateModule can inject NotificationsService
  // directly for the new "vehicle ready for unloading" event, instead of
  // duplicating the whole send+audit+adapter pipeline — the first real
  // cross-module service reuse in this codebase (every module up to now
  // just queried Prisma directly rather than importing another module's
  // service).
  exports: [NotificationsService],
})
export class NotificationsModule {}
