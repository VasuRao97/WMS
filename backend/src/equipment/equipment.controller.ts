import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { EquipmentService } from './equipment.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { EQUIPMENT_READ_ROLES, MASTER_DATA_WRITE_ROLES } from '../common/tenant.util';

@Controller('equipment')
@UseGuards(JwtAuthGuard, RolesGuard)
export class EquipmentController {
  constructor(private readonly equipmentService: EquipmentService) {}

  @Post()
  @Roles(...MASTER_DATA_WRITE_ROLES)
  create(@Body() body: any, @CurrentUser() user: any) {
    return this.equipmentService.create(body, user);
  }

  // ?warehouseId=&activity=PUTAWAY|PICKING|LOADING|UNLOADING|CONSOLIDATION|
  // INVENTORY_CHECK (2026-08-28) — "so we get all the mhe's in warehouse
  // instantly": both optional, narrow the plain master-page list down to
  // active units usable (Primary/Secondary) for one activity in one
  // warehouse, Primary-ranked first. See EquipmentService.findAll's comment.
  @Get()
  @Roles(...EQUIPMENT_READ_ROLES)
  findAll(@CurrentUser() user: any, @Query('warehouseId') warehouseId?: string, @Query('activity') activity?: string) {
    return this.equipmentService.findAll(user, warehouseId, activity);
  }

  // The real "input" surface for the activity matrix (2026-08-28, corrected
  // same day — "it should be warehouse wise! you can give dropdown for wh
  // code and give matrix"). Route order matters, same lesson as
  // Delete('all')/Delete(':id') — 'suitability-matrix' must be declared
  // before ':id' or Nest matches it as an :id param.
  @Get('suitability-matrix')
  @Roles(...EQUIPMENT_READ_ROLES)
  getSuitabilityMatrix(@CurrentUser() user: any, @Query('warehouseId') warehouseId: string) {
    return this.equipmentService.getSuitabilityMatrix(user, warehouseId);
  }

  @Patch('suitability-matrix')
  @Roles(...MASTER_DATA_WRITE_ROLES)
  updateSuitabilityMatrix(@CurrentUser() user: any, @Body() body: { warehouseId: string; rows: any[] }) {
    return this.equipmentService.updateSuitabilityMatrix(user, body.warehouseId, body.rows);
  }

  @Patch(':id')
  @Roles(...MASTER_DATA_WRITE_ROLES)
  update(@Param('id') id: string, @Body() body: any, @CurrentUser() user: any) {
    return this.equipmentService.update(id, body, user);
  }

  @Patch(':id/deactivate')
  @Roles(...MASTER_DATA_WRITE_ROLES)
  deactivate(@Param('id') id: string, @CurrentUser() user: any) {
    return this.equipmentService.deactivate(id, user);
  }

  @Patch(':id/reactivate')
  @Roles(...MASTER_DATA_WRITE_ROLES)
  reactivate(@Param('id') id: string, @CurrentUser() user: any) {
    return this.equipmentService.reactivate(id, user);
  }

  // Route order matters — @Delete('all') must be declared before
  // @Delete(':id') or Nest matches "all" as an :id param.
  @Delete('all')
  @Roles('COMPANY_ADMIN')
  removeAll(@CurrentUser() user: any) {
    return this.equipmentService.removeAll(user);
  }

  @Delete(':id')
  @Roles('COMPANY_ADMIN')
  remove(@Param('id') id: string, @CurrentUser() user: any) {
    return this.equipmentService.remove(id, user);
  }
}
