import { Module } from '@nestjs/common';
import { OutboundOrdersController } from './outbound-orders.controller';
import { OutboundOrdersService } from './outbound-orders.service';
import { PickTasksController } from './pick-tasks.controller';
import { PickTasksService } from './pick-tasks.service';
import { PickAssignmentScheduler } from './pick-assignment.scheduler';
import { NotificationsModule } from '../notifications/notifications.module';
import { PrismaService } from '../prisma/prisma.service';

@Module({
  // PickAssignmentScheduler needs NotificationsService for its alert/
  // escalation pipeline — same cross-module reuse pattern PutawayModule
  // already established (NotificationsModule already `exports:
  // [NotificationsService]`).
  imports: [NotificationsModule],
  controllers: [OutboundOrdersController, PickTasksController],
  providers: [
    OutboundOrdersService,
    PickTasksService,
    PickAssignmentScheduler,
    PrismaService,
  ],
})
export class OutboundModule {}
