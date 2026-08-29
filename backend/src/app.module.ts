import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
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
import { NotificationsModule } from './notifications/notifications.module';
import { CompaniesModule } from './companies/companies.module';
import { InboundModule } from './inbound/inbound.module';
import { EquipmentTypesModule } from './equipment-types/equipment-types.module';
import { EquipmentModule } from './equipment/equipment.module';
import { PutawayModule } from './putaway/putaway.module';
import { InsightsModule } from './insights/insights.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // Enables @Cron()/@Interval() decorators anywhere in the app — added
    // 2026-08-27 specifically for DetentionAlertScheduler, the first
    // timer-driven job in this codebase.
    ScheduleModule.forRoot(),
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
    NotificationsModule,
    CompaniesModule,
    InboundModule,
    EquipmentTypesModule,
    EquipmentModule,
    PutawayModule,
    InsightsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}