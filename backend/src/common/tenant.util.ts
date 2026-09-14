import { ForbiddenException } from '@nestjs/common';
import { Role } from '@prisma/client';

// The authenticated request-scoped user shape every controller/service in
// this app receives via `@CurrentUser()` (current-user.decorator.ts, sourced
// from JwtStrategy.validate()'s own returned object) — the JWT payload's
// four fields, NOT the full Prisma `User` row (no `name`/`phone`/etc. here).
// Centralized here since `tenant.util.ts` is already the one file every
// module imports role/scoping helpers from (see CLAUDE.md's "no DTO layer"
// note — this replaces the ~330 individual `user: any` parameters that used
// to carry this shape untyped, without introducing a request-body DTO layer,
// which stays deliberately out of scope).
export interface AuthUser {
  userId: string;
  email: string;
  role: Role;
  companyId: string | null;
}

// Tenant-scoping filter shared by every service's findAll/removeAll-style
// queries: SUPER_ADMIN sees every company's records, everyone else is scoped
// to their own companyId. See CLAUDE.md's multi-tenancy section — this is the
// documented convention, don't retype the ternary inline per call site.
// Return type is deliberately `{ companyId?: string }`, not
// `AuthUser['companyId']` (`string | null`) — every real, non-SUPER_ADMIN
// user always has a real companyId (SUPER_ADMIN, the only role that can
// carry `null`, is fully handled by the branch above and never reaches
// here), and Prisma's generated `WhereInput` types for a required
// `companyId` FK column only ever accept `string | StringFilter |
// undefined`, never a literal `null`. Spreading `{ companyId: null }`
// wouldn't compile at any of this function's ~25 call sites otherwise.
export function companyFilter(user: AuthUser): { companyId?: string } {
  return user.role === 'SUPER_ADMIN' ? {} : { companyId: user.companyId! };
}

// Role/access conventions for master data (Warehouse, Customer, SKU, User) —
// see CLAUDE.md's role-access notes for the full picture:
//   - OPERATOR has zero master-data visibility (their surface is future
//     transactional/handheld screens, not these pages) — excluded from READ.
//   - WAREHOUSE_SUPERVISOR is read-only — same visibility as MANAGER, no edit.
//   - SKU stays unscoped (shared catalog, every readable role sees it all);
//     Warehouse/Customer/User are scoped to assignedWarehouses for MANAGER/
//     SUPERVISOR (privacy: a TN01 person shouldn't see TN02's data).
export const MASTER_DATA_READ_ROLES = [
  'COMPANY_ADMIN',
  'WAREHOUSE_MANAGER',
  'WAREHOUSE_SUPERVISOR',
];
export const MASTER_DATA_WRITE_ROLES = ['COMPANY_ADMIN', 'WAREHOUSE_MANAGER'];
// SECURITY_SUPERVISOR (2026-08-27) is included here even though it's
// excluded from MASTER_DATA_READ_ROLES — this constant is also read by
// UsersService (see users.controller.ts's CAN_MANAGE_USERS, the one
// exception where Security Supervisor DOES need access, to manage the
// OPERATOR accounts under them). Harmless for Warehouse/Customer/Location's
// own services, which never reach this scoping check for that role anyway
// since their controllers block it at MASTER_DATA_READ_ROLES first.
export const WAREHOUSE_SCOPED_ROLES = [
  'WAREHOUSE_MANAGER',
  'WAREHOUSE_SUPERVISOR',
  'SECURITY_SUPERVISOR',
];

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
export const GATE_YARD_READ_ROLES = [
  'COMPANY_ADMIN',
  'WAREHOUSE_MANAGER',
  'WAREHOUSE_SUPERVISOR',
  'SECURITY_SUPERVISOR',
  'OPERATOR',
];
export const GATE_YARD_OPERATE_ROLES = [
  'COMPANY_ADMIN',
  'WAREHOUSE_MANAGER',
  'WAREHOUSE_SUPERVISOR',
  'SECURITY_SUPERVISOR',
  'OPERATOR',
];
export const GATE_YARD_SCOPED_ROLES = [
  'WAREHOUSE_MANAGER',
  'WAREHOUSE_SUPERVISOR',
  'SECURITY_SUPERVISOR',
  'OPERATOR',
];

