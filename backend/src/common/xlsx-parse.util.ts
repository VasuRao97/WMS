// Shared cell-value coercion for Excel import controllers (SKU, Customer,
// Warehouse). Cell values from `xlsx`'s sheet_to_json come back as strings,
// booleans, or numbers depending on how the cell was authored — these two
// helpers normalize that into what the service layer expects.
export function toBool(val: any): boolean {
  if (typeof val === 'boolean') return val;
  if (typeof val === 'string') return val.trim().toUpperCase() === 'TRUE';
  return false;
}

export function toNumberOrUndefined(val: any): number | undefined {
  if (val === undefined || val === null || val === '') return undefined;
  const n = Number(val);
  return isNaN(n) ? undefined : n;
}
