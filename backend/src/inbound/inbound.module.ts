import { Module } from '@nestjs/common';
import { InboundReceiptsController } from './inbound-receipts.controller';
import { ErpInboundController } from './erp-inbound.controller';
import { InboundReceiptsService } from './inbound-receipts.service';
import { ApiKeyGuard } from '../common/api-key.guard';
import { PrismaService } from '../prisma/prisma.service';
import { PutawayModule } from '../putaway/putaway.module';
import { PalletsModule } from '../pallets/pallets.module';

@Module({
  imports: [PutawayModule, PalletsModule],
  controllers: [InboundReceiptsController, ErpInboundController],
  providers: [InboundReceiptsService, ApiKeyGuard, PrismaService],
})
export class InboundModule {}
