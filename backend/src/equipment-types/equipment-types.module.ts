import { Module } from '@nestjs/common';
import { EquipmentTypesController } from './equipment-types.controller';
import { EquipmentTypesService } from './equipment-types.service';
import { PrismaService } from '../prisma/prisma.service';

@Module({
  controllers: [EquipmentTypesController],
  providers: [EquipmentTypesService, PrismaService],
})
export class EquipmentTypesModule {}
