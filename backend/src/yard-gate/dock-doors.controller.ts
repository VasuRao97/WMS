import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { DockDoorsService } from './dock-doors.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { GATE_YARD_READ_ROLES, MASTER_DATA_WRITE_ROLES } from '../common/tenant.util';

@Controller('dock-doors')
@UseGuards(JwtAuthGuard, RolesGuard)
export class DockDoorsController {
  constructor(private readonly dockDoorsService: DockDoorsService) {}

  @Post()
  @Roles(...MASTER_DATA_WRITE_ROLES)
  create(@Body() body: any, @CurrentUser() user: any) {
    return this.dockDoorsService.create(body, user);
  }

  // Read is open to every operational role (Operator included) — gate/yard
  // staff need to see which doors exist and are available while logging a
  // vehicle in, even though only Admin/Manager can create or edit one.
  @Get()
  @Roles(...GATE_YARD_READ_ROLES)
  findAll(@CurrentUser() user: any) {
    return this.dockDoorsService.findAll(user);
  }

  @Patch(':id')
  @Roles(...MASTER_DATA_WRITE_ROLES)
  update(@Param('id') id: string, @Body() body: any, @CurrentUser() user: any) {
    return this.dockDoorsService.update(id, body, user);
  }

  @Patch(':id/status')
  @Roles(...GATE_YARD_READ_ROLES)
  setStatus(@Param('id') id: string, @Body('status') status: string, @CurrentUser() user: any) {
    return this.dockDoorsService.setStatus(id, status, user);
  }

  @Patch(':id/deactivate')
  @Roles(...MASTER_DATA_WRITE_ROLES)
  deactivate(@Param('id') id: string, @CurrentUser() user: any) {
    return this.dockDoorsService.deactivate(id, user);
  }

  @Patch(':id/reactivate')
  @Roles(...MASTER_DATA_WRITE_ROLES)
  reactivate(@Param('id') id: string, @CurrentUser() user: any) {
    return this.dockDoorsService.reactivate(id, user);
  }

  // Route order matters — @Delete('all') must be declared before
  // @Delete(':id') or Nest matches "all" as an :id param.
  @Delete('all')
  @Roles('COMPANY_ADMIN')
  removeAll(@CurrentUser() user: any) {
    return this.dockDoorsService.removeAll(user);
  }

  @Delete(':id')
  @Roles('COMPANY_ADMIN')
  remove(@Param('id') id: string, @CurrentUser() user: any) {
    return this.dockDoorsService.remove(id, user);
  }
}
