import { Body, Controller, Delete, Get, Param, Patch, Post, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import * as XLSX from 'xlsx';
import { WarehousesService } from './warehouses.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { stripHeaderAsterisks, toNumberOrUndefined } from '../common/xlsx-parse.util';
import { MASTER_DATA_READ_ROLES, MASTER_DATA_WRITE_ROLES } from '../common/tenant.util';

@Controller('warehouses')
@UseGuards(JwtAuthGuard, RolesGuard)
export class WarehousesController {
  constructor(private readonly warehousesService: WarehousesService) {}

  @Post()
  @Roles(...MASTER_DATA_WRITE_ROLES)
  create(@Body() body: any, @CurrentUser() user: any) {
    return this.warehousesService.create(body, user);
  }

  @Get()
  @Roles(...MASTER_DATA_READ_ROLES)
  findAll(@CurrentUser() user: any) {
    return this.warehousesService.findAll(user);
  }

  @Get('customer-summary')
  @Roles(...MASTER_DATA_READ_ROLES)
  getCustomerSummary(@CurrentUser() user: any) {
    return this.warehousesService.getCustomerSummary(user);
  }

  @Get('mapping-summary')
  @Roles(...MASTER_DATA_READ_ROLES)
  getMappingSummary(@CurrentUser() user: any) {
    return this.warehousesService.getMappingSummary(user);
  }

  @Get('export')
  @Roles(...MASTER_DATA_READ_ROLES)
  async export(@Res() res: Response, @CurrentUser() user: any) {
    const rows = await this.warehousesService.exportRows(user);
    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Warehouse Master');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': 'attachment; filename="Warehouse_Master_Export.xlsx"',
    });
    res.send(buffer);
  }

  @Patch(':id/deactivate')
  @Roles(...MASTER_DATA_WRITE_ROLES)
  deactivate(@Param('id') id: string, @CurrentUser() user: any) {
    return this.warehousesService.deactivate(id, user);
  }

  @Patch(':id/reactivate')
  @Roles(...MASTER_DATA_WRITE_ROLES)
  reactivate(@Param('id') id: string, @CurrentUser() user: any) {
    return this.warehousesService.reactivate(id, user);
  }

  // Company-Admin-only per the client's own call — set via Company
  // Settings' per-warehouse "Aging Methodology" control, not a general
  // Warehouse Edit form (none exists yet).
  @Patch(':id/aging-granularity')
  @Roles('COMPANY_ADMIN')
  setAgingGranularity(@Param('id') id: string, @Body() body: { agingGranularity: string | null }, @CurrentUser() user: any) {
    return this.warehousesService.setAgingGranularity(id, body.agingGranularity ?? null, user);
  }

  // Route order matters — @Delete('all') must be declared before
  // @Delete(':id') or Nest matches "all" as an :id param.
  @Delete('all')
  @Roles('COMPANY_ADMIN')
  removeAll(@CurrentUser() user: any) {
    return this.warehousesService.removeAll(user);
  }

  @Delete(':id')
  @Roles('COMPANY_ADMIN')
  remove(@Param('id') id: string, @CurrentUser() user: any) {
    return this.warehousesService.remove(id, user);
  }

  @Post('import')
  @Roles(...MASTER_DATA_WRITE_ROLES)
  @UseInterceptors(FileInterceptor('file'))
  async importFile(@UploadedFile() file: Express.Multer.File, @CurrentUser() user: any) {
    let workbook: XLSX.WorkBook;
    try {
      workbook = XLSX.read(file.buffer, { type: 'buffer' });
    } catch {
      return { totalWarehouses: 0, successCount: 0, failCount: 0, results: [{ code: '(file)', status: 'error', errors: ['File could not be read — is it a valid .xlsx file?'] }] };
    }
    // Read by sheet NAME, not position — the "How To Use"/"Legend & Rules"
    // tabs sit alongside the data tab in this template, unlike SKU/Customer
    // where the data sheet has always been sheet[0].
    const sheet = workbook.Sheets['Warehouse Import'];
    if (!sheet) {
      return { totalWarehouses: 0, successCount: 0, failCount: 0, results: [{ code: '(file)', status: 'error', errors: ['No "Warehouse Import" sheet found in this file.'] }] };
    }
    // Template header cells mark required columns with a trailing " *"
    // (e.g. "Location Code *") — strip it before any r['Column Name'] lookup.
    const rawRows: any[] = stripHeaderAsterisks(XLSX.utils.sheet_to_json(sheet, { defval: '' }));

    const grouped = new Map<string, any>();

    for (const r of rawRows) {
      const code = r['Location Code'] ? String(r['Location Code']).trim().toUpperCase() : '';
      if (!code) continue;

      if (!grouped.has(code)) {
        grouped.set(code, {
          code,
          nodeType: r['Type of Node'] ? String(r['Type of Node']).trim() : '',
          city: r['City Name'] ? String(r['City Name']).trim() : '',
          address: r['Address'] ? String(r['Address']).trim() : '',
          pincode: r['Pincode'] ? String(r['Pincode']).trim() : '',
          latitude: toNumberOrUndefined(r['Latitude']),
          longitude: toNumberOrUndefined(r['Longitude']),
          threePlName: r['3PL Name'] ? String(r['3PL Name']).trim() : undefined,
          noOfDocks: toNumberOrUndefined(r['No of Docks']),
          areaSqFt: toNumberOrUndefined(r['Area sq ft']),
          yardCapacity: toNumberOrUndefined(r['Parking Slots']),
          gstin: r['GSTIN'] ? String(r['GSTIN']).trim() : undefined,
          workingDays: r['Working Days'] ? String(r['Working Days']).trim() : undefined,
          workingHours: r['Working Hours'] ? String(r['Working Hours']).trim() : undefined,
          contactName: r['Contact Name'] ? String(r['Contact Name']).trim() : undefined,
          contactPhone: r['Contact Phone'] ? String(r['Contact Phone']).trim() : undefined,
          storageTypes: [] as any[],
          dispatchFlows: [] as any[],
        });
      }

      const wh = grouped.get(code);
      if (r['Storage Type']) {
        wh.storageTypes.push({
          storageType: String(r['Storage Type']).trim(),
          palletPositions: toNumberOrUndefined(r['Pallet Positions']),
          category: r['Category'] ? String(r['Category']).trim() : undefined,
          lengthM: toNumberOrUndefined(r['Dim L (m)']),
          widthM: toNumberOrUndefined(r['Dim W (m)']),
          heightM: toNumberOrUndefined(r['Dim H (m)']),
        });
      }
      if (r['Dispatch Flow']) {
        wh.dispatchFlows.push({ flowType: String(r['Dispatch Flow']).trim() });
      }
    }

    return this.warehousesService.bulkImport(Array.from(grouped.values()), user);
  }
}
