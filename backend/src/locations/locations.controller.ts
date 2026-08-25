import { Body, Controller, Delete, Get, Param, Patch, Post, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import * as XLSX from 'xlsx';
import { LocationsService } from './locations.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { MASTER_DATA_READ_ROLES, MASTER_DATA_WRITE_ROLES } from '../common/tenant.util';
import { stripHeaderAsterisks, toNumberOrUndefined } from '../common/xlsx-parse.util';

@Controller('locations')
@UseGuards(JwtAuthGuard, RolesGuard)
export class LocationsController {
  constructor(private readonly locationsService: LocationsService) {}

  @Post()
  @Roles(...MASTER_DATA_WRITE_ROLES)
  create(@Body() body: any, @CurrentUser() user: any) {
    return this.locationsService.create(body, user);
  }

  // Range generator — one Rack range (rack x level x bin x depth), Ground
  // Block range, or Stillage Stack range in one call. See
  // LocationsService.generate() and CLAUDE.md's Locations/Bins notes.
  @Post('generate')
  @Roles(...MASTER_DATA_WRITE_ROLES)
  generate(@Body() body: any, @CurrentUser() user: any) {
    return this.locationsService.generate(body, user);
  }

  @Post('import')
  @Roles(...MASTER_DATA_WRITE_ROLES)
  @UseInterceptors(FileInterceptor('file'))
  async importFile(@UploadedFile() file: Express.Multer.File, @CurrentUser() user: any) {
    let workbook: XLSX.WorkBook;
    try {
      workbook = XLSX.read(file.buffer, { type: 'buffer' });
    } catch {
      return { totalRows: 0, successCount: 0, failCount: 0, results: [{ status: 'error', errors: ['File could not be read — is it a valid .xlsx file?'] }] };
    }
    // Read by sheet NAME, not position — see CLAUDE.md's note on Warehouse's
    // import controller for why (a reordered sheet silently reading the
    // wrong tab bit this project once already).
    const sheet = workbook.Sheets['Location Import'];
    if (!sheet) {
      return { totalRows: 0, successCount: 0, failCount: 0, results: [{ status: 'error', errors: ['No "Location Import" sheet found in this file.'] }] };
    }
    const rawRows: any[] = stripHeaderAsterisks(XLSX.utils.sheet_to_json(sheet, { defval: '' }));

    const rows = rawRows
      .filter((r) => r['Warehouse Code'] || r['Aisle']) // skip fully-blank trailing rows
      .map((r) => ({
        warehouseCode: r['Warehouse Code'] ? String(r['Warehouse Code']).trim() : '',
        zoneType: r['Zone Type'] ? String(r['Zone Type']).trim() : '',
        storageType: r['Storage Type'] ? String(r['Storage Type']).trim() : '',
        category: r['Category'] ? String(r['Category']).trim() : undefined,
        zone: r['Zone'] ? String(r['Zone']).trim() : undefined,
        aisle: r['Aisle'] ? String(r['Aisle']).trim() : '',
        rack: r['Rack'] ? String(r['Rack']).trim() : undefined,
        level: r['Level'] ? String(r['Level']).trim() : undefined,
        bin: r['Bin'] ? String(r['Bin']).trim() : undefined,
        block: r['Block'] ? String(r['Block']).trim() : undefined,
        stack: r['Stack'] ? String(r['Stack']).trim() : undefined,
        depth: toNumberOrUndefined(r['Depth']),
        width: toNumberOrUndefined(r['Width']),
        height: toNumberOrUndefined(r['Height']),
      }));

    return this.locationsService.bulkImport(rows, user);
  }

  @Get()
  @Roles(...MASTER_DATA_READ_ROLES)
  findAll(@CurrentUser() user: any) {
    return this.locationsService.findAll(user);
  }

  @Get('export')
  @Roles(...MASTER_DATA_READ_ROLES)
  async export(@Res() res: Response, @CurrentUser() user: any) {
    const rows = await this.locationsService.exportRows(user);
    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Location Import');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': 'attachment; filename="Location_Master_Export.xlsx"',
    });
    res.send(buffer);
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
