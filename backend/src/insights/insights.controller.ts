import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { InsightsService } from './insights.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { MASTER_DATA_READ_ROLES } from '../common/tenant.util';

@Controller('insights')
@UseGuards(JwtAuthGuard, RolesGuard)
export class InsightsController {
  constructor(private readonly insightsService: InsightsService) {}

  @Get('storage-utilization')
  @Roles(...MASTER_DATA_READ_ROLES)
  storageUtilization(@Query('warehouseId') warehouseId: string, @CurrentUser() user: any) {
    return this.insightsService.storageUtilization(user, warehouseId);
  }
}
