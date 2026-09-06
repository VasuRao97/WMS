import { Body, Controller, Get, Post, Query, UseGuards, UseInterceptors, UploadedFile } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import * as XLSX from 'xlsx';
import { AbcClassificationService } from './abc-classification.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { MASTER_DATA_READ_ROLES, MASTER_DATA_WRITE_ROLES } from '../common/tenant.util';
import { stripHeaderAsterisks } from '../common/xlsx-parse.util';

// Monthly ABC reassessment (2026-09-06 — see [[wms-abc-velocity-design]]) —
// same role tier as every other master-data write/read split in this
// codebase; this writes real SkuWarehouseClass rows (Run Now) or reads them
// (current results), same weight as generating Locations/managing SKUs.
@Controller('abc-classification')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AbcClassificationController {
  constructor(private readonly abcClassification: AbcClassificationService) {}

  @Post('run')
  @Roles(...MASTER_DATA_WRITE_ROLES)
  runNow(@CurrentUser() user: any) {
    return this.abcClassification.runNow(user);
  }

  @Get('current')
  @Roles(...MASTER_DATA_READ_ROLES)
  current(@CurrentUser() user: any, @Query('warehouseId') warehouseId?: string) {
    return this.abcClassification.current(user, warehouseId);
  }

  @Post('historical-dispatch/import')
  @Roles(...MASTER_DATA_WRITE_ROLES)
  @UseInterceptors(FileInterceptor('file'))
  async importHistoricalDispatch(@UploadedFile() file: Express.Multer.File, @CurrentUser() user: any) {
    let workbook: XLSX.WorkBook;
    try {
      workbook = XLSX.read(file.buffer, { type: 'buffer' });
    } catch {
      return { totalRows: 0, successCount: 0, failCount: 0, results: [{ row: 0, skuCode: '(file)', warehouseCode: '', status: 'error', errors: ['File could not be read — is it a valid .xlsx file?'] }] };
    }
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows: any[] = stripHeaderAsterisks(XLSX.utils.sheet_to_json(sheet, { defval: '' }));
    return this.abcClassification.importHistoricalDispatch(rows, user);
  }
}
