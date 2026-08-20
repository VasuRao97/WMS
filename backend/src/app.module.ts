import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { WarehousesModule } from './warehouses/warehouses.module';

@Module({
  imports: [WarehousesModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
