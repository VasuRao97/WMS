import { Module } from '@nestjs/common';
import { DockDoorsController } from './dock-doors.controller';
import { DockDoorsService } from './dock-doors.service';
import { GateEntriesController } from './gate-entries.controller';
import { GateEntriesService } from './gate-entries.service';
import { YardController } from './yard.controller';
import { YardService } from './yard.service';
import { PrismaService } from '../prisma/prisma.service';
import { DriverNotificationService } from './driver-notification.service';
import { DriverSmsAdapter } from './driver-channels/driver-sms.adapter';
import { DriverVoiceCallAdapter } from './driver-channels/driver-voice-call.adapter';
import { DockAssignmentScheduler } from './dock-assignment.scheduler';

@Module({
  controllers: [DockDoorsController, GateEntriesController, YardController],
  providers: [
    DockDoorsService,
    GateEntriesService,
    YardService,
    PrismaService,
    DriverNotificationService,
    DriverSmsAdapter,
    DriverVoiceCallAdapter,
    DockAssignmentScheduler,
  ],
})
export class YardGateModule {}
