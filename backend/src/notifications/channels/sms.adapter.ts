import { Injectable, Logger } from '@nestjs/common';
import { NotificationChannelAdapter, NotificationRecipient, NotificationSendResult } from './notification-channel.interface';

// Stub only — see EmailAdapter's comment for the general shape. SMS also
// needs India DLT registration before a real send would even work, on top
// of a provider — neither exists yet.
@Injectable()
export class SmsAdapter implements NotificationChannelAdapter {
  private readonly logger = new Logger(SmsAdapter.name);

  async send(recipient: NotificationRecipient, message: string): Promise<NotificationSendResult> {
    if (!recipient.phone) {
      this.logger.warn(`[STUB] Cannot SMS ${recipient.email} — this user has no phone number on file.`);
      return { success: false, error: 'No phone number on file for this user.' };
    }
    this.logger.log(`[STUB] Would SMS ${recipient.phone}: ${message}`);
    return { success: true };
  }
}
