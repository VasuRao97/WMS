import { Body, Controller, Delete, Get, Param, Patch, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import * as XLSX from 'xlsx';
import { DriversService } from './drivers.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { GATE_YARD_OPERATE_ROLES, GATE_YARD_READ_ROLES } from '../common/tenant.util';

@Controller('drivers')
@UseGuards(JwtAuthGuard, RolesGuard)
export class DriversController {
  constructor(private readonly driversService: DriversService) {}

  @Post()
  @Roles(...GATE_YARD_OPERATE_ROLES)
  create(@Body() body: any, @CurrentUser() user: any) {
    return this.driversService.create(body, user);
  }

  @Get()
  @Roles(...GATE_YARD_READ_ROLES)
  findAll(@CurrentUser() user: any) {
    return this.driversService.findAll(user);
  }

  @Get('export')
  @Roles(...GATE_YARD_READ_ROLES)
  async export(@Res() res: Response, @CurrentUser() user: any) {
    const rows = await this.driversService.exportRows(user);
    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Driver Master');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': 'attachment; filename="Driver_Master_Export.xlsx"',
    });
    res.send(buffer);
  }

  @Patch(':id')
  @Roles(...GATE_YARD_OPERATE_ROLES)
  update(@Param('id') id: string, @Body() body: any, @CurrentUser() user: any) {
    return this.driversService.update(id, body, user);
  }

  @Patch(':id/deactivate')
  @Roles(...GATE_YARD_OPERATE_ROLES)
  deactivate(@Param('id') id: string, @CurrentUser() user: any) {
    return this.driversService.deactivate(id, user);
  }

  @Patch(':id/reactivate')
  @Roles(...GATE_YARD_OPERATE_ROLES)
  reactivate(@Param('id') id: string, @CurrentUser() user: any) {
    return this.driversService.reactivate(id, user);
  }

  @Delete('all')
  @Roles('COMPANY_ADMIN')
  removeAll(@CurrentUser() user: any) {
    return this.driversService.removeAll(user);
  }

  @Delete(':id')
  @Roles('COMPANY_ADMIN')
  remove(@Param('id') id: string, @CurrentUser() user: any) {
    return this.driversService.remove(id, user);
  }
}
