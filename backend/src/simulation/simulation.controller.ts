import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { SimulationService } from './simulation.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { MASTER_DATA_WRITE_ROLES } from '../common/tenant.util';

// Putaway simulation (2026-09-06 — see [[wms-putaway-design]]) — same role
// tier as generating Locations/managing SKUs, since this writes real
// Location/Sku/StockMovement rows (into the sandbox only, never a real
// warehouse — see SimulationService's own comment for the full design).
@Controller('simulation')
@UseGuards(JwtAuthGuard, RolesGuard)
export class SimulationController {
  constructor(private readonly simulationService: SimulationService) {}

  @Post('sandbox')
  @Roles(...MASTER_DATA_WRITE_ROLES)
  ensureSandbox(@CurrentUser() user: any) {
    return this.simulationService.ensureSandbox(user);
  }

  @Post('sandbox/reset')
  @Roles(...MASTER_DATA_WRITE_ROLES)
  resetSandbox(@CurrentUser() user: any) {
    return this.simulationService.resetSandbox(user);
  }

  @Post('putaway/run')
  @Roles(...MASTER_DATA_WRITE_ROLES)
  runPutaway(@Body('unitCount') unitCount: number, @CurrentUser() user: any) {
    return this.simulationService.runPutawaySimulation(user, unitCount);
  }
}
