import { Module } from '@nestjs/common';
import { OutboundOrdersController } from './outbound-orders.controller';
import { OutboundOrdersService } from './outbound-orders.service';
import { PickTasksController } from './pick-tasks.controller';
import { PickTasksService } from './pick-tasks.service';
import { PrismaService } from '../prisma/prisma.service';

@Module({
  controllers: [OutboundOrdersController, PickTasksController],
  providers: [OutboundOrdersService, PickTasksService, PrismaService],
})
export class OutboundModule {}
