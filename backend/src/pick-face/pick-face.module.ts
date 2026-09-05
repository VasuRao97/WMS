import { Module } from '@nestjs/common';
import { PickFaceTasksController } from './pick-face-tasks.controller';
import { PickFaceTasksService } from './pick-face-tasks.service';
import { PickFaceReplenishmentScheduler } from './pick-face-replenishment.scheduler';
import { PutawayModule } from '../putaway/putaway.module';
import { PrismaService } from '../prisma/prisma.service';

@Module({
  // PutawayModule exported PutawayTasksService so PickFaceReplenishmentScheduler
  // can reuse suggestBin() directly for eviction destinations, rather than a
  // second copy of the ACTUAL_STORAGE bin-suggestion logic.
  imports: [PutawayModule],
  controllers: [PickFaceTasksController],
  providers: [PickFaceTasksService, PickFaceReplenishmentScheduler, PrismaService],
})
export class PickFaceModule {}