// MHE (Material Handling Equipment) master (2026-08-28, Putaway kickoff —
// built before any Putaway task logic). Same tier as Inbound's own floor
// roles, not Gate/Yard's — SECURITY_SUPERVISOR is deliberately excluded
// (their surface is the gate, not warehouse-floor equipment), OPERATOR is
// included since they're who'll eventually execute Putaway tasks with this
// gear. Create/edit/delete stays MASTER_DATA_WRITE_ROLES/'COMPANY_ADMIN',
// same tier as DockDoor (a physical asset config, occasional-edit).
export const EQUIPMENT_READ_ROLES = [
  'COMPANY_ADMIN',
  'WAREHOUSE_MANAGER',
  'WAREHOUSE_SUPERVISOR',
  'OPERATOR',
];
export const EQUIPMENT_SCOPED_ROLES = [
  'WAREHOUSE_MANAGER',
  'WAREHOUSE_SUPERVISOR',
  'OPERATOR',
];

// Roles that keep Gate/Yard access even when a company turns ON
// Company.restrictGateAccessToSecuritySupervisor — Manager/Admin oversight
// is never locked out by the toggle, only the general Supervisor/Operator
// tier loses access. Call assertGateAccessAllowed() at the top of any
// Gate Entry / Yard / Vehicle / Driver service method (all four now live
// only on the Gate page, so all four respect the same toggle).
const GATE_YARD_ALWAYS_ALLOWED_ROLES = [
  'SUPER_ADMIN',
  'COMPANY_ADMIN',
  'WAREHOUSE_MANAGER',
  'SECURITY_SUPERVISOR',
];

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
export const INBOUND_READ_ROLES = [
  'COMPANY_ADMIN',
  'WAREHOUSE_MANAGER',
  'WAREHOUSE_SUPERVISOR',
  'OPERATOR',
];
export const INBOUND_ORDER_WRITE_ROLES = ['COMPANY_ADMIN', 'WAREHOUSE_MANAGER'];
export const INBOUND_SCAN_ROLES = [
  'COMPANY_ADMIN',
  'WAREHOUSE_MANAGER',
  'WAREHOUSE_SUPERVISOR',
  'OPERATOR',
];
export const INBOUND_APPROVE_ROLES = [
  'COMPANY_ADMIN',
  'WAREHOUSE_MANAGER',
  'WAREHOUSE_SUPERVISOR',
];
export const INBOUND_SCOPED_ROLES = [
  'WAREHOUSE_MANAGER',
  'WAREHOUSE_SUPERVISOR',
  'OPERATOR',
];

// Putaway (2026-08-28) — same tier as Inbound's own floor roles, since it's
// the direct continuation of receiving work (staging -> bin). Deliberately
// excludes SECURITY_SUPERVISOR (their surface is the gate). The multi-deep
// lane exception workflow is NOT role-constant-driven — it's exactly two
// named roles by the client's own explicit design (WAREHOUSE_MANAGER
// requests, COMPANY_ADMIN alone decides), so those are checked directly
// with @Roles('WAREHOUSE_MANAGER') / @Roles('COMPANY_ADMIN') at the
// controller rather than a broader constant that would blur that
// distinction.
export const PUTAWAY_EXECUTE_ROLES = [
  'COMPANY_ADMIN',
  'WAREHOUSE_MANAGER',
  'WAREHOUSE_SUPERVISOR',
  'OPERATOR',
];
export const PUTAWAY_SCOPED_ROLES = [
  'WAREHOUSE_MANAGER',
  'WAREHOUSE_SUPERVISOR',
  'OPERATOR',
];
// Location-override discrepancy review (2026-09-06) — Supervisor-and-up,
// same tier as INBOUND_APPROVE_ROLES (approving a blocked scan) — an
// Operator can complete an overridden trip and see the plain flag on their
// own row via PUTAWAY_EXECUTE_ROLES's own findAll(), but reviewing/
// dismissing a discrepancy (their own or anyone else's) is a step above
// that, same "the scanning operator can never resolve their own blocked
// scan" principle Inbound already established. A separate named constant
// from INBOUND_APPROVE_ROLES on purpose even though the values are
// identical today — same "distinct destinations that could diverge later"
// reasoning as CAN_VIEW_INSIGHTS/CAN_VIEW_ANALYTICS.
export const PUTAWAY_DISCREPANCY_REVIEW_ROLES = [
  'COMPANY_ADMIN',
  'WAREHOUSE_MANAGER',
  'WAREHOUSE_SUPERVISOR',
];

