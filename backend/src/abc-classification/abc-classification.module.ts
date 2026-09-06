import { Module } from '@nestjs/common';
import { AbcClassificationController } from './abc-classification.controller';
import { AbcClassificationService } from './abc-classification.service';
import { AbcClassificationScheduler } from './abc-classification.scheduler';
import { PrismaService } from '../prisma/prisma.service';

@Module({
  controllers: [AbcClassificationController],
  providers: [AbcClassificationService, AbcClassificationScheduler, PrismaService],
})
export class AbcClassificationModule {}
