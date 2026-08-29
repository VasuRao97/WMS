import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ownWarehouseIds, WAREHOUSE_SCOPED_ROLES } from '../common/tenant.util';
import { RACK_STORAGE_TYPES, laneKeyOf } from '../common/rack-name.util';

const ABC_CLASSES = ['A', 'B', 'C'] as const;

// The Insights module — a new, deliberately standalone reporting surface
// (2026-08-29), not folded into Locations/Putaway/Warehouses. Started with
// one report: per-ABC-class storage utilization ("of the space we've
// actually put A-class stock into, how full is it really") — the client's
// own framing, meant to surface real storage-strategy decisions ("if A's
// utilization is very poor..."), not just a debug aid. See
// [[wms-putaway-design]] in memory for the design conversation.
@Injectable()
export class InsightsService {
  constructor(private prisma: PrismaService) {}

  // Scoped to exactly the same location set suggestBin() itself considers
  // (ACTUAL_STORAGE, rack storage types only — SPR/Drive-in/ASRS) — this
  // report is meant to answer "how well is Putaway using the space it's
  // allowed to use," so it has to look at the identical universe Putaway's
  // own placement logic does. Ground/Floor and Stillage are deliberately
  // excluded — they don't have this lane/depth model at all, and their own
  // multi-position Putaway logic is still deferred (see the open list in
  // [[wms-putaway-design]]).
  async storageUtilization(user: any, warehouseId: string) {
    if (!warehouseId) throw new BadRequestException('warehouseId is required.');
    const warehouse = await this.prisma.warehouse.findUnique({ where: { id: warehouseId } });
    if (!warehouse) throw new NotFoundException('Warehouse not found.');
    if (user.role !== 'SUPER_ADMIN' && warehouse.companyId !== user.companyId) {
      throw new ForbiddenException('You do not have access to this warehouse.');
    }
    // An explicit warehouseId is checked against the caller's own
    // accessible set before being trusted — same real bug class
    // YardService.tracker() and Vehicle/DriverService already had to fix
    // once, avoided proactively here.
    if (WAREHOUSE_SCOPED_ROLES.includes(user.role)) {
      const ids = await ownWarehouseIds(this.prisma, user.userId);
      if (!ids.includes(warehouseId)) throw new ForbiddenException('You do not have access to this warehouse.');
    }

    const locations = await this.prisma.location.findMany({
      where: { warehouseId, zoneType: 'ACTUAL_STORAGE', storageType: { in: RACK_STORAGE_TYPES }, isActive: true },
      select: { id: true, storageType: true, aisle: true, rack: true, level: true, flankNumber: true },
    });

    const totals: Record<string, { lanesUsed: number; binsAllotted: number; binsUsed: number }> = {
      A: { lanesUsed: 0, binsAllotted: 0, binsUsed: 0 },
      B: { lanesUsed: 0, binsAllotted: 0, binsUsed: 0 },
      C: { lanesUsed: 0, binsAllotted: 0, binsUsed: 0 },
    };

    if (locations.length > 0) {
      const locationIds = locations.map((l) => l.id);
      const movements = await this.prisma.stockMovement.findMany({
        where: { locationId: { in: locationIds } },
        select: { locationId: true, skuId: true, quantity: true },
      });

      // Current on-hand balance per (location, sku) — "always derive,
      // never store an occupancy flag" philosophy, same as everywhere
      // else in this codebase. Only real, currently-completed stock
      // counts here (unlike suggestBin(), a pending/in-flight task
      // reservation deliberately does NOT count as "used" for a
      // utilization snapshot — this reports actual physical state).
      const balanceByLoc = new Map<string, Map<string, number>>();
      for (const m of movements) {
        if (!balanceByLoc.has(m.locationId)) balanceByLoc.set(m.locationId, new Map());
        const inner = balanceByLoc.get(m.locationId)!;
        inner.set(m.skuId, (inner.get(m.skuId) || 0) + Number(m.quantity));
      }
      const occupantSkuIdsByLoc = new Map<string, string[]>();
      const allOccupantSkuIds = new Set<string>();
      for (const [locId, bySku] of balanceByLoc) {
        const occupants = [...bySku.entries()].filter(([, qty]) => qty > 0).map(([skuId]) => skuId);
        if (occupants.length > 0) {
          occupantSkuIdsByLoc.set(locId, occupants);
          occupants.forEach((id) => allOccupantSkuIds.add(id));
        }
      }

      const skus = allOccupantSkuIds.size > 0
        ? await this.prisma.sku.findMany({ where: { id: { in: [...allOccupantSkuIds] } }, select: { id: true, abcClass: true } })
        : [];
      // Unclassified SKU defaults to C, same convention suggestBin() itself
      // already uses ("unclassified defaults to C — confirmed 2026-08-28").
      const classBySkuId = new Map(skus.map((s) => [s.id, (s.abcClass || 'C').toUpperCase()]));

      const lanes = new Map<string, typeof locations>();
      for (const loc of locations) {
        const key = laneKeyOf(loc as any);
        if (!lanes.has(key)) lanes.set(key, []);
        lanes.get(key)!.push(loc);
      }

      for (const laneLocations of lanes.values()) {
        const occupiedLocIds = laneLocations.filter((l) => occupantSkuIdsByLoc.has(l.id)).map((l) => l.id);
        // Empty lane (no occupant anywhere in it) — excluded entirely, per
        // the client's explicit call ("if a lane doesn't have anything,
        // currently exclude it"), not counted as 0% under any class.
        if (occupiedLocIds.length === 0) continue;

        // Which ABC class(es) this lane's real occupants belong to —
        // normally exactly one (A/B are single-SKU-exclusive by cap; a
        // multi-occupant C lane is still all-C). More than one class can
        // only happen via an active MultiSkuLaneException bypass — a rare
        // edge case deliberately left unhandled for now ("not yet," per
        // the client): such a lane's bins get counted under EVERY class
        // present, a known, flagged v1 simplification that can very
        // slightly double-count in that one rare scenario.
        const classesPresent = new Set<string>();
        for (const locId of occupiedLocIds) {
          for (const skuId of occupantSkuIdsByLoc.get(locId)!) {
            classesPresent.add(classBySkuId.get(skuId) || 'C');
          }
        }

        for (const cls of classesPresent) {
          if (!totals[cls]) continue; // defensive — abcClass should only ever be A/B/C
          totals[cls].lanesUsed += 1;
          totals[cls].binsAllotted += laneLocations.length;
          totals[cls].binsUsed += occupiedLocIds.length;
        }
      }
    }

    return {
      warehouseId,
      warehouseCode: warehouse.code,
      classes: ABC_CLASSES.map((cls) => {
        const t = totals[cls];
        return {
          abcClass: cls,
          lanesUsed: t.lanesUsed,
          binsAllotted: t.binsAllotted,
          binsUsed: t.binsUsed,
          utilizationPct: t.binsAllotted > 0 ? Math.round((t.binsUsed / t.binsAllotted) * 1000) / 10 : null,
        };
      }),
    };
  }
}
