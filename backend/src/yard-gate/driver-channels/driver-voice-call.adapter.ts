import { Injectable, Logger } from '@nestjs/common';
import { DriverChannelAdapter, DriverSendResult } from './driver-channel-adapter.interface';

// Stub only — no real voice/IVR provider wired up yet (2026-08-27). An
// automated call is a genuinely different capability than SMS/Email/
// WhatsApp (telephony, not messaging) — Exotel was flagged as the research
// lead for this specifically (India-first, widely used for exactly this
// "call the driver automatically" logistics pattern), but nothing is
// chosen/wired up. Whether the call was actually ANSWERED (vs just dialed)
// is an explicit later upgrade — this only ever logs that a call attempt
// was placed, same "Dailed @ what time" scope the client asked for now.
@Injectable()
export class DriverVoiceCallAdapter implements DriverChannelAdapter {
  private readonly logger = new Logger(DriverVoiceCallAdapter.name);

  async send(phone: string, message: string): Promise<DriverSendResult> {
    this.logger.log(`[STUB] Would call driver at ${phone} and play: ${message}`);
    return { success: true };
  }
}
