import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { InboundReceiptsService } from './inbound-receipts.service';
import { ApiKeyGuard } from '../common/api-key.guard';
import { CurrentCompany } from '../common/current-company.decorator';

// ERP push (2026-08-27) — the third way to create an Inbound order,
// alongside the manual order maker and Excel import. A genuinely separate
// controller (not a route bolted onto InboundReceiptsController) because
// its auth is completely different: no JWT, no logged-in User, no
// @Roles() — just a per-company API key. See ApiKeyGuard/CurrentCompany
// for the mechanism, and InboundReceiptsService.erpPush()/assignVehicle()
// for what actually happens: one order per call, no Vehicle required (an
// ERP never knows vehicle details — that gets attached later in WMS via
// InboundReceiptsController's PATCH :id/assign-vehicle).
//
// Payload shape: { warehouseCode, referenceNo, supplierName?, lines: [{
// skuCode, expectedQty }] } — resolved against Warehouse/SKU's normal
// internal Code (not `erpCode`, which is unwired everywhere still — see
// erpPush()'s own comment).
@Controller('erp')
@UseGuards(ApiKeyGuard)
export class ErpInboundController {
  constructor(private readonly inboundReceiptsService: InboundReceiptsService) {}

  @Post('inbound-receipts')
  push(@Body() body: any, @CurrentCompany() company: any) {
    return this.inboundReceiptsService.erpPush(body, company.id);
  }
}
