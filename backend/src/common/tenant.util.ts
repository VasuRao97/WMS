import { ForbiddenException } from '@nestjs/common';

// Tenant-scoping filter shared by every service's findAll/removeAll-style
// queries: SUPER_ADMIN sees every company's records, everyone else is scoped
// to their own companyId. See CLAUDE.md's multi-tenancy section — this is the
// documented convention, don't retype the ternary inline per call site.
export function companyFilter(user: any) {
  return user.role === 'SUPER_ADMIN' ? {} : { companyId: user.companyId };
}

// Role/access conventions for master data (Warehouse, Customer, SKU, User) —
// see CLAUDE.md's role-access notes for the full picture:
//   - OPERATOR has zero master-data visibility (their surface is future
//     transactional/handheld screens, not these pages) — excluded from READ.
//   - WAREHOUSE_SUPERVISOR is read-only — same visibility as MANAGER, no edit.
//   - SKU stays unscoped (shared catalog, every readable role sees it all);
//     Warehouse/Customer/User are scoped to assignedWarehouses for MANAGER/
//     SUPERVISOR (privacy: a TN01 person shouldn't see TN02's data).
export const MASTER_DATA_READ_ROLES = ['COMPANY_ADMIN', 'WAREHOUSE_MANAGER', 'WAREHOUSE_SUPERVISOR'];
export const MASTER_DATA_WRITE_ROLES = ['COMPANY_ADMIN', 'WAREHOUSE_MANAGER'];
// SECURITY_SUPERVISOR (2026-08-27) is included here even though it's
// excluded from MASTER_DATA_READ_ROLES — this constant is also read by
// UsersService (see users.controller.ts's CAN_MANAGE_USERS, the one
// exception where Security Supervisor DOES need access, to manage the
// OPERATOR accounts under them). Harmless for Warehouse/Customer/Location's
// own services, which never reach this scoping check for that role anyway
// since their controllers block it at MASTER_DATA_READ_ROLES first.
export const WAREHOUSE_SCOPED_ROLES = ['WAREHOUSE_MANAGER', 'WAREHOUSE_SUPERVISOR', 'SECURITY_SUPERVISOR'];

// Yard & Gate is operational, not master data — OPERATOR needs full access
// here (gate/security staff are exactly who logs a vehicle in/out day to
// day), unlike MASTER_DATA_READ_ROLES which excludes them. Dock Door itself
// stays master-data-gated for create/edit/delete (it's a physical asset
// config, same tier as Warehouse/Location) but every operational role can
// read the list (needed to pick a door while logging a gate entry) and log
// Gate In/Out. WAREHOUSE_SCOPED_ROLES above only covers Manager/Supervisor —
// Operator is scoped the same way (via their own assignedWarehouses) but
// needs its own list since it can't create/edit master data.
// SECURITY_SUPERVISOR (2026-08-27) is included in every one of these three —
// it's the role this whole page exists for. It's deliberately NOT in
// MASTER_DATA_READ_ROLES above: same "zero master-data visibility, surface
// is a task screen" reasoning as OPERATOR, just for gate/yard duty instead
// of a future handheld screen.
export const GATE_YARD_READ_ROLES = ['COMPANY_ADMIN', 'WAREHOUSE_MANAGER', 'WAREHOUSE_SUPERVISOR', 'SECURITY_SUPERVISOR', 'OPERATOR'];
export const GATE_YARD_OPERATE_ROLES = ['COMPANY_ADMIN', 'WAREHOUSE_MANAGER', 'WAREHOUSE_SUPERVISOR', 'SECURITY_SUPERVISOR', 'OPERATOR'];
export const GATE_YARD_SCOPED_ROLES = ['WAREHOUSE_MANAGER', 'WAREHOUSE_SUPERVISOR', 'SECURITY_SUPERVISOR', 'OPERATOR'];

// MHE (Material Handling Equipment) master (2026-08-28, Putaway kickoff —
// built before any Putaway task logic). Same tier as Inbound's own floor
// roles, not Gate/Yard's — SECURITY_SUPERVISOR is deliberately excluded
// (their surface is the gate, not warehouse-floor equipment), OPERATOR is
// included since they're who'll eventually execute Putaway tasks with this
// gear. Create/edit/delete stays MASTER_DATA_WRITE_ROLES/'COMPANY_ADMIN',
// same tier as DockDoor (a physical asset config, occasional-edit).
export const EQUIPMENT_READ_ROLES = ['COMPANY_ADMIN', 'WAREHOUSE_MANAGER', 'WAREHOUSE_SUPERVISOR', 'OPERATOR'];
export const EQUIPMENT_SCOPED_ROLES = ['WAREHOUSE_MANAGER', 'WAREHOUSE_SUPERVISOR', 'OPERATOR'];

