// Normalizes free-text label variants ("Ground/Floor", "Drive-in", "Regional DC",
// "Full Pallet", "Damage & Scrap") into the SCREAMING_SNAKE_CASE canonical
// values this app stores. Shared by every service that validates a
// classification field against a restricted list from both a manual-create
// form and free-text Excel cells — don't hand-roll a new label→code mapping
// per field. Strips whitespace/slash/hyphen/ampersand runs down to a single
// underscore — "&" was added for Locations' "Damage & Scrap" zone type
// (2026-08-24): without it, "Damage & Scrap" normalized to "DAMAGE_&_SCRAP"
// (the ampersand survived, flanked by its own two underscores) instead of
// "DAMAGE_SCRAP", failing validation against the enum's real value.
export function normalizeCode(value: any): string {
  return String(value).trim().toUpperCase().replace(/[\s/&-]+/g, '_');
}
