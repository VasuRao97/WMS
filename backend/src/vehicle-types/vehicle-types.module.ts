import { Module } from '@nestjs/common';
import { VehicleTypesController } from './vehicle-types.controller';
import { VehicleTypesService } from './vehicle-types.service';
import { PrismaService } from '../prisma/prisma.service';

@Module({
  controllers: [VehicleTypesController],
  providers: [VehicleTypesService, PrismaService],
})
export class VehicleTypesModule {}
