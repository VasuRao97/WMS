import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { PutawayTasksService } from './putaway-tasks.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { PUTAWAY_EXECUTE_ROLES } from '../common/tenant.util';

// Putaway task queue + scan-driven execution (2026-08-28, skeleton logic —
// see [[wms-putaway-design]] in memory for the full design conversation).
// Same role tier as Inbound's own scanning work — this is its direct
// continuation (staging -> bin).
@Controller('putaway-tasks')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PutawayTasksController {
  constructor(private readonly putawayTasksService: PutawayTasksService) {}

  @Get()
  @Roles(...PUTAWAY_EXECUTE_ROLES)
  findAll(@CurrentUser() user: any, @Query('warehouseId') warehouseId?: string) {
    return this.putawayTasksService.findAll(user, warehouseId);
  }

  // Staging scan — claims one trip against the oldest workable task for
  // whatever SKU the barcode resolves to.
  @Post('claim')
  @Roles(...PUTAWAY_EXECUTE_ROLES)
  claim(@Body('barcode') barcode: string, @CurrentUser() user: any) {
    return this.putawayTasksService.claimTrip(barcode, user);
  }

  // Location scan — completes the trip. Only the operator who claimed it
  // can complete it; only a matching location scan is ever accepted.
  @Patch('trips/:tripId/complete')
  @Roles(...PUTAWAY_EXECUTE_ROLES)
  complete(@Param('tripId') tripId: string, @Body('locationCode') locationCode: string, @CurrentUser() user: any) {
    return this.putawayTasksService.completeTrip(tripId, locationCode, user);
  }

  @Patch(':id/request-different-bin')
  @Roles(...PUTAWAY_EXECUTE_ROLES)
  requestDifferentBin(@Param('id') id: string, @Body('reason') reason: string, @CurrentUser() user: any) {
    return this.putawayTasksService.requestDifferentBin(id, reason, user);
  }
}
