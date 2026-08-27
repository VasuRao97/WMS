import { Module } from '@nestjs/common';
import { InboundReceiptsController } from './inbound-receipts.controller';
import { InboundReceiptsService } from './inbound-receipts.service';
import { PrismaService } from '../prisma/prisma.service';

@Module({
  controllers: [InboundReceiptsController],
  providers: [InboundReceiptsService, PrismaService],
})
export class InboundModule {}
