import { Body, Controller, Get, Post } from '@nestjs/common';
import { WarehousesService } from './warehouses.service';

@Controller('warehouses')
export class WarehousesController {
  constructor(private readonly warehousesService: WarehousesService) {}

  @Post()
  create(@Body() body: { code: string; name: string; address?: string }) {
    return this.warehousesService.create(body);
  }

  @Get()
  findAll() {
    return this.warehousesService.findAll();
  }
}
