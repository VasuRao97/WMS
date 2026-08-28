import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';

// Abandoned-claim cleanup (2026-08-28, skeleton logic — see
// [[wms-putaway-design]] in memory) — a trip claimed at the staging scan
// but never completed with a location scan (operator distracted, device
// died, shift ended) auto-expires to ABANDONED after a timeout, freeing
// that trip's quantity back up for anyone to reclaim. Placeholder timeout
// (30 minutes) — the client didn't specify an exact number, only that it
// should be automatic; adjust here if that turns out wrong in practice.
const CLAIM_TIMEOUT_MINUTES = 30;

@Injectable()
export class PutawayClaimExpiryScheduler {
  private readonly logger = new Logger(PutawayClaimExpiryScheduler.name);

  constructor(private prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async expireAbandonedClaims() {
    const cutoff = new Date(Date.now() - CLAIM_TIMEOUT_MINUTES * 60 * 1000);
    const result = await this.prisma.putawayTrip.updateMany({
      where: { status: 'IN_PROGRESS', claimedAt: { lt: cutoff } },
      data: { status: 'ABANDONED' },
    });
    if (result.count > 0) this.logger.log(`Expired ${result.count} abandoned Putaway claim(s) older than ${CLAIM_TIMEOUT_MINUTES} minutes.`);
  }
}
