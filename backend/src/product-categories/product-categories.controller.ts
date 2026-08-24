import { Controller, Get, UseGuards } from '@nestjs/common';
import { ProductCategoriesService } from './product-categories.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('product-categories')
@UseGuards(JwtAuthGuard)
export class ProductCategoriesController {
  constructor(private readonly productCategoriesService: ProductCategoriesService) {}

  @Get()
  findAll() {
    return this.productCategoriesService.findAll();
  }
}
