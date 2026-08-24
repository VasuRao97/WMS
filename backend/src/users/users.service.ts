import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { companyFilter, ownWarehouseIds, WAREHOUSE_SCOPED_ROLES } from '../common/tenant.util';
import { EMAIL_REGEX } from '../common/validation.util';
import { normalizeCode } from '../common/normalize.util';

// Who can create/edit which role — a fixed hierarchy for now. This mirrors the
// role-access sheet worked out with the client: COMPANY_ADMIN can create a
// peer (co-admin) as well as everyone below; every other role can only create
// roles strictly below itself. A configurable per-company permission matrix
// (toggle-based, replacing this hardcoded map) was discussed and deliberately
// deferred — see CLAUDE.md's role/access notes once written up.
const CREATABLE_ROLES: Record<string, string[]> = {
  COMPANY_ADMIN: ['COMPANY_ADMIN', 'WAREHOUSE_MANAGER', 'WAREHOUSE_SUPERVISOR', 'OPERATOR'],
  WAREHOUSE_MANAGER: ['WAREHOUSE_SUPERVISOR', 'OPERATOR'],
  WAREHOUSE_SUPERVISOR: ['OPERATOR'],
  OPERATOR: [],
};

const ROLE_VALUES = ['COMPANY_ADMIN', 'WAREHOUSE_MANAGER', 'WAREHOUSE_SUPERVISOR', 'OPERATOR'];

// Shop-floor Supervisor/Operator accounts log in with an arbitrary unique ID,
// not necessarily a real email address — only Admin/Manager accounts are
// required to look like one.
const EMAIL_REQUIRED_ROLES = ['COMPANY_ADMIN', 'WAREHOUSE_MANAGER'];

