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
})
export class NotificationsModule {}
