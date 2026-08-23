// Tenant-scoping filter shared by every service's findAll/removeAll-style
// queries: SUPER_ADMIN sees every company's records, everyone else is scoped
// to their own companyId. See CLAUDE.md's multi-tenancy section — this is the
// documented convention, don't retype the ternary inline per call site.
export function companyFilter(user: any) {
  return user.role === 'SUPER_ADMIN' ? {} : { companyId: user.companyId };
}
