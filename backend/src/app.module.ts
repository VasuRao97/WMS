import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { WarehousesModule } from './warehouses/warehouses.module';
import { SkusModule } from './skus/skus.module';

@Module({
  imports: [WarehousesModule, SkusModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}