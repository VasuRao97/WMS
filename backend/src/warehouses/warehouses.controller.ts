import { Body, Controller, Delete, Get, Post, UseGuards } from '@nestjs/common';
import { WarehousesService } from './warehouses.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';

@Controller('warehouses')
@UseGuards(JwtAuthGuard)
export class WarehousesController {
  constructor(private readonly warehousesService: WarehousesService) {}

  @Post()
  create(@Body() body: { code: string; name: string; address?: string }, @CurrentUser() user: any) {
    return this.warehousesService.create(body, user);
  }

  @Get()
  findAll(@CurrentUser() user: any) {
    return this.warehousesService.findAll(user);
  }

  @Get('customer-summary')
  getCustomerSummary(@CurrentUser() user: any) {
    return this.warehousesService.getCustomerSummary(user);
  }

  @Delete('all')
  removeAll(@CurrentUser() user: any) {
    return this.warehousesService.removeAll(user);
  }
}