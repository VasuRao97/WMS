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
export const WAREHOUSE_SCOPED_ROLES = ['WAREHOUSE_MANAGER', 'WAREHOUSE_SUPERVISOR'];

// Yard & Gate is operational, not master data — OPERATOR needs full access
// here (gate/security staff are exactly who logs a vehicle in/out day to
// day), unlike MASTER_DATA_READ_ROLES which excludes them. Dock Door itself
// stays master-data-gated for create/edit/delete (it's a physical asset
// config, same tier as Warehouse/Location) but every operational role can
// read the list (needed to pick a door while logging a gate entry) and log
// Gate In/Out. WAREHOUSE_SCOPED_ROLES above only covers Manager/Supervisor —
// Operator is scoped the same way (via their own assignedWarehouses) but
// needs its own list since it can't create/edit master data.
export const GATE_YARD_READ_ROLES = ['COMPANY_ADMIN', 'WAREHOUSE_MANAGER', 'WAREHOUSE_SUPERVISOR', 'OPERATOR'];
export const GATE_YARD_OPERATE_ROLES = ['COMPANY_ADMIN', 'WAREHOUSE_MANAGER', 'WAREHOUSE_SUPERVISOR', 'OPERATOR'];
export const GATE_YARD_SCOPED_ROLES = ['WAREHOUSE_MANAGER', 'WAREHOUSE_SUPERVISOR', 'OPERATOR'];

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