const SELECT_SAFE = {
  id: true,
  email: true,
  name: true,
  role: true,
  isActive: true,
  functionTag: true,
  createdAt: true,
  lastLoginAt: true,
  assignedWarehouses: { select: { id: true, code: true, name: true } },
};

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  private validate(data: any, targetRole: string): string[] {
    const errors: string[] = [];
    if (!data.name || data.name.trim().length < 2) errors.push('Name is required (min 2 characters).');
    if (!data.email || !data.email.trim()) {
      errors.push('Login ID is required.');
    } else if (EMAIL_REQUIRED_ROLES.includes(targetRole) && !EMAIL_REGEX.test(data.email.trim())) {
      errors.push('Company Admin / Warehouse Manager accounts must log in with a valid email address.');
    }
    if (!ROLE_VALUES.includes(targetRole)) {
      errors.push(`Role must be one of: ${ROLE_VALUES.join(', ')}.`);
    }
    return errors;
  }

  private async resolveWarehouseIds(requestedIds: string[], creator: any, targetRole: string, errors: string[]): Promise<string[]> {
    const ids = Array.from(new Set((requestedIds || []).filter(Boolean)));
    if (targetRole !== 'COMPANY_ADMIN' && ids.length === 0) {
      errors.push('At least one assigned warehouse is required for this role.');
      return [];
    }
    if (ids.length === 0) return [];

    const warehouses = await this.prisma.warehouse.findMany({
      where: { id: { in: ids }, companyId: creator.companyId },
      select: { id: true },
    });
    if (warehouses.length !== ids.length) {
      errors.push('One or more selected warehouses were not found for this company.');
      return [];
    }

    if (creator.role !== 'SUPER_ADMIN' && creator.role !== 'COMPANY_ADMIN') {
      const ownIds = await ownWarehouseIds(this.prisma, creator.userId);
      const outOfScope = ids.filter((id) => !ownIds.includes(id));
      if (outOfScope.length > 0) {
        errors.push('You can only assign warehouses you yourself have access to.');
        return [];
      }
    }
    return ids;
  }

  async create(data: any, creator: any) {
    if (!creator.companyId) {
      throw new ForbiddenException('Super admin accounts cannot create users directly — log in as a company admin instead.');
    }
    const targetRole = data.role;
    const creatable = CREATABLE_ROLES[creator.role] || [];
    if (!creatable.includes(targetRole)) {
      throw new ForbiddenException(`Your role (${creator.role}) cannot create a user with role ${targetRole}.`);
    }

    const errors = this.validate(data, targetRole);
    if (!data.password || String(data.password).length < 6) {
      errors.push('Password is required and must be at least 6 characters.');
    }
    const warehouseIds = await this.resolveWarehouseIds(data.assignedWarehouseIds, creator, targetRole, errors);
    if (errors.length > 0) throw new BadRequestException(errors);

    const email = data.email.trim();
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) throw new BadRequestException(`Login ID "${email}" is already in use.`);

    const passwordHash = await bcrypt.hash(data.password, 10);

    return this.prisma.user.create({
      data: {
        email,
        passwordHash,
        name: data.name.trim(),
        role: targetRole,
        functionTag: data.functionTag || undefined,
        company: { connect: { id: creator.companyId } },
        assignedWarehouses: warehouseIds.length ? { connect: warehouseIds.map((id) => ({ id })) } : undefined,
      },
      select: SELECT_SAFE,
    });
  }

  /** Comma/semicolon-separated Warehouse Codes from an Excel cell → resolved ids, scope-checked the same way a manual create's ids are. */
  private async resolveWarehouseCodesToIds(codesRaw: string | undefined, creator: any, targetRole: string, errors: string[]): Promise<string[]> {
    const codes = String(codesRaw || '')
      .split(/[,;]/)
      .map((c) => c.trim().toUpperCase())
      .filter(Boolean);
    if (codes.length === 0) return this.resolveWarehouseIds([], creator, targetRole, errors);

    const warehouses = await this.prisma.warehouse.findMany({
      where: { companyId: creator.companyId, code: { in: codes } },
      select: { id: true, code: true },
    });
    const foundCodes = new Set(warehouses.map((w) => w.code));
    const missing = codes.filter((c) => !foundCodes.has(c));
    if (missing.length > 0) {
      errors.push(`Warehouse code(s) not found for this company: ${missing.join(', ')}`);
      return [];
    }
    return this.resolveWarehouseIds(warehouses.map((w) => w.id), creator, targetRole, errors);
  }

  // Bulk create — for a Manager/Supervisor onboarding a large batch of
  // Operators (100+) at once, where the manual one-by-one form doesn't scale.
  // Same validate()/resolveWarehouseIds()/CREATABLE_ROLES rules as the manual
  // create() path (CLAUDE.md's "one function, two callers" convention) — a
  // Manager bulk-importing is just as scope-limited (creatable roles, own
  // warehouses only) as one adding a single user by hand.
  async bulkImport(rows: any[], creator: any) {
    if (!creator.companyId) {
      throw new ForbiddenException('Super admin accounts cannot import users directly — log in as a company admin instead.');
    }
    const creatable = CREATABLE_ROLES[creator.role] || [];
    const results: any[] = [];
    const emailsSeenInFile = new Set<string>();

    for (const row of rows) {
      const targetRole = row.role ? normalizeCode(row.role) : '';
      const errors: string[] = [];

      if (!creatable.includes(targetRole)) {
        errors.push(`Your role (${creator.role}) cannot create a user with role "${row.role || '(blank)'}".`);
      }
      errors.push(...this.validate(row, targetRole));
      if (!row.password || String(row.password).length < 6) {
        errors.push('Password is required and must be at least 6 characters.');
      }

      const email = row.email ? String(row.email).trim() : '';
      if (email && emailsSeenInFile.has(email.toLowerCase())) {
        errors.push(`Duplicate Login ID within this file: ${email}`);
      }

      const warehouseIds = errors.length === 0 ? await this.resolveWarehouseCodesToIds(row.warehouseCodes, creator, targetRole, errors) : [];

      if (errors.length === 0 && email) {
        const existing = await this.prisma.user.findUnique({ where: { email } });
        if (existing) errors.push(`Login ID already exists in the database: ${email}`);
      }

      if (errors.length > 0) {
        results.push({ email: row.email || '(blank)', status: 'error', errors });
        continue;
      }

      try {
        const passwordHash = await bcrypt.hash(row.password, 10);
        await this.prisma.user.create({
          data: {
            email,
            passwordHash,
            name: row.name.trim(),
            role: targetRole as any,
            functionTag: row.functionTag || undefined,
            company: { connect: { id: creator.companyId } },
            assignedWarehouses: warehouseIds.length ? { connect: warehouseIds.map((wid) => ({ id: wid })) } : undefined,
          },
        });
        results.push({ email, status: 'success' });
        emailsSeenInFile.add(email.toLowerCase());
      } catch (err: any) {
        results.push({ email: row.email || '(blank)', status: 'error', errors: [err.message || 'Unknown error'] });
      }
    }

    return {
      totalUsers: rows.length,
      successCount: results.filter((r) => r.status === 'success').length,
      failCount: results.filter((r) => r.status === 'error').length,
      results,
    };
  }

  async findAll(user: any) {
    const where: any = { ...companyFilter(user) };
    if (WAREHOUSE_SCOPED_ROLES.includes(user.role)) {
      const ownIds = await ownWarehouseIds(this.prisma, user.userId);
      where.OR = [{ id: user.userId }, { assignedWarehouses: { some: { id: { in: ownIds } } } }];
    }
    return this.prisma.user.findMany({ where, select: SELECT_SAFE, orderBy: { createdAt: 'asc' } });
  }

  // Same visibility rule as findAll (self, or shares a warehouse for a
  // scoped role, or Admin sees everyone) — not the stricter assertEditAccess
  // rule, since viewing history is a read, not an edit. Capped to the most
  // recent 100 — the ledger is append-only and grows forever, this is a
  // quick-look view, not the future attendance report itself.
  async getLoginHistory(id: string, viewer: any) {
    const target = await this.prisma.user.findUnique({
      where: { id },
      select: { id: true, companyId: true, assignedWarehouses: { select: { id: true } } },
    });
    if (!target) throw new NotFoundException('User not found.');
    if (viewer.role !== 'SUPER_ADMIN' && target.companyId !== viewer.companyId) {
      throw new ForbiddenException('You do not have access to this user.');
    }
    if (WAREHOUSE_SCOPED_ROLES.includes(viewer.role) && id !== viewer.userId) {
      const ownIds = await ownWarehouseIds(this.prisma, viewer.userId);
      const targetIds = target.assignedWarehouses.map((w) => w.id);
      const overlaps = targetIds.some((wid) => ownIds.includes(wid));
      if (!overlaps) throw new ForbiddenException('You do not have access to this user.');
    }

    return this.prisma.loginEvent.findMany({
      where: { userId: id },
      orderBy: { loggedInAt: 'desc' },
      take: 100,
      select: { id: true, loggedInAt: true },
    });
  }

  private async assertEditAccess(id: string, editor: any) {
    const target = await this.prisma.user.findUnique({
      where: { id },
      select: { id: true, companyId: true, role: true, email: true, assignedWarehouses: { select: { id: true } } },
    });
    if (!target) throw new NotFoundException('User not found.');
    if (editor.role !== 'SUPER_ADMIN' && target.companyId !== editor.companyId) {
      throw new ForbiddenException('You do not have access to this user.');
    }
    // Anyone can always reach their own record — the creatable-role/warehouse-
    // overlap checks below exist to gate access to *other* people's accounts
    // (e.g. can a Manager touch this Supervisor?), not your own. Self-service
    // is still constrained in update() itself: a self-edit can never change
    // `role` or `email`, no matter who you are (see there for why).
    if (id === editor.userId) return target;
    if (editor.role !== 'SUPER_ADMIN' && editor.role !== 'COMPANY_ADMIN') {
      const creatable = CREATABLE_ROLES[editor.role] || [];
      if (!creatable.includes(target.role)) {
        throw new ForbiddenException('You do not have access to this user.');
      }
      const ownIds = await ownWarehouseIds(this.prisma, editor.userId);
      const targetIds = target.assignedWarehouses.map((w) => w.id);
      const overlaps = targetIds.some((wid) => ownIds.includes(wid));
      if (!overlaps) throw new ForbiddenException('You do not have access to this user.');
    }
    return target;
  }

  async update(id: string, data: any, editor: any) {
    const target = await this.assertEditAccess(id, editor);
    const isSelfEdit = id === editor.userId;

    // Login ID is immutable after creation — these IDs anchor per-person KPI
    // history, so silently letting them drift (or worse, silently ignoring an
    // attempted change, which is what used to happen here) would be worse
    // than just not supporting the rename.
    if (data.email !== undefined && data.email.trim() !== target.email) {
      throw new BadRequestException('Login ID cannot be changed after account creation.');
    }

    // Nobody — including Admin — can change their own role via self-edit.
    // assertEditAccess opens self-access purely so people can update their
    // own name/password; without this, Admin's CREATABLE_ROLES set (which
    // includes every role, itself included) would let an Admin accidentally
    // demote themselves out of the company's only admin seat.
    if (isSelfEdit && data.role !== undefined && data.role !== target.role) {
      throw new BadRequestException('You cannot change your own role.');
    }

    const targetRole = data.role !== undefined ? data.role : target.role;
    if (!isSelfEdit && data.role !== undefined && data.role !== target.role) {
      const creatable = CREATABLE_ROLES[editor.role] || [];
      if (!creatable.includes(data.role)) {
        throw new ForbiddenException(`Your role (${editor.role}) cannot assign role ${data.role}.`);
      }
    }

    const errors: string[] = [];
    if (data.name !== undefined && (!data.name || data.name.trim().length < 2)) {
      errors.push('Name must be at least 2 characters.');
    }
    if (data.password !== undefined && data.password !== '' && String(data.password).length < 6) {
      errors.push('Password must be at least 6 characters.');
    }

    let warehouseIds: string[] | undefined;
    if (data.assignedWarehouseIds !== undefined) {
      const requested = await this.resolveWarehouseIds(data.assignedWarehouseIds, editor, targetRole, errors);
      if (errors.length === 0) {
        if (editor.role === 'SUPER_ADMIN' || editor.role === 'COMPANY_ADMIN') {
          warehouseIds = requested;
        } else {
          // A Manager/Supervisor editing someone assigned to a warehouse
          // outside their own scope (a subordinate shared across warehouses —
          // allowed by the schema's flexible cardinality) must never have that
          // other assignment re-validated against, or silently dropped by,
          // their own scope. Preserve it untouched — only the editor's own
          // portion of the assignment is theirs to change.
          const editorOwnIds = await ownWarehouseIds(this.prisma, editor.userId);
          const currentTargetIds = target.assignedWarehouses.map((w) => w.id);
          const preserved = currentTargetIds.filter((wid) => !editorOwnIds.includes(wid));
          warehouseIds = Array.from(new Set([...preserved, ...requested]));
        }
      }
    }
    if (errors.length > 0) throw new BadRequestException(errors);

    const updateData: any = {};
    if (data.name !== undefined) updateData.name = data.name.trim();
    if (!isSelfEdit && data.role !== undefined) updateData.role = data.role;
    if (data.functionTag !== undefined) updateData.functionTag = data.functionTag || null;
    if (data.password) updateData.passwordHash = await bcrypt.hash(data.password, 10);
    if (warehouseIds !== undefined) {
      updateData.assignedWarehouses = { set: warehouseIds.map((wid) => ({ id: wid })) };
    }

    return this.prisma.user.update({ where: { id }, data: updateData, select: SELECT_SAFE });
  }

  async deactivate(id: string, editor: any) {
    if (id === editor.userId) throw new BadRequestException('You cannot deactivate your own account.');
    await this.assertEditAccess(id, editor);
    return this.prisma.user.update({ where: { id }, data: { isActive: false }, select: SELECT_SAFE });
  }

  async reactivate(id: string, editor: any) {
    await this.assertEditAccess(id, editor);
    return this.prisma.user.update({ where: { id }, data: { isActive: true }, select: SELECT_SAFE });
  }
}
