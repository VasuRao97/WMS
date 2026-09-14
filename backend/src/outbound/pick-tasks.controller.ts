import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { PickTasksService } from './pick-tasks.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { type AuthUser, PICK_EXECUTE_ROLES } from '../common/tenant.util';

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
}
