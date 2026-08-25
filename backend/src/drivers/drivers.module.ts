import { Module } from '@nestjs/common';
import { DriversController } from './drivers.controller';
import { DriversService } from './drivers.service';
import { PrismaService } from '../prisma/prisma.service';

@Module({
  controllers: [DriversController],
  providers: [DriversService, PrismaService],
})
export class DriversModule {}
