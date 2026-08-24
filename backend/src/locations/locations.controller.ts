import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { LocationsService } from './locations.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { MASTER_DATA_READ_ROLES, MASTER_DATA_WRITE_ROLES } from '../common/tenant.util';

@Controller('locations')
@UseGuards(JwtAuthGuard, RolesGuard)
export class LocationsController {
  constructor(private readonly locationsService: LocationsService) {}

  @Post()
  @Roles(...MASTER_DATA_WRITE_ROLES)
  create(@Body() body: any, @CurrentUser() user: any) {
    return this.locationsService.create(body, user);
  }

  @Get()
  @Roles(...MASTER_DATA_READ_ROLES)
  findAll(@CurrentUser() user: any) {
    return this.locationsService.findAll(user);
  }

  @Patch(':id')
  @Roles(...MASTER_DATA_WRITE_ROLES)
  update(@Param('id') id: string, @Body() body: any, @CurrentUser() user: any) {
    return this.locationsService.update(id, body, user);
  }

  @Patch(':id/deactivate')
  @Roles(...MASTER_DATA_WRITE_ROLES)
  deactivate(@Param('id') id: string, @CurrentUser() user: any) {
    return this.locationsService.deactivate(id, user);
  }

  @Patch(':id/reactivate')
  @Roles(...MASTER_DATA_WRITE_ROLES)
  reactivate(@Param('id') id: string, @CurrentUser() user: any) {
    return this.locationsService.reactivate(id, user);
  }

  // Route order matters — @Delete('all') must be declared before
  // @Delete(':id') or Nest matches "all" as an :id param.
  @Delete('all')
  @Roles('COMPANY_ADMIN')
  removeAll(@CurrentUser() user: any) {
    return this.locationsService.removeAll(user);
  }
}
