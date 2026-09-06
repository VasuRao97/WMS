import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { PickFaceTasksService } from './pick-face-tasks.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { PUTAWAY_EXECUTE_ROLES } from '../common/tenant.util';

// Pick Face (SPR only, 2026-09-05 — see [[wms-putaway-design]] in memory for
// the full design conversation). Same execution role tier as Putaway — this
// is the exact same operator-floor discipline (scan to claim, scan the
// destination to complete), just for an internal reserve<->pick-face move
// instead of a receipt-driven one. Tasks themselves are only ever created by
// PickFaceReplenishmentScheduler's own daily run, never through this
// controller.
@Controller('pick-face-tasks')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PickFaceTasksController {
  constructor(private readonly pickFaceTasksService: PickFaceTasksService) {}

  @Get()
  @Roles(...PUTAWAY_EXECUTE_ROLES)
  findAll(@CurrentUser() user: any, @Query('warehouseId') warehouseId?: string) {
    return this.pickFaceTasksService.findAll(user, warehouseId);
  }

  // The source scan — claims one trip against the oldest workable task for
  // whatever SKU the barcode resolves to.
  @Post('claim')
  @Roles(...PUTAWAY_EXECUTE_ROLES)
  claim(@Body('barcode') barcode: string, @CurrentUser() user: any) {
    return this.pickFaceTasksService.claimTrip(barcode, user);
  }

  // Destination scan — completes the trip. Only the operator who claimed it
  // can complete it; only a matching location scan is ever accepted.
  @Patch('trips/:tripId/complete')
  @Roles(...PUTAWAY_EXECUTE_ROLES)
  complete(@Param('tripId') tripId: string, @Body('locationCode') locationCode: string, @CurrentUser() user: any) {
    return this.pickFaceTasksService.completeTrip(tripId, locationCode, user);
  }
}
