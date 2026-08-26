import { Body, Controller, Get, Param, Patch, Post, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import * as XLSX from 'xlsx';
import { UsersService } from './users.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { MASTER_DATA_READ_ROLES } from '../common/tenant.util';
import { stripHeaderAsterisks } from '../common/xlsx-parse.util';

// OPERATOR never touches this controller — no master-data visibility for
// that role, per the role-access design (see CLAUDE.md once written up).
// Reuses MASTER_DATA_READ_ROLES as the entry gate, PLUS SECURITY_SUPERVISOR
// (2026-08-27) — that role is excluded from the other four master-data pages
// (Warehouse/SKU/Customer/Location) same as OPERATOR, but Users is the one
// exception: CREATABLE_ROLES lets a SECURITY_SUPERVISOR create/manage
// OPERATOR accounts under them, so they need to actually reach this
// controller. Which of the gated-in roles can create/edit a given target
// role is a further, per-request check inside UsersService — it depends on
// the caller's own role and target role, not a fixed list a single
// @Roles() can express.
const CAN_MANAGE_USERS = [...MASTER_DATA_READ_ROLES, 'SECURITY_SUPERVISOR'];

@Controller('users')
@UseGuards(JwtAuthGuard, RolesGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post()
  @Roles(...CAN_MANAGE_USERS)
  create(@Body() body: any, @CurrentUser() user: any) {
    return this.usersService.create(body, user);
  }

  @Get()
  @Roles(...CAN_MANAGE_USERS)
  findAll(@CurrentUser() user: any) {
    return this.usersService.findAll(user);
  }

  @Get('export')
  @Roles(...CAN_MANAGE_USERS)
  async export(@Res() res: Response, @CurrentUser() user: any) {
    const rows = await this.usersService.exportRows(user);
    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'User Master');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': 'attachment; filename="User_Master_Export.xlsx"',
    });
    res.send(buffer);
  }

  @Patch(':id')
  @Roles(...CAN_MANAGE_USERS)
  update(@Param('id') id: string, @Body() body: any, @CurrentUser() user: any) {
    return this.usersService.update(id, body, user);
  }

  @Patch(':id/deactivate')
  @Roles(...CAN_MANAGE_USERS)
  deactivate(@Param('id') id: string, @CurrentUser() user: any) {
    return this.usersService.deactivate(id, user);
  }

  @Patch(':id/reactivate')
  @Roles(...CAN_MANAGE_USERS)
  reactivate(@Param('id') id: string, @CurrentUser() user: any) {
    return this.usersService.reactivate(id, user);
  }

  @Get(':id/login-history')
  @Roles(...CAN_MANAGE_USERS)
  getLoginHistory(@Param('id') id: string, @CurrentUser() user: any) {
    return this.usersService.getLoginHistory(id, user);
  }

  // For onboarding a large batch (e.g. 100+ Operators) at once — the manual
  // one-by-one form doesn't scale for that. Same CAN_MANAGE_USERS gate as
  // create() (not MASTER_DATA_WRITE_ROLES — a Supervisor bulk-importing
  // Operators is exactly as legitimate as one adding a single Operator by
  // hand; UsersService enforces the real per-row role/warehouse limits).
  @Post('import')
  @Roles(...CAN_MANAGE_USERS)
  @UseInterceptors(FileInterceptor('file'))
  async importFile(@UploadedFile() file: Express.Multer.File, @CurrentUser() user: any) {
    let workbook: XLSX.WorkBook;
    try {
      workbook = XLSX.read(file.buffer, { type: 'buffer' });
    } catch {
      return { totalUsers: 0, successCount: 0, failCount: 0, results: [{ email: '(file)', status: 'error', errors: ['File could not be read — is it a valid .xlsx file?'] }] };
    }
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rawRows: any[] = stripHeaderAsterisks(XLSX.utils.sheet_to_json(sheet, { defval: '' }));

    const rows = rawRows
      .filter((r) => r['Login ID'] || r['Name'])
      .map((r) => ({
        name: r['Name'] ? String(r['Name']).trim() : '',
        email: r['Login ID'] ? String(r['Login ID']).trim() : '',
        password: r['Password'] ? String(r['Password']) : '',
        role: r['Role'] ? String(r['Role']).trim() : '',
        functionTag: r['Function Tag'] ? String(r['Function Tag']).trim() : undefined,
        phone: r['Phone'] ? String(r['Phone']).trim() : undefined,
        warehouseCodes: r['Warehouse Code(s)'] ? String(r['Warehouse Code(s)']).trim() : '',
      }));

    return this.usersService.bulkImport(rows, user);
  }
}
