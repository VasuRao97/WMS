import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { PickTasksService } from './pick-tasks.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import {
  type AuthUser,
  PICK_EXCEPTION_REVIEW_ROLES,
  PICK_EXECUTE_ROLES,
} from '../common/tenant.util';

@Controller('pick-tasks')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PickTasksController {
  constructor(private readonly pickTasksService: PickTasksService) {}

  @Get()
  @Roles(...PICK_EXECUTE_ROLES)
  findAll(
    @Query('warehouseId') warehouseId: string | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    return this.pickTasksService.findAll(user, warehouseId || undefined);
  }

  // Operator assignment fairness (2026-09-14 gap-fix pass, item 3) — who
  // should go next and where the real priority is. Read-only;
  // PickAssignmentScheduler fires the actual alerts/escalations on a timer.
  @Get('recommendation')
  @Roles(...PICK_EXECUTE_ROLES)
  getRecommendation(
    @Query('warehouseId') warehouseId: string | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    return this.pickTasksService.getRecommendation(
      user,
      warehouseId || undefined,
    );
  }

  // Mid-pick exceptions (item 4) — Supervisor+ review list. Declared ahead
  // of the ':id/retry-source'-style dynamic routes below purely for
  // readability; 'exceptions' as a literal first segment never collides
  // with a single ':id' param the way a bare '/all'-style route can (see
  // CLAUDE.md's "Every master-data entity gets a Delete All" route-order
  // note) since every dynamic segment here is followed by its own literal
  // suffix, not bare.
  @Get('exceptions')
  @Roles(...PICK_EXCEPTION_REVIEW_ROLES)
  getExceptions(
    @Query('warehouseId') warehouseId: string | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    return this.pickTasksService.getExceptions(user, warehouseId || undefined);
  }

  @Patch('exceptions/:id/review')
  @Roles(...PICK_EXCEPTION_REVIEW_ROLES)
  reviewException(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.pickTasksService.reviewException(id, user);
  }

  @Post('claim')
  @Roles(...PICK_EXECUTE_ROLES)
  claimTrip(
    @Body('warehouseId') warehouseId: any,
    @CurrentUser() user: AuthUser,
  ) {
    return this.pickTasksService.claimTrip(user, warehouseId || undefined);
  }

  @Post('trips/:tripId/complete')
  @Roles(...PICK_EXECUTE_ROLES)
  completeTrip(
    @Param('tripId') tripId: string,
    @Body() body: any,
    @CurrentUser() user: AuthUser,
  ) {
    return this.pickTasksService.completeTrip(tripId, body, user);
  }

  // Short-stock retry (item 1) — same role tier as claim/complete, matching
  // Putaway's own broad access to "Request Different Bin."
  @Post(':id/retry-source')
  @Roles(...PICK_EXECUTE_ROLES)
  retryTaskSource(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.pickTasksService.retryTaskSource(id, user);
  }

  // Mid-pick exception report (item 4) — the scanning operator reporting
  // their own problem, same tier as claim/complete/retry-source (reviewing
  // one out is the tier above, see PICK_EXCEPTION_REVIEW_ROLES above).
  @Post('trips/:tripId/exception')
  @Roles(...PICK_EXECUTE_ROLES)
  reportException(
    @Param('tripId') tripId: string,
    @Body() body: any,
    @CurrentUser() user: AuthUser,
  ) {
    return this.pickTasksService.reportException(tripId, body, user);
  }
}
