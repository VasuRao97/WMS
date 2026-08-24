import { Body, Controller, Delete, Get, Param, Patch, Post, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import * as XLSX from 'xlsx';
import { SkusService } from './skus.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { toBool, toNumberOrUndefined } from '../common/xlsx-parse.util';

@Controller('skus')
@UseGuards(JwtAuthGuard)
export class SkusController {
  constructor(private readonly skusService: SkusService) {}

  @Post()
  create(@Body() body: any, @CurrentUser() user: any) {
    return this.skusService.create(body, user);
  }

  @Get()
  findAll(@CurrentUser() user: any) {
    return this.skusService.findAll(user);
  }

  @Get('summary')
  getSummary(@CurrentUser() user: any) {
    return this.skusService.getSummary(user);
  }

  @Get('export')
  async export(@Res() res: Response, @CurrentUser() user: any) {
    const rows = await this.skusService.exportRows(user);
    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'SKU Master');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': 'attachment; filename="SKU_Master_Export.xlsx"',
    });
    res.send(buffer);
  }

  @Patch(':id/deactivate')
  deactivate(@Param('id') id: string, @CurrentUser() user: any) {
    return this.skusService.deactivate(id, user);
  }

  @Patch(':id/reactivate')
  reactivate(@Param('id') id: string, @CurrentUser() user: any) {
    return this.skusService.reactivate(id, user);
  }

  @Delete('all')
  removeAll(@CurrentUser() user: any) {
    return this.skusService.removeAll(user);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() user: any) {
    return this.skusService.remove(id, user);
  }

  @Post('import')
  @UseInterceptors(FileInterceptor('file'))
  async importFile(@UploadedFile() file: Express.Multer.File, @CurrentUser() user: any) {
    let workbook: XLSX.WorkBook;
    try {
      workbook = XLSX.read(file.buffer, { type: 'buffer' });
    } catch {
      return { totalRows: 0, successCount: 0, failCount: 0, results: [{ row: 0, code: '(file)', status: 'error', errors: ['File could not be read — is it a valid .xlsx file?'] }] };
    }
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rawRows: any[] = XLSX.utils.sheet_to_json(sheet, { defval: '' });

    const rows = rawRows.map((r) => {
      const storageUnits: any[] = [];
      if (r['Storage Unit 1 Type']) {
        storageUnits.push({
          unitType: String(r['Storage Unit 1 Type']).toUpperCase(),
          qtyInBaseUom: toNumberOrUndefined(r['Storage Unit 1 Qty']),
          isPreferred: toBool(r['Storage Unit 1 Preferred']),
        });
      }
      if (r['Storage Unit 2 Type']) {
        storageUnits.push({
          unitType: String(r['Storage Unit 2 Type']).toUpperCase(),
          qtyInBaseUom: toNumberOrUndefined(r['Storage Unit 2 Qty']),
          isPreferred: toBool(r['Storage Unit 2 Preferred']),
        });
      }
      const barcodes: any[] = [];
      if (r['Barcode 1 Value']) {
        barcodes.push({ barcode: String(r['Barcode 1 Value']), type: String(r['Barcode 1 Type']).toUpperCase() || 'EACH' });
      }
      if (r['Barcode 2 Value']) {
        barcodes.push({ barcode: String(r['Barcode 2 Value']), type: String(r['Barcode 2 Type']).toUpperCase() || 'EACH' });
      }
      return {
        code: r['SKU Code'] ? String(r['SKU Code']).trim() : '',
        description: r['Description'] ? String(r['Description']).trim() : '',
        category: r['Category'] ? String(r['Category']).trim() : '',
        subCategory: r['Sub Category'] ? String(r['Sub Category']).trim() : undefined,
        primaryStorageUnit: r['Primary Storage Unit'] ? String(r['Primary Storage Unit']).toUpperCase().trim() : undefined,
        baseUom: r['Base UOM'] ? String(r['Base UOM']).toUpperCase().trim() : '',
        hsnCode: r['HSN Code'] ? String(r['HSN Code']).trim() : '',
        storageCondition: r['Storage Condition'] ? String(r['Storage Condition']).toUpperCase().trim() : 'AMBIENT',
        batchTracked: toBool(r['Batch Tracked']),
        shelfLifeTracked: toBool(r['Shelf Life Tracked']),
        shelfLifeDays: toNumberOrUndefined(r['Shelf Life Days']),
        isActive: r['Active'] === '' ? true : toBool(r['Active']),
        weightUom: r['Weight UOM'] ? String(r['Weight UOM']).toUpperCase().trim() : undefined,
        grossWeight: toNumberOrUndefined(r['Gross Weight']),
        isHazmat: toBool(r['Hazmat']),
        hazmatClass: r['Hazmat Class'] ? String(r['Hazmat Class']).trim() : undefined,
        hasUniqueBarcode: toBool(r['Has Unique Barcode']),
        abcClass: r['ABC Class'] ? String(r['ABC Class']).toUpperCase().trim() : undefined,
        currency: r['Currency'] ? String(r['Currency']).trim() : undefined,
        standardCost: toNumberOrUndefined(r['Standard Cost']),
        moq: toNumberOrUndefined(r['MOQ']),
        storageUnits,
        barcodes,
      };
    });

    return this.skusService.bulkImport(rows, user);
  }
}