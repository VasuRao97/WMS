import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { InboundReceiptsService } from './inbound-receipts.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { INBOUND_READ_ROLES, INBOUND_ORDER_WRITE_ROLES, INBOUND_APPROVE_ROLES } from '../common/tenant.util';

@Controller('inbound-receipts')
@UseGuards(JwtAuthGuard, RolesGuard)
export class InboundReceiptsController {
  constructor(private readonly inboundReceiptsService: InboundReceiptsService) {}

  // The "order maker" — see InboundReceiptsService's class comment.
  @Post()
  @Roles(...INBOUND_ORDER_WRITE_ROLES)
  create(@Body() body: any, @CurrentUser() user: any) {
    return this.inboundReceiptsService.create(body, user);
  }

  @Get()
  @Roles(...INBOUND_READ_ROLES)
  findAll(@CurrentUser() user: any) {
    return this.inboundReceiptsService.findAll(user);
  }

  @Get(':id')
  @Roles(...INBOUND_READ_ROLES)
  findOne(@Param('id') id: string, @CurrentUser() user: any) {
    return this.inboundReceiptsService.findOne(id, user);
  }

  // Route declared with a literal 'scans' segment before the more generic
  // GET ':id' above never conflicts here since these are PATCH, not GET —
  // still keeping the specific-before-generic convention this codebase
  // uses everywhere (see WarehousesController's Delete All route ordering
  // note) in case another GET ever gets added under this same prefix.
  @Patch('scans/:scanId/approve')
  @Roles(...INBOUND_APPROVE_ROLES)
  approveScan(@Param('scanId') scanId: string, @Body() body: any, @CurrentUser() user: any) {
    return this.inboundReceiptsService.approveScan(scanId, body, user);
  }

  @Patch('scans/:scanId/reject')
  @Roles(...INBOUND_APPROVE_ROLES)
  rejectScan(@Param('scanId') scanId: string, @CurrentUser() user: any) {
    return this.inboundReceiptsService.rejectScan(scanId, user);
  }
}
