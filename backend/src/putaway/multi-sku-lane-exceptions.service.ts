import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { companyFilter, ownWarehouseIds } from '../common/tenant.util';

const EXCEPTION_INCLUDE = {
  warehouse: { select: { id: true, code: true, name: true } },
  requestedBy: { select: { id: true, name: true } },
  reviewedBy: { select: { id: true, name: true } },
  revokedBy: { select: { id: true, name: true } },
} as const;

// The only bypass for the mandatory single-SKU-per-multi-deep-lane rule
// (2026-08-28, skeleton logic — see [[wms-putaway-design]] in memory) — a
// real request/approve/revoke audit record, not a self-service toggle.
// Requested only by a WAREHOUSE_MANAGER, decided only by a COMPANY_ADMIN —
// "so both the local and HO team knows there is a problem." Warehouse-wide
// scope, no auto-expiry (stays in force until explicitly revoked).
@Injectable()
export class MultiSkuLaneExceptionsService {
  constructor(private prisma: PrismaService) {}

  private async assertWarehouseAccess(warehouseId: string, user: any) {
    const warehouse = await this.prisma.warehouse.findUnique({ where: { id: warehouseId } });
    if (!warehouse) throw new NotFoundException('Warehouse not found.');
    if (user.role !== 'SUPER_ADMIN' && warehouse.companyId !== user.companyId) throw new ForbiddenException('You do not have access to this warehouse.');
    return warehouse;
  }

  // WAREHOUSE_MANAGER only, per the client's explicit design — the request
  // has to come from the local team, never initiated by HO unprompted.
  async create(data: any, user: any) {
    if (!data.warehouseId) throw new BadRequestException('Warehouse is required.');
    await this.assertWarehouseAccess(data.warehouseId, user);
    if (!data.reason || !String(data.reason).trim()) throw new BadRequestException('A reason is required.');

    const scopedIds = await ownWarehouseIds(this.prisma, user.userId);
    if (!scopedIds.includes(data.warehouseId)) throw new ForbiddenException('You can only request this for your own assigned warehouse(s).');

    const existingActive = await this.prisma.multiSkuLaneException.findFirst({ where: { warehouseId: data.warehouseId, status: { in: ['PENDING', 'APPROVED'] } } });
    if (existingActive) throw new BadRequestException(`This warehouse already has ${existingActive.status === 'PENDING' ? 'a pending request' : 'an active exception'} — resolve it before submitting a new one.`);

    return this.prisma.multiSkuLaneException.create({
      data: { warehouseId: data.warehouseId, reason: String(data.reason).trim(), requestedById: user.userId },
      include: EXCEPTION_INCLUDE,
    });
  }

  // Visible to both sides — the Warehouse Manager checking their own
  // request's status, and Company Admin reviewing what's pending, per "so
  // both the local and HO team knows there is a problem."
  async findAll(user: any, warehouseId?: string) {
    const where: any = { warehouse: { ...companyFilter(user) } };
    if (warehouseId) where.warehouseId = warehouseId;
    return this.prisma.multiSkuLaneException.findMany({ where, include: EXCEPTION_INCLUDE, orderBy: { requestedAt: 'desc' } });
  }

  private async assertAccess(id: string, user: any) {
    const exception = await this.prisma.multiSkuLaneException.findUnique({ where: { id }, include: { warehouse: true } });
    if (!exception) throw new NotFoundException('Request not found.');
    if (user.role !== 'SUPER_ADMIN' && exception.warehouse.companyId !== user.companyId) throw new ForbiddenException('You do not have access to this request.');
    return exception;
  }

  // COMPANY_ADMIN only — the client's explicit design, never the
  // Warehouse Manager who raised it.
  async approve(id: string, reviewNote: any, user: any) {
    const exception = await this.assertAccess(id, user);
    if (exception.status !== 'PENDING') throw new BadRequestException('Only a pending request can be approved.');
    return this.prisma.multiSkuLaneException.update({
      where: { id },
      data: { status: 'APPROVED', reviewedById: user.userId, reviewedAt: new Date(), reviewNote: reviewNote ? String(reviewNote).trim() : undefined },
      include: EXCEPTION_INCLUDE,
    });
  }

  async reject(id: string, reviewNote: any, user: any) {
    const exception = await this.assertAccess(id, user);
    if (exception.status !== 'PENDING') throw new BadRequestException('Only a pending request can be rejected.');
    return this.prisma.multiSkuLaneException.update({
      where: { id },
      data: { status: 'REJECTED', reviewedById: user.userId, reviewedAt: new Date(), reviewNote: reviewNote ? String(reviewNote).trim() : undefined },
      include: EXCEPTION_INCLUDE,
    });
  }

  // No auto-expiry, confirmed — an approved exception stays in force until
  // a COMPANY_ADMIN explicitly revokes it.
  async revoke(id: string, user: any) {
    const exception = await this.assertAccess(id, user);
    if (exception.status !== 'APPROVED') throw new BadRequestException('Only an approved exception can be revoked.');
    return this.prisma.multiSkuLaneException.update({
      where: { id },
      data: { status: 'REVOKED', revokedById: user.userId, revokedAt: new Date() },
      include: EXCEPTION_INCLUDE,
    });
  }
}
