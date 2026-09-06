import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { AbcClassificationService } from './abc-classification.service';

// Monthly ABC reassessment (2026-09-06 — see [[wms-abc-velocity-design]]) —
// "it should be automatic job, lets say 1st of every month in the night,
// so it doesnt take bandwith while actual work is going on." Midnight on
// the 1st of every month, for every company that's opted in via
// Company.abcReassessmentEnabled — off by default, so this is a genuine
// no-op for every company until someone explicitly turns it on.
@Injectable()
export class AbcClassificationScheduler {
  private readonly logger = new Logger(AbcClassificationScheduler.name);

  constructor(
    private prisma: PrismaService,
    private abcClassification: AbcClassificationService,
  ) {}

  @Cron('0 0 1 * *')
  async runMonthlyReassessment() {
    const companies = await this.prisma.company.findMany({ where: { abcReassessmentEnabled: true }, select: { id: true, name: true } });
    for (const company of companies) {
      try {
        const result = await this.abcClassification.reassessCompany(company.id);
        this.logger.log(`ABC reassessment complete for ${company.name}: ${result.warehousesProcessed} warehouse(s) processed.`);
      } catch (e: any) {
        this.logger.error(`ABC reassessment failed for ${company.name}: ${e.message}`);
      }
    }
  }
}