// Roles that keep Gate/Yard access even when a company turns ON
// Company.restrictGateAccessToSecuritySupervisor — Manager/Admin oversight
// is never locked out by the toggle, only the general Supervisor/Operator
// tier loses access. Call assertGateAccessAllowed() at the top of any
// Gate Entry / Yard / Vehicle / Driver service method (all four now live
// only on the Gate page, so all four respect the same toggle).
const GATE_YARD_ALWAYS_ALLOWED_ROLES = ['SUPER_ADMIN', 'COMPANY_ADMIN', 'WAREHOUSE_MANAGER', 'SECURITY_SUPERVISOR'];

// Inbound receiving (2026-08-27) — see CLAUDE.md's "Inbound receiving"
// section for the full design.
//   INBOUND_ORDER_WRITE_ROLES: who can create the "order maker" (an
//     InboundReceipt + its expected SKU/qty lines) — same tier as
//     master-data write, since this is planning data, not floor work.
//   INBOUND_SCAN_ROLES: who can physically scan during receiving — broad,
//     matches the warehouse-floor roles. Deliberately excludes
//     SECURITY_SUPERVISOR (their surface is the gate, not the dock).
//   INBOUND_APPROVE_ROLES: who can resolve a BLOCKED scan — Supervisor and
//     up only, deliberately excluding OPERATOR — the client's own
//     instruction: the scanning operator can never self-approve their own
//     blocked scan.
export const INBOUND_READ_ROLES = ['COMPANY_ADMIN', 'WAREHOUSE_MANAGER', 'WAREHOUSE_SUPERVISOR', 'OPERATOR'];
export const INBOUND_ORDER_WRITE_ROLES = ['COMPANY_ADMIN', 'WAREHOUSE_MANAGER'];
export const INBOUND_SCAN_ROLES = ['COMPANY_ADMIN', 'WAREHOUSE_MANAGER', 'WAREHOUSE_SUPERVISOR', 'OPERATOR'];
export const INBOUND_APPROVE_ROLES = ['COMPANY_ADMIN', 'WAREHOUSE_MANAGER', 'WAREHOUSE_SUPERVISOR'];
export const INBOUND_SCOPED_ROLES = ['WAREHOUSE_MANAGER', 'WAREHOUSE_SUPERVISOR', 'OPERATOR'];

// Putaway (2026-08-28) — same tier as Inbound's own floor roles, since it's
// the direct continuation of receiving work (staging -> bin). Deliberately
// excludes SECURITY_SUPERVISOR (their surface is the gate). The multi-deep
// lane exception workflow is NOT role-constant-driven — it's exactly two
// named roles by the client's own explicit design (WAREHOUSE_MANAGER
// requests, COMPANY_ADMIN alone decides), so those are checked directly
// with @Roles('WAREHOUSE_MANAGER') / @Roles('COMPANY_ADMIN') at the
// controller rather than a broader constant that would blur that
// distinction.
export const PUTAWAY_EXECUTE_ROLES = ['COMPANY_ADMIN', 'WAREHOUSE_MANAGER', 'WAREHOUSE_SUPERVISOR', 'OPERATOR'];
export const PUTAWAY_SCOPED_ROLES = ['WAREHOUSE_MANAGER', 'WAREHOUSE_SUPERVISOR', 'OPERATOR'];

export async function assertGateAccessAllowed(prisma: { company: { findUnique: Function } }, user: any): Promise<void> {
  if (GATE_YARD_ALWAYS_ALLOWED_ROLES.includes(user.role)) return;
  if (!user.companyId) return; // SUPER_ADMIN already handled above; nothing else should reach this with no companyId
  const company: any = await prisma.company.findUnique({ where: { id: user.companyId }, select: { restrictGateAccessToSecuritySupervisor: true } });
  if (company?.restrictGateAccessToSecuritySupervisor) {
    throw new ForbiddenException('This company restricts Gate/Yard access to Security Supervisors and above.');
  }
}

/**
 * A MANAGER/SUPERVISOR's own assignedWarehouses ids, fetched fresh from the DB
 * (the JWT payload doesn't carry them, and they can change without a re-login).
 * Only meaningful for WAREHOUSE_SCOPED_ROLES — don't call this for ADMIN/SUPER_ADMIN.
 */
export async function ownWarehouseIds(prisma: { user: { findUnique: Function } }, userId: string): Promise<string[]> {
  const self: any = await prisma.user.findUnique({
    where: { id: userId },
    select: { assignedWarehouses: { select: { id: true } } },
  });
  return (self?.assignedWarehouses || []).map((w: any) => w.id);
}
