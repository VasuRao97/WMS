import { Controller, Get, UseGuards } from '@nestjs/common';
import { VehicleTypesService } from './vehicle-types.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('vehicle-types')
@UseGuards(JwtAuthGuard)
export class VehicleTypesController {
  constructor(private readonly vehicleTypesService: VehicleTypesService) {}

  @Get()
  findAll() {
    return this.vehicleTypesService.findAll();
  }
}
