import { Module } from '@nestjs/common';
import { ProductCategoriesController } from './product-categories.controller';
import { ProductCategoriesService } from './product-categories.service';
import { PrismaService } from '../prisma/prisma.service';

@Module({
  controllers: [ProductCategoriesController],
  providers: [ProductCategoriesService, PrismaService],
})
export class ProductCategoriesModule {}
