import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { type AuthUser, MASTER_DATA_READ_ROLES } from '../common/tenant.util';

@Controller('analytics')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Get('operator-productivity')
  @Roles(...MASTER_DATA_READ_ROLES)
  operatorProductivity(
    @Query('warehouseId') warehouseId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.analyticsService.operatorProductivity(
      user,
      warehouseId || undefined,
    );
  }

  // Daily inward volume (units + pallets) — warehouseId optional
  // (company-wide for COMPANY_ADMIN/SUPER_ADMIN when omitted, enforced in
  // the service); from/to are plain YYYY-MM-DD strings, both optional
  // (default: the last 30 days).
  @Get('daily-inward')
  @Roles(...MASTER_DATA_READ_ROLES)
  dailyInward(
    @Query('warehouseId') warehouseId: string | undefined,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    return this.analyticsService.dailyInward(
      user,
      warehouseId || undefined,
      from || undefined,
      to || undefined,
    );
  }
}
