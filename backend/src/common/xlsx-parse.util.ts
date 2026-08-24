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

// Import templates mark required columns with a trailing " *" in the header
// cell (e.g. "Location Code *") so it's visible without opening the Legend
// tab. Controllers read cells by exact header name (`r['Location Code']`),
// so that suffix would otherwise break the lookup — strip it from every row
// object's keys right after `sheet_to_json`, before any `r['Column Name']`
// access. Old templates without the suffix are unaffected (stripping a
// non-existent suffix is a no-op).
export function stripHeaderAsterisks(rows: any[]): any[] {
  return rows.map((row) => {
    const cleaned: any = {};
    for (const key of Object.keys(row)) {
      cleaned[key.replace(/\s*\*\s*$/, '')] = row[key];
    }
    return cleaned;
  });
}
