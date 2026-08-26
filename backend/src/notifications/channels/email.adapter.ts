import { Injectable, Logger } from '@nestjs/common';
import { NotificationChannelAdapter, NotificationRecipient, NotificationSendResult } from './notification-channel.interface';

// Stub only — no real email provider is wired up yet (2026-08-27). Logs
// what WOULD be sent so the rest of the pipeline (audit trail, escalation,
// acknowledgment) can be built and exercised end-to-end before a real
// provider is chosen. Swap the body of send() for a real SMTP/SES/MSG91
// call later — nothing else in this module needs to change.
@Injectable()
export class EmailAdapter implements NotificationChannelAdapter {
  private readonly logger = new Logger(EmailAdapter.name);

  async send(recipient: NotificationRecipient, message: string): Promise<NotificationSendResult> {
    this.logger.log(`[STUB] Would email ${recipient.email}: ${message}`);
    return { success: true };
  }
}
