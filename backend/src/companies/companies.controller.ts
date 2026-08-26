import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { CompaniesService } from './companies.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';

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
}