// Outbound/Picking (2026-09-14) — same tier shape as Inbound/Putaway above,
// mirrored deliberately rather than reusing INBOUND_*/PUTAWAY_* directly
// (same "distinct destinations that could diverge later" reasoning as
// CAN_VIEW_INSIGHTS/CAN_VIEW_ANALYTICS, even though the role lists are
// identical today).
//   OUTBOUND_READ_ROLES / OUTBOUND_ORDER_WRITE_ROLES: order visibility and
//     the "order maker" (create/import/ERP push) — same tier as Inbound's
//     own INBOUND_READ_ROLES/INBOUND_ORDER_WRITE_ROLES.
//   OUTBOUND_ALLOT_ROLES: who can allot a gated-in vehicle to an order —
//     Supervisor and up, confirmed directly ("supervisor has to then select
//     the vehicle and allot") — deliberately excludes OPERATOR, same tier
//     as INBOUND_APPROVE_ROLES.
//   PICK_EXECUTE_ROLES: who can claim/complete a picking trip — broad,
//     matches PUTAWAY_EXECUTE_ROLES's own floor-role tier.
export const OUTBOUND_READ_ROLES = [
  'COMPANY_ADMIN',
  'WAREHOUSE_MANAGER',
  'WAREHOUSE_SUPERVISOR',
  'OPERATOR',
];
export const OUTBOUND_ORDER_WRITE_ROLES = [
  'COMPANY_ADMIN',
  'WAREHOUSE_MANAGER',
];
export const OUTBOUND_ALLOT_ROLES = [
  'COMPANY_ADMIN',
  'WAREHOUSE_MANAGER',
  'WAREHOUSE_SUPERVISOR',
];
export const PICK_EXECUTE_ROLES = [
  'COMPANY_ADMIN',
  'WAREHOUSE_MANAGER',
  'WAREHOUSE_SUPERVISOR',
  'OPERATOR',
];
export const OUTBOUND_SCOPED_ROLES = [
  'WAREHOUSE_MANAGER',
  'WAREHOUSE_SUPERVISOR',
  'OPERATOR',
];

export async function assertGateAccessAllowed(
  prisma: { company: { findUnique: Function } },
  user: AuthUser,
): Promise<void> {
  if (GATE_YARD_ALWAYS_ALLOWED_ROLES.includes(user.role)) return;
  if (!user.companyId) return; // SUPER_ADMIN already handled above; nothing else should reach this with no companyId
  const company: any = await prisma.company.findUnique({
    where: { id: user.companyId },
    select: { restrictGateAccessToSecuritySupervisor: true },
  });
  if (company?.restrictGateAccessToSecuritySupervisor) {
    throw new ForbiddenException(
      'This company restricts Gate/Yard access to Security Supervisors and above.',
    );
  }
}

/**
 * A MANAGER/SUPERVISOR's own assignedWarehouses ids, fetched fresh from the DB
 * (the JWT payload doesn't carry them, and they can change without a re-login).
 * Only meaningful for WAREHOUSE_SCOPED_ROLES — don't call this for ADMIN/SUPER_ADMIN.
 */
export async function ownWarehouseIds(
  prisma: { user: { findUnique: Function } },
  userId: string,
): Promise<string[]> {
  const self: any = await prisma.user.findUnique({
    where: { id: userId },
    select: { assignedWarehouses: { select: { id: true } } },
  });
  return (self?.assignedWarehouses || []).map((w: any) => w.id);
}

/**
 * GATE_YARD_SCOPED_ROLES' own accessible-warehouse set — undefined means
 * "no extra restriction beyond companyFilter" (Admin/SuperAdmin), an array
 * means "only these ids" (Manager/Supervisor/SecuritySupervisor/Operator).
 * Extracted 2026-08-28 from YardService.tracker()'s own private copy so
 * Vehicle/Driver's new home-warehouse scoping (same reasoning: "TN08 only
 * should see it," a real data-privacy call once warehouses can belong to
 * different 3PLs under one company) can share the exact same logic rather
 * than a third hand-rolled copy.
 */
export async function gateYardAccessibleWarehouseIds(
  prisma: { user: { findUnique: Function } },
  user: AuthUser,
): Promise<string[] | undefined> {
  if (GATE_YARD_SCOPED_ROLES.includes(user.role))
    return ownWarehouseIds(prisma, user.userId);
  return undefined;
}
