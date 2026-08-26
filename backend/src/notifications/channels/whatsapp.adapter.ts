import { Injectable, Logger } from '@nestjs/common';
import { NotificationChannelAdapter, NotificationRecipient, NotificationSendResult } from './notification-channel.interface';

// Stub only — see EmailAdapter's comment for the general shape. A real send
// also needs a Meta-approved message template (business-initiated WhatsApp
// messages can't be freeform text) on top of a provider — neither exists
// yet. MSG91 was the research recommendation for a provider (2026-08-27,
// see CLAUDE.md) but nothing has been chosen/wired up.
@Injectable()
export class WhatsappAdapter implements NotificationChannelAdapter {
  private readonly logger = new Logger(WhatsappAdapter.name);

  async send(recipient: NotificationRecipient, message: string): Promise<NotificationSendResult> {
    if (!recipient.phone) {
      this.logger.warn(`[STUB] Cannot WhatsApp ${recipient.email} — this user has no phone number on file.`);
      return { success: false, error: 'No phone number on file for this user.' };
    }
    this.logger.log(`[STUB] Would WhatsApp ${recipient.phone}: ${message}`);
    return { success: true };
  }
}
