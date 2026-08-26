import { Body, Controller, Get, Param, Patch, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import * as XLSX from 'xlsx';
import { GateEntriesService } from './gate-entries.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { GATE_YARD_OPERATE_ROLES, GATE_YARD_READ_ROLES } from '../common/tenant.util';

@Controller('gate-entries')
@UseGuards(JwtAuthGuard, RolesGuard)
export class GateEntriesController {
  constructor(private readonly gateEntriesService: GateEntriesService) {}

  // Gate In — every operational role can log a vehicle in, Operator included
  // (this is a security/gate task, not a master-data one).
  @Post()
  @Roles(...GATE_YARD_OPERATE_ROLES)
  create(@Body() body: any, @CurrentUser() user: any) {
    return this.gateEntriesService.create(body, user);
  }

  @Get()
  @Roles(...GATE_YARD_OPERATE_ROLES)
  findAll(@CurrentUser() user: any) {
    return this.gateEntriesService.findAll(user);
  }

  // A raw dump, not date-filtered server-side — see GateEntriesService.
  // exportRows's comment. Route declared before any :id-style route so Nest
  // doesn't misroute "export" as a param.
  @Get('export')
  @Roles(...GATE_YARD_READ_ROLES)
  async export(@Res() res: Response, @CurrentUser() user: any) {
    const rows = await this.gateEntriesService.exportRows(user);
    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Gate Entries');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': 'attachment; filename="Gate_Entries_Export.xlsx"',
    });
    res.send(buffer);
  }

  @Patch(':id')
  @Roles(...GATE_YARD_OPERATE_ROLES)
  update(@Param('id') id: string, @Body() body: any, @CurrentUser() user: any) {
    return this.gateEntriesService.update(id, body, user);
  }

  @Patch(':id/gate-out')
  @Roles(...GATE_YARD_OPERATE_ROLES)
  gateOut(@Param('id') id: string, @Body() body: any, @CurrentUser() user: any) {
    return this.gateEntriesService.gateOut(id, body, user);
  }

  // Lightweight stand-in for real Dock Scheduling — see
  // GateEntriesService.dockIn's comment.
  @Patch(':id/dock-in')
  @Roles(...GATE_YARD_OPERATE_ROLES)
  dockIn(@Param('id') id: string, @CurrentUser() user: any) {
    return this.gateEntriesService.dockIn(id, user);
  }
}
