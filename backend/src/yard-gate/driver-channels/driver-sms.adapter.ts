import { Injectable, Logger } from '@nestjs/common';
import { DriverChannelAdapter, DriverSendResult } from './driver-channel-adapter.interface';

// Stub only — no real SMS provider wired up yet (2026-08-27), same "logs
// what would be sent" pattern as notifications/channels/EmailAdapter. Also
// needs India DLT registration before a real send would work, on top of a
// provider — neither exists yet.
@Injectable()
export class DriverSmsAdapter implements DriverChannelAdapter {
  private readonly logger = new Logger(DriverSmsAdapter.name);

  async send(phone: string, message: string): Promise<DriverSendResult> {
    this.logger.log(`[STUB] Would SMS driver at ${phone}: ${message}`);
    return { success: true };
  }
}
