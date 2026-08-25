import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { VehiclesService } from './vehicles.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { GATE_YARD_OPERATE_ROLES, GATE_YARD_READ_ROLES } from '../common/tenant.util';

@Controller('vehicles')
@UseGuards(JwtAuthGuard, RolesGuard)
export class VehiclesController {
  constructor(private readonly vehiclesService: VehiclesService) {}

  @Post()
  @Roles(...GATE_YARD_OPERATE_ROLES)
  create(@Body() body: any, @CurrentUser() user: any) {
    return this.vehiclesService.create(body, user);
  }

  @Get()
  @Roles(...GATE_YARD_READ_ROLES)
  findAll(@CurrentUser() user: any) {
    return this.vehiclesService.findAll(user);
  }

  @Patch(':id')
  @Roles(...GATE_YARD_OPERATE_ROLES)
  update(@Param('id') id: string, @Body() body: any, @CurrentUser() user: any) {
    return this.vehiclesService.update(id, body, user);
  }

  @Patch(':id/deactivate')
  @Roles(...GATE_YARD_OPERATE_ROLES)
  deactivate(@Param('id') id: string, @CurrentUser() user: any) {
    return this.vehiclesService.deactivate(id, user);
  }

  @Patch(':id/reactivate')
  @Roles(...GATE_YARD_OPERATE_ROLES)
  reactivate(@Param('id') id: string, @CurrentUser() user: any) {
    return this.vehiclesService.reactivate(id, user);
  }

  @Delete('all')
  @Roles('COMPANY_ADMIN')
  removeAll(@CurrentUser() user: any) {
    return this.vehiclesService.removeAll(user);
  }

  @Delete(':id')
  @Roles('COMPANY_ADMIN')
  remove(@Param('id') id: string, @CurrentUser() user: any) {
    return this.vehiclesService.remove(id, user);
  }
}
