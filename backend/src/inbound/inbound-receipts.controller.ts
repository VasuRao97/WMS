import { Body, Controller, Delete, Get, Param, Patch, Post, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import * as XLSX from 'xlsx';
import { InboundReceiptsService } from './inbound-receipts.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { stripHeaderAsterisks } from '../common/xlsx-parse.util';
import { INBOUND_READ_ROLES, INBOUND_ORDER_WRITE_ROLES, INBOUND_APPROVE_ROLES } from '../common/tenant.util';

@Controller('inbound-receipts')
@UseGuards(JwtAuthGuard, RolesGuard)
export class InboundReceiptsController {
  constructor(private readonly inboundReceiptsService: InboundReceiptsService) {}

  // The "order maker" — see InboundReceiptsService's class comment.
  @Post()
  @Roles(...INBOUND_ORDER_WRITE_ROLES)
  create(@Body() body: any, @CurrentUser() user: any) {
    return this.inboundReceiptsService.create(body, user);
  }

  // Completes an order created with no Vehicle (an ERP-pushed one, today —
  // see InboundReceiptsService.assignVehicle()'s own comment). Same role
  // gate as create() — this is staff editing WMS-side data, not the ERP
  // calling back in (that's ErpInboundController, a completely separate
  // API-key-guarded controller).
  @Patch(':id/assign-vehicle')
  @Roles(...INBOUND_ORDER_WRITE_ROLES)
  assignVehicle(@Param('id') id: string, @Body('vehicleId') vehicleId: string, @CurrentUser() user: any) {
    return this.inboundReceiptsService.assignVehicle(id, vehicleId, user);
  }

  // Excel bulk import (2026-08-27, Inbound deep-dive conversation) — a
  // second alternative to the manual order maker, alongside ERP push
  // (ErpInboundController). One file can create MULTIPLE orders: rows are
  // grouped by (Warehouse Code, Reference No) — same repeated-key grouping
  // pattern as Warehouse Storage Types/Customer Ship-tos — each distinct
  // group becoming its own order with its SKU lines.
  @Post('import')
  @Roles(...INBOUND_ORDER_WRITE_ROLES)
  @UseInterceptors(FileInterceptor('file'))
  async importFile(@UploadedFile() file: Express.Multer.File, @CurrentUser() user: any) {
    let workbook: XLSX.WorkBook;
    try {
      workbook = XLSX.read(file.buffer, { type: 'buffer' });
    } catch {
      return { totalOrders: 0, successCount: 0, failCount: 0, results: [{ referenceNo: '(file)', status: 'error', errors: ['File could not be read — is it a valid .xlsx file?'] }] };
    }
    // Read by sheet NAME, not position — same convention as Warehouse/
    // Location's importers (the template ships "How To Use"/"Legend &
    // Rules" tabs alongside the data tab).
    const sheet = workbook.Sheets['Inbound Order Import'];
    if (!sheet) {
      return { totalOrders: 0, successCount: 0, failCount: 0, results: [{ referenceNo: '(file)', status: 'error', errors: ['No "Inbound Order Import" sheet found in this file.'] }] };
    }
    const rawRows: any[] = stripHeaderAsterisks(XLSX.utils.sheet_to_json(sheet, { defval: '' }));

    const grouped = new Map<string, any>();
    for (const r of rawRows) {
      const warehouseCode = r['Warehouse Code'] ? String(r['Warehouse Code']).trim().toUpperCase() : '';
      const referenceNo = r['Reference No'] ? String(r['Reference No']).trim() : '';
      if (!warehouseCode && !referenceNo) continue;
      const key = `${warehouseCode}::${referenceNo}`;

      if (!grouped.has(key)) {
        grouped.set(key, {
          warehouseCode,
          referenceNo,
          supplierName: r['Supplier Name'] ? String(r['Supplier Name']).trim() : undefined,
          // 1:1 vehicle<->order mapping (2026-08-27 follow-up) — same
          // "only the first row's value is used" convention as Supplier
          // Name, since every row in a group is the same order.
          vehicleNumber: r['Vehicle Number'] ? String(r['Vehicle Number']).trim() : undefined,
          lines: [] as any[],
        });
      }
      const order = grouped.get(key);
      if (r['SKU Code']) {
        order.lines.push({ skuCode: String(r['SKU Code']).trim(), expectedQty: r['Expected Qty'] });
      }
    }

    return this.inboundReceiptsService.bulkImport(Array.from(grouped.values()), user);
  }

  @Get()
  @Roles(...INBOUND_READ_ROLES)
  findAll(@CurrentUser() user: any) {
    return this.inboundReceiptsService.findAll(user);
  }

  // Route declared with the literal 'all' segment before ':id' — same
  // route-ordering rule every other Delete All in this codebase follows
  // (Nest would otherwise match 'all' as an :id param). COMPANY_ADMIN-only,
  // same tier as every other Delete All's delete gate. See
  // InboundReceiptsService.removeAll()'s own comment for why this one
  // genuinely deletes ledger data, unlike every other Delete All.
  @Delete('all')
  @Roles('COMPANY_ADMIN')
  removeAll(@CurrentUser() user: any) {
    return this.inboundReceiptsService.removeAll(user);
  }

  @Get(':id')
  @Roles(...INBOUND_READ_ROLES)
  findOne(@Param('id') id: string, @CurrentUser() user: any) {
    return this.inboundReceiptsService.findOne(id, user);
  }

  // Route declared with a literal 'scans' segment before the more generic
  // GET ':id' above never conflicts here since these are PATCH, not GET —
  // still keeping the specific-before-generic convention this codebase
  // uses everywhere (see WarehousesController's Delete All route ordering
  // note) in case another GET ever gets added under this same prefix.
  @Patch('scans/:scanId/approve')
  @Roles(...INBOUND_APPROVE_ROLES)
  approveScan(@Param('scanId') scanId: string, @Body() body: any, @CurrentUser() user: any) {
    return this.inboundReceiptsService.approveScan(scanId, body, user);
  }

  @Patch('scans/:scanId/reject')
  @Roles(...INBOUND_APPROVE_ROLES)
  rejectScan(@Param('scanId') scanId: string, @CurrentUser() user: any) {
    return this.inboundReceiptsService.rejectScan(scanId, user);
  }
}
