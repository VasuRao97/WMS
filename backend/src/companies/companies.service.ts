import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

// The first Company-settings surface this project has ever had (2026-08-27)
// — every other per-company toggle (E-Way Bill requirement, yard-full
// blocking, gate pass reset period, security-supervisor-only gate access)
// still has no endpoint/UI at all; only detention and (2026-08-27, ERP
// push) the ERP toggle/API key do. Deliberately scoped narrow rather than
// building a do-everything Company Settings page in one shot — extend this
// same module when those other toggles get their own UI, don't build a
// second place for it.
@Injectable()
export class CompaniesService {
  constructor(private prisma: PrismaService) {}

  private requireCompany(user: any): string {
    if (!user.companyId) {
      throw new ForbiddenException('Super admin accounts have no single company to configure settings for.');
    }
    return user.companyId;
  }

  async getSettings(user: any) {
    const companyId = this.requireCompany(user);
    return this.prisma.company.findUnique({
      where: { id: companyId },
      select: {
        id: true,
        name: true,
        detentionCostPerDay: true,
        detentionFreeHours: true,
        detentionAlertHours: true,
        detentionEscalationHours: true,
        allowErpInboundPush: true,
        erpApiKey: true,
        putawayTriggerMode: true,
        putawayDefaultBatchQty: true,
        defaultMaxCasesPerPallet: true,
      },
    });
  }

  async updateSettings(data: any, user: any) {
    const companyId = this.requireCompany(user);
    const errors: string[] = [];

    for (const [field, label] of [
      ['detentionCostPerDay', 'Detention Cost Per Day'],
      ['detentionAlertHours', 'Detention Alert Hours'],
      ['detentionEscalationHours', 'Detention Escalation Hours'],
    ] as const) {
      const v = data[field];
      if (v !== undefined && v !== null && v !== '' && Number(v) <= 0) {
        errors.push(`${label} must be a positive number when given.`);
      }
    }
    // Free Hours is the one field where 0 is a legitimate, meaningful value
    // (a company deciding it wants no grace period at all) — allowed down
    // to 0, unlike the strictly-positive fields above.
    if (data.detentionFreeHours !== undefined && data.detentionFreeHours !== null && data.detentionFreeHours !== '' && Number(data.detentionFreeHours) < 0) {
      errors.push('Detention Free Hours cannot be negative.');
    }
    // Putaway trigger mode (2026-08-28, wiring the real toggle for the
    // first time — the schema field/logic have existed since the Putaway
    // build itself, but had no settings endpoint touching them at all).
    if (data.putawayTriggerMode !== undefined && data.putawayTriggerMode !== null && !['BATCH', 'IMMEDIATE'].includes(data.putawayTriggerMode)) {
      errors.push('Putaway Trigger Mode must be BATCH or IMMEDIATE.');
    }
    if (data.putawayDefaultBatchQty !== undefined && data.putawayDefaultBatchQty !== null && data.putawayDefaultBatchQty !== '' && Number(data.putawayDefaultBatchQty) <= 0) {
      errors.push('Putaway Default Batch Qty must be a positive number when given.');
    }
    // Pallet consolidation (2026-09-01) — same override-then-fall-back-to-
    // company-default chain as putawayDefaultBatchQty above.
    if (data.defaultMaxCasesPerPallet !== undefined && data.defaultMaxCasesPerPallet !== null && data.defaultMaxCasesPerPallet !== '' && Number(data.defaultMaxCasesPerPallet) <= 0) {
      errors.push('Default Max Cases Per Pallet must be a positive number when given.');
    }
    if (errors.length > 0) throw new BadRequestException(errors);

    return this.prisma.company.update({
      where: { id: companyId },
      data: {
        // Explicit null (not just omitted) clears a field back to
        // "unconfigured" — e.g. a company deciding it doesn't want
        // detention alerting at all sends detentionAlertHours: null,
        // distinct from leaving the key out of the request entirely.
        detentionCostPerDay: data.detentionCostPerDay === undefined ? undefined : data.detentionCostPerDay === null || data.detentionCostPerDay === '' ? null : Number(data.detentionCostPerDay),
        detentionFreeHours: data.detentionFreeHours === undefined ? undefined : data.detentionFreeHours === null || data.detentionFreeHours === '' ? null : Number(data.detentionFreeHours),
        detentionAlertHours: data.detentionAlertHours === undefined ? undefined : data.detentionAlertHours === null || data.detentionAlertHours === '' ? null : Number(data.detentionAlertHours),
        detentionEscalationHours: data.detentionEscalationHours === undefined ? undefined : data.detentionEscalationHours === null || data.detentionEscalationHours === '' ? null : Number(data.detentionEscalationHours),
        // 2026-08-27, ERP push — a plain boolean toggle, same "omitted
        // means unchanged" convention as everything else here.
        allowErpInboundPush: data.allowErpInboundPush === undefined ? undefined : !!data.allowErpInboundPush,
        // Putaway (2026-08-28) — same "omitted means unchanged, explicit
        // null clears it back to unconfigured" convention as detention.
        // putawayTriggerMode has no real "unconfigured" state (it's a
        // required enum with a DB default), so an empty/null value here is
        // simply ignored (left unchanged) rather than attempted as a clear.
        putawayTriggerMode: data.putawayTriggerMode ? data.putawayTriggerMode : undefined,
        putawayDefaultBatchQty: data.putawayDefaultBatchQty === undefined ? undefined : data.putawayDefaultBatchQty === null || data.putawayDefaultBatchQty === '' ? null : Number(data.putawayDefaultBatchQty),
        defaultMaxCasesPerPallet: data.defaultMaxCasesPerPallet === undefined ? undefined : data.defaultMaxCasesPerPallet === null || data.defaultMaxCasesPerPallet === '' ? null : Number(data.defaultMaxCasesPerPallet),
      },
      select: {
        id: true,
        name: true,
        detentionCostPerDay: true,
        detentionFreeHours: true,
        detentionAlertHours: true,
        detentionEscalationHours: true,
        allowErpInboundPush: true,
        erpApiKey: true,
        putawayTriggerMode: true,
        putawayDefaultBatchQty: true,
        defaultMaxCasesPerPallet: true,
      },
    });
  }

  // Generates a brand-new key, overwriting any existing one (2026-08-27,
  // ERP push) — deliberately no "reveal old key" path, matching how an API
  // key is normally handled elsewhere (you regenerate, you don't recover).
  // Plain random hex, stored as plain text (no encryption-at-rest in this
  // project yet, same flagged simplification as schema.prisma's comment on
  // Company.erpApiKey) — a COMPANY_ADMIN needs to actually read this value
  // back out to configure their ERP with it, so it isn't hashed/masked.
  async regenerateErpApiKey(user: any) {
    const companyId = this.requireCompany(user);
    const erpApiKey = randomBytes(24).toString('hex');
    return this.prisma.company.update({
      where: { id: companyId },
      data: { erpApiKey },
      select: { id: true, erpApiKey: true },
    });
  }
}
