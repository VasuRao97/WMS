import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { OutboundOrdersService } from './outbound-orders.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import {
  type AuthUser,
  OUTBOUND_ALLOT_ROLES,
  OUTBOUND_ORDER_WRITE_ROLES,
  OUTBOUND_READ_ROLES,
} from '../common/tenant.util';

@Controller('outbound-orders')
@UseGuards(JwtAuthGuard, RolesGuard)
export class OutboundOrdersController {
  constructor(private readonly outboundOrdersService: OutboundOrdersService) {}

  @Post()
  @Roles(...OUTBOUND_ORDER_WRITE_ROLES)
  create(@Body() data: any, @CurrentUser() user: AuthUser) {
    return this.outboundOrdersService.create(data, user);
  }

  @Get()
  @Roles(...OUTBOUND_READ_ROLES)
  findAll(
    @Query('warehouseId') warehouseId: string | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    return this.outboundOrdersService.findAll(user, warehouseId || undefined);
  }

  @Get(':id')
  @Roles(...OUTBOUND_READ_ROLES)
  findOne(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.outboundOrdersService.findOne(id, user);
  }

  @Get(':id/candidate-vehicles')
  @Roles(...OUTBOUND_ALLOT_ROLES)
  findCandidateVehicles(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.outboundOrdersService.findCandidateVehicles(id, user);
  }

  @Post(':id/allot')
  @Roles(...OUTBOUND_ALLOT_ROLES)
  allot(
    @Param('id') id: string,
    @Body('gateEntryId') gateEntryId: any,
    @CurrentUser() user: AuthUser,
  ) {
    return this.outboundOrdersService.allot(id, gateEntryId, user);
  }
}
