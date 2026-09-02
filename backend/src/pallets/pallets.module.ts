import { Module } from '@nestjs/common';
import { PalletsController } from './pallets.controller';
import { PalletsService } from './pallets.service';
import { PrismaService } from '../prisma/prisma.service';
import { PutawayModule } from '../putaway/putaway.module';

@Module({
  imports: [PutawayModule],
  controllers: [PalletsController],
  providers: [PalletsService, PrismaService],
  // Exported so YardGateModule (GateEntriesService.scan()) and InboundModule
  // (InboundReceiptsService.approveScan()) can call into the marrying
  // mechanism directly — same cross-module service reuse pattern as
  // PutawayModule/NotificationsModule.
  exports: [PalletsService],
})
export class PalletsModule {}
