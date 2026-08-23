import { Body, Controller, Delete, Get, Param, Patch, Post, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import * as XLSX from 'xlsx';
import { CustomersService } from './customers.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { toBool } from '../common/xlsx-parse.util';

@Controller('customers')
@UseGuards(JwtAuthGuard)
export class CustomersController {
  constructor(private readonly customersService: CustomersService) {}

  @Post()
  create(@Body() body: any, @CurrentUser() user: any) {
    return this.customersService.create(body, user);
  }

  @Get()
  findAll(@CurrentUser() user: any) {
    return this.customersService.findAll(user);
  }

  @Patch(':id/deactivate')
  deactivate(@Param('id') id: string, @CurrentUser() user: any) {
    return this.customersService.deactivate(id, user);
  }

  @Patch(':id/reactivate')
  reactivate(@Param('id') id: string, @CurrentUser() user: any) {
    return this.customersService.reactivate(id, user);
  }

  @Delete('all')
  removeAll(@CurrentUser() user: any) {
    return this.customersService.removeAll(user);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() user: any) {
    return this.customersService.remove(id, user);
  }

  @Post('import')
  @UseInterceptors(FileInterceptor('file'))
  async importFile(@UploadedFile() file: Express.Multer.File, @CurrentUser() user: any) {
    let workbook: XLSX.WorkBook;
    try {
      workbook = XLSX.read(file.buffer, { type: 'buffer' });
    } catch {
      return { totalCustomers: 0, successCount: 0, failCount: 0, results: [{ code: '(file)', status: 'error', errors: ['File could not be read — is it a valid .xlsx file?'] }] };
    }
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rawRows: any[] = XLSX.utils.sheet_to_json(sheet, { defval: '' });

    const grouped = new Map<string, any>();

    for (const r of rawRows) {
      const code = r['Bill To ID'] ? String(r['Bill To ID']).trim().toUpperCase() : '';
      if (!code) continue;

      if (!grouped.has(code)) {
        grouped.set(code, {
          code,
          name: r['Customer Name'] ? String(r['Customer Name']).trim() : '',
          category: r['Category'] ? String(r['Category']).trim() : undefined,
          email: r['Email'] ? String(r['Email']).trim() : undefined,
          phone: r['Phone'] ? String(r['Phone']).trim() : undefined,
          pan: r['PAN'] ? String(r['PAN']).trim() : undefined,
          billingAddress: r['Billing Address'] ? String(r['Billing Address']).trim() : undefined,
          pincode: r['Billing Pincode'] ? String(r['Billing Pincode']).trim() : undefined,
          state: r['Billing State'] ? String(r['Billing State']).trim() : undefined,
          gstNumber: r['Billing GST Number'] ? String(r['Billing GST Number']).trim() : undefined,
          shipToLocations: [] as any[],
        });
      }

      const customer = grouped.get(code);
      if (r['Ship To Address']) {
        customer.shipToLocations.push({
          shipToCode: r['Ship To ID'] ? String(r['Ship To ID']).trim() : undefined,
          address: String(r['Ship To Address']).trim(),
          pincode: r['Ship To Pincode'] ? String(r['Ship To Pincode']).trim() : '',
          state: r['Ship To State'] ? String(r['Ship To State']).trim() : '',
          gstNumber: r['Ship To GST Number'] ? String(r['Ship To GST Number']).trim() : undefined,
          warehouseCode: r['Ship To Warehouse Code'] ? String(r['Ship To Warehouse Code']).trim() : undefined,
          deliveryZone: r['Ship To Local/Upcountry'] ? String(r['Ship To Local/Upcountry']).trim().toUpperCase() : undefined,
          isDefault: toBool(r['Ship To Default']),
        });
      }
    }

    return this.customersService.bulkImport(Array.from(grouped.values()), user);
  }
}