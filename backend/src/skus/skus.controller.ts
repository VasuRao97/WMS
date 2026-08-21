import { Body, Controller, Get, Post } from '@nestjs/common';
import { SkusService } from './skus.service';

@Controller('skus')
export class SkusController {
  constructor(private readonly skusService: SkusService) {}

  @Post()
  create(@Body() body: any) {
    return this.skusService.create(body);
  }

  @Get()
  findAll() {
    return this.skusService.findAll();
  }
}