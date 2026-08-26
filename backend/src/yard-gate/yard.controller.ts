import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { YardService } from './yard.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { GATE_YARD_READ_ROLES } from '../common/tenant.util';

@Controller('yard')
@UseGuards(JwtAuthGuard, RolesGuard)
export class YardController {
  constructor(private readonly yardService: YardService) {}

  @Get('summary')
  @Roles(...GATE_YARD_READ_ROLES)
  summary(@CurrentUser() user: any) {
    return this.yardService.summary(user);
  }

  // Renamed from "parked" (2026-08-27) — now covers docked-but-not-gated-out
  // vehicles too, not just ones still waiting in the yard.
  @Get('tracker')
  @Roles(...GATE_YARD_READ_ROLES)
  tracker(@Query('warehouseId') warehouseId: string, @CurrentUser() user: any) {
    return this.yardService.tracker(user, warehouseId);
  }
}
