import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { MASTER_DATA_READ_ROLES } from '../common/tenant.util';

@Controller('analytics')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Get('operator-productivity')
  @Roles(...MASTER_DATA_READ_ROLES)
  operatorProductivity(@Query('warehouseId') warehouseId: string, @CurrentUser() user: any) {
    return this.analyticsService.operatorProductivity(user, warehouseId || undefined);
  }
}
