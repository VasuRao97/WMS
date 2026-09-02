import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { MASTER_DATA_READ_ROLES, MASTER_DATA_WRITE_ROLES, INBOUND_SCAN_ROLES } from '../common/tenant.util';
import { PalletsService } from './pallets.service';

// Pallet Master — same read/write role tier as Locations (occasional-edit
// master data, not a daily workflow), except the manual short-close action,
// which is floor work gated the same as scanning itself (INBOUND_SCAN_ROLES).
@Controller('pallets')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PalletsController {
  constructor(private palletsService: PalletsService) {}

  @Get()
  @Roles(...MASTER_DATA_READ_ROLES)
  findAll(@Query('warehouseId') warehouseId: string, @Query('status') status: string, @CurrentUser() user: any) {
    return this.palletsService.findAll(user, warehouseId, status);
  }

  // The Receiving modal's own pallet picker (2026-09-01) — broader than
  // MASTER_DATA_READ_ROLES, gated the same as scanning itself, since this is
  // consulted mid-receiving, not while browsing master data.
  @Get('loadable')
  @Roles(...INBOUND_SCAN_ROLES)
  findLoadable(@Query('warehouseId') warehouseId: string, @Query('skuId') skuId: string | undefined, @CurrentUser() user: any) {
    return this.palletsService.findLoadable(user, warehouseId, skuId || undefined);
  }

  @Post('generate')
  @Roles(...MASTER_DATA_WRITE_ROLES)
  generate(@Body() body: any, @CurrentUser() user: any) {
    return this.palletsService.generate(body, user);
  }

  @Post('labels')
  @Roles(...MASTER_DATA_READ_ROLES)
  async labels(@Body() body: { palletIds: string[] }, @CurrentUser() user: any, @Res() res: Response) {
    const buffer = await this.palletsService.buildLabelsZip(body?.palletIds || [], user);
    res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="Pallet_Labels.zip"' });
    res.send(buffer);
  }

  @Patch(':id/deactivate')
  @Roles(...MASTER_DATA_WRITE_ROLES)
  deactivate(@Param('id') id: string, @CurrentUser() user: any) {
    return this.palletsService.deactivate(id, false, user);
  }

  @Patch(':id/reactivate')
  @Roles(...MASTER_DATA_WRITE_ROLES)
  reactivate(@Param('id') id: string, @CurrentUser() user: any) {
    return this.palletsService.deactivate(id, true, user);
  }

  // Route order matters — must be declared before ':id'-shaped routes below
  // it would otherwise never match, same convention as every other Delete
  // All in this codebase.
  @Delete('all')
  @Roles('COMPANY_ADMIN')
  removeAll(@CurrentUser() user: any) {
    return this.palletsService.removeAll(user);
  }

  // Manual short-close (2026-09-01) — "an operator's manual short-close."
  @Patch('loads/:id/close')
  @Roles(...INBOUND_SCAN_ROLES)
  closeLoad(@Param('id') id: string, @CurrentUser() user: any) {
    return this.palletsService.manualShortClose(id, user);
  }
}
