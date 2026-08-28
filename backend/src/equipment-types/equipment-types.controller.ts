import { Controller, Get, UseGuards } from '@nestjs/common';
import { EquipmentTypesService } from './equipment-types.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('equipment-types')
@UseGuards(JwtAuthGuard)
export class EquipmentTypesController {
  constructor(private readonly equipmentTypesService: EquipmentTypesService) {}

  @Get()
  findAll() {
    return this.equipmentTypesService.findAll();
  }
}
