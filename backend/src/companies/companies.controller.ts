import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { CompaniesService } from './companies.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { MASTER_DATA_READ_ROLES } from '../common/tenant.util';

// Company Admin only — per the client's own framing ("for the company
// admin, the number should be in the company setting page"). No warehouse
// scoping (companies aren't warehouse-scoped) and no SUPER_ADMIN access
// (there's no single company for them to configure — see
// CompaniesService.requireCompany).
@Controller('companies')
@UseGuards(JwtAuthGuard, RolesGuard)
export class CompaniesController {
  constructor(private readonly companiesService: CompaniesService) {}

  @Get('settings')
  @Roles('COMPANY_ADMIN')
  getSettings(@CurrentUser() user: any) {
    return this.companiesService.getSettings(user);
  }

  @Patch('settings')
  @Roles('COMPANY_ADMIN')
  updateSettings(@Body() body: any, @CurrentUser() user: any) {
    return this.companiesService.updateSettings(body, user);
  }

  // Read-only, broader than Company Admin (2026-09-07) — the 3D Plan
  // View's cross-aisle spacing is a rendering input every MASTER_DATA_
  // READ_ROLES tier can view alongside the Locations page itself, not
  // just the tier that can edit it. See CompaniesService.getLayoutSettings.
  @Get('layout-settings')
  @Roles(...MASTER_DATA_READ_ROLES)
  getLayoutSettings(@CurrentUser() user: any) {
    return this.companiesService.getLayoutSettings(user);
  }

  @Patch('settings/erp-api-key/regenerate')
  @Roles('COMPANY_ADMIN')
  regenerateErpApiKey(@CurrentUser() user: any) {
    return this.companiesService.regenerateErpApiKey(user);
  }
}
