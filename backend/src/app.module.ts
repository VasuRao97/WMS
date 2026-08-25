import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { WarehousesModule } from './warehouses/warehouses.module';
import { SkusModule } from './skus/skus.module';
import { AuthModule } from './auth/auth.module';
import { CustomersModule } from './customers/customers.module';
import { ProductCategoriesModule } from './product-categories/product-categories.module';
import { UsersModule } from './users/users.module';
import { LocationsModule } from './locations/locations.module';
import { YardGateModule } from './yard-gate/yard-gate.module';
import { VehiclesModule } from './vehicles/vehicles.module';
import { DriversModule } from './drivers/drivers.module';
import { VehicleTypesModule } from './vehicle-types/vehicle-types.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    WarehousesModule,
    SkusModule,
    AuthModule,
    CustomersModule,
    ProductCategoriesModule,
    UsersModule,
    LocationsModule,
    YardGateModule,
    VehiclesModule,
    DriversModule,
    VehicleTypesModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}