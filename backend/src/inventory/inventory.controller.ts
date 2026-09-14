import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import * as XLSX from 'xlsx';
import { InventoryService } from './inventory.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { type AuthUser, MASTER_DATA_READ_ROLES } from '../common/tenant.util';

@Controller('inventory')
@UseGuards(JwtAuthGuard, RolesGuard)
export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  @Get('line-items')
  @Roles(...MASTER_DATA_READ_ROLES)
  lineItems(
    @Query('warehouseId') warehouseId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.inventoryService.lineItems(user, warehouseId);
  }

  @Get('sku-summary')
  @Roles(...MASTER_DATA_READ_ROLES)
  skuSummary(
    @Query('warehouseId') warehouseId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.inventoryService.skuSummary(user, warehouseId);
  }

  // Excel export for the two balance-snapshot views above — declared right
  // after their own JSON reads, same "export sits beside its own read"
  // layout as the ledger pair further down. Both routes have a fixed
  // literal path segment ('export'), not a ':id' param, so there's no
  // route-ordering concern here either.
  @Get('line-items/export')
  @Roles(...MASTER_DATA_READ_ROLES)
  async exportLineItems(
    @Query('warehouseId') warehouseId: string,
    @Res() res: Response,
    @CurrentUser() user: AuthUser,
  ) {
    const rows = await this.inventoryService.exportLineItemRows(user, warehouseId);
    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Line Items');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    res.set({
      'Content-Type':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition':
        'attachment; filename="Inventory_Line_Items_Export.xlsx"',
    });
    res.send(buffer);
  }

  @Get('sku-summary/export')
  @Roles(...MASTER_DATA_READ_ROLES)
  async exportSkuSummary(
    @Query('warehouseId') warehouseId: string,
    @Res() res: Response,
    @CurrentUser() user: AuthUser,
  ) {
    const rows = await this.inventoryService.exportSkuSummaryRows(user, warehouseId);
    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'SKU Summary');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    res.set({
      'Content-Type':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition':
        'attachment; filename="Inventory_SKU_Summary_Export.xlsx"',
    });
    res.send(buffer);
  }

  // Transaction-level ledger — warehouseId is OPTIONAL here (company-wide
  // dump when omitted, COMPANY_ADMIN/SUPER_ADMIN only — enforced in the
  // service). from/to are plain YYYY-MM-DD strings, both optional; a single
  // day is just from === to.
  @Get('ledger')
  @Roles(...MASTER_DATA_READ_ROLES)
  ledger(
    @Query('warehouseId') warehouseId: string | undefined,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    return this.inventoryService.ledger(
      user,
      warehouseId || undefined,
      from || undefined,
      to || undefined,
    );
  }

  // Excel export of the same rows — declared after 'ledger' but Nest routes
  // on the full path ('inventory/ledger/export'), so there's no :id-style
  // param collision to worry about here (unlike Gate Entries' own 'export'
  // route, which needed to come before a ':id' route).
  @Get('ledger/export')
  @Roles(...MASTER_DATA_READ_ROLES)
  async exportLedger(
    @Query('warehouseId') warehouseId: string | undefined,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Res() res: Response,
    @CurrentUser() user: AuthUser,
  ) {
    const rows = await this.inventoryService.exportLedgerRows(
      user,
      warehouseId || undefined,
      from || undefined,
      to || undefined,
    );
    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Ledger');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    res.set({
      'Content-Type':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition':
        'attachment; filename="Inventory_Ledger_Export.xlsx"',
    });
    res.send(buffer);
  }
}
