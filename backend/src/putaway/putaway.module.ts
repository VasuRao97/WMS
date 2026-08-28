import { Module } from '@nestjs/common';
import { PutawayTasksController } from './putaway-tasks.controller';
import { PutawayTasksService } from './putaway-tasks.service';
import { MultiSkuLaneExceptionsController } from './multi-sku-lane-exceptions.controller';
import { MultiSkuLaneExceptionsService } from './multi-sku-lane-exceptions.service';
import { PutawayClaimExpiryScheduler } from './putaway-claim-expiry.scheduler';
import { PrismaService } from '../prisma/prisma.service';

@Module({
  controllers: [PutawayTasksController, MultiSkuLaneExceptionsController],
  providers: [PutawayTasksService, MultiSkuLaneExceptionsService, PutawayClaimExpiryScheduler, PrismaService],
  // Exported so InboundModule/YardGateModule can call into task creation
  // (BATCH-mode receipt-status hook, IMMEDIATE-mode scan hook) — same
  // cross-module service reuse pattern as NotificationsModule.
  exports: [PutawayTasksService],
})
export class PutawayModule {}
