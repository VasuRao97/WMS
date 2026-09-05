import { Module } from '@nestjs/common';
import { SimulationController } from './simulation.controller';
import { SimulationService } from './simulation.service';
import { PutawayModule } from '../putaway/putaway.module';
import { PrismaService } from '../prisma/prisma.service';

@Module({
  // PutawayModule exports PutawayTasksService so the simulation can call
  // suggestBin() directly — the real algorithm, never a reimplementation.
  imports: [PutawayModule],
  controllers: [SimulationController],
  providers: [SimulationService, PrismaService],
})
export class SimulationModule {}
