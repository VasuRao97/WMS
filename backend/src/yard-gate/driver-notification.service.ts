import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DriverSmsAdapter } from './driver-channels/driver-sms.adapter';
import { DriverVoiceCallAdapter } from './driver-channels/driver-voice-call.adapter';

// Fires the SMS + automated voice call to a Driver once a dock is assigned
// (2026-08-27) and logs both attempts as DriverDockNotification rows — the
// "proof we called the driver" the client asked for. Sends on BOTH channels
// every time (SMS and a voice call), not one-or-the-other — the client's
// own framing was "sms / automated call," not a choice between them.
@Injectable()
export class DriverNotificationService {
  private readonly logger = new Logger(DriverNotificationService.name);

  constructor(
    private prisma: PrismaService,
    private smsAdapter: DriverSmsAdapter,
    private voiceCallAdapter: DriverVoiceCallAdapter,
  ) {}

  private buildMessage(stage: 'INITIAL' | 'FINAL_WARNING', dockNumber: string, vehicleNumber: string): string {
    if (stage === 'INITIAL') {
      return `Dock ${dockNumber} is assigned to your vehicle ${vehicleNumber}. Please keep ready for loading in the next 15 minutes, or the slot will be given to the next driver.`;
    }
    return `FINAL WARNING: Dock ${dockNumber} is still waiting for your vehicle ${vehicleNumber}. Report immediately — this slot may be given to the next driver shortly.`;
  }

  // gateEntryId/vehicleNumber/dockNumber are passed in rather than
  // re-fetched — callers (GateEntriesService.assignDock, the scheduler
  // below) already have the row loaded.
  async sendDockAssignment(params: {
    gateEntryId: string;
    dockNumber: string;
    vehicleNumber: string;
    driverPhone: string | null;
    stage: 'INITIAL' | 'FINAL_WARNING';
  }) {
    const message = this.buildMessage(params.stage, params.dockNumber, params.vehicleNumber);

    if (!params.driverPhone) {
      // No phone on file for this driver — still log it as a FAILED attempt
      // per channel, same "record the gap, don't just silently skip it"
      // instinct as the SMS/WhatsApp adapters' own no-phone handling.
      this.logger.warn(`Cannot notify driver for gate entry ${params.gateEntryId} — no phone number on file.`);
      for (const channel of ['SMS', 'VOICE_CALL'] as const) {
        await this.prisma.driverDockNotification.create({
          data: {
            gateEntryId: params.gateEntryId,
            stage: params.stage,
            channel,
            driverPhone: '',
            message,
            status: 'FAILED',
            errorMessage: 'No phone number on file for this driver.',
          },
        });
      }
      return;
    }

    for (const [channel, adapter] of [
      ['SMS', this.smsAdapter],
      ['VOICE_CALL', this.voiceCallAdapter],
    ] as const) {
      const log = await this.prisma.driverDockNotification.create({
        data: {
          gateEntryId: params.gateEntryId,
          stage: params.stage,
          channel,
          driverPhone: params.driverPhone,
          message,
          status: 'PENDING',
        },
      });
      const result = await adapter.send(params.driverPhone, message);
      await this.prisma.driverDockNotification.update({
        where: { id: log.id },
        data: {
          status: result.success ? 'SENT' : 'FAILED',
          sentAt: result.success ? new Date() : undefined,
          errorMessage: result.error,
        },
      });
    }
  }
}
