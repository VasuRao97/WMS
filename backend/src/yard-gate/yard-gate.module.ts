import { Module } from '@nestjs/common';
import { DockDoorsController } from './dock-doors.controller';
import { DockDoorsService } from './dock-doors.service';
import { GateEntriesController } from './gate-entries.controller';
import { GateEntriesService } from './gate-entries.service';
import { YardController } from './yard.controller';
import { YardService } from './yard.service';
import { PrismaService } from '../prisma/prisma.service';

@Module({
  controllers: [DockDoorsController, GateEntriesController, YardController],
  providers: [DockDoorsService, GateEntriesService, YardService, PrismaService],
})
export class YardGateModule {}
