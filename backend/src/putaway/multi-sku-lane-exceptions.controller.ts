import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { MultiSkuLaneExceptionsService } from './multi-sku-lane-exceptions.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';

// Two named roles by explicit client design, not a broader role-constant
// tier — WAREHOUSE_MANAGER requests, COMPANY_ADMIN alone decides. See
// [[wms-putaway-design]] in memory.
@Controller('multi-sku-lane-exceptions')
@UseGuards(JwtAuthGuard, RolesGuard)
export class MultiSkuLaneExceptionsController {
  constructor(private readonly service: MultiSkuLaneExceptionsService) {}

  @Post()
  @Roles('WAREHOUSE_MANAGER')
  create(@Body() body: any, @CurrentUser() user: any) {
    return this.service.create(body, user);
  }

  @Get()
  @Roles('COMPANY_ADMIN', 'WAREHOUSE_MANAGER')
  findAll(@CurrentUser() user: any, @Query('warehouseId') warehouseId?: string) {
    return this.service.findAll(user, warehouseId);
  }

  @Patch(':id/approve')
  @Roles('COMPANY_ADMIN')
  approve(@Param('id') id: string, @Body('reviewNote') reviewNote: string, @CurrentUser() user: any) {
    return this.service.approve(id, reviewNote, user);
  }

  @Patch(':id/reject')
  @Roles('COMPANY_ADMIN')
  reject(@Param('id') id: string, @Body('reviewNote') reviewNote: string, @CurrentUser() user: any) {
    return this.service.reject(id, reviewNote, user);
  }

  @Patch(':id/revoke')
  @Roles('COMPANY_ADMIN')
  revoke(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.revoke(id, user);
  }
}
