import { Module } from '@nestjs/common';
import { PutawayTasksController } from './putaway-tasks.controller';
import { PutawayTasksService } from './putaway-tasks.service';
import { MultiSkuLaneExceptionsController } from './multi-sku-lane-exceptions.controller';
import { MultiSkuLaneExceptionsService } from './multi-sku-lane-exceptions.service';
import { PutawayClaimExpiryScheduler } from './putaway-claim-expiry.scheduler';
import { PutawayAssignmentScheduler } from './putaway-assignment.scheduler';
import { NotificationsModule } from '../notifications/notifications.module';
import { PrismaService } from '../prisma/prisma.service';

@Module({
  imports: [NotificationsModule],
  controllers: [PutawayTasksController, MultiSkuLaneExceptionsController],
  providers: [PutawayTasksService, MultiSkuLaneExceptionsService, PutawayClaimExpiryScheduler, PutawayAssignmentScheduler, PrismaService],
  // Exported so InboundModule/YardGateModule can call into task creation
  // (BATCH-mode receipt-status hook, IMMEDIATE-mode scan hook) — same
  // cross-module service reuse pattern as NotificationsModule.
  exports: [PutawayTasksService],
})
export class PutawayModule {}
