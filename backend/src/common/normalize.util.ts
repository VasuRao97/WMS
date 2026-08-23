// Normalizes free-text label variants ("Ground/Floor", "Drive-in", "Regional DC",
// "Full Pallet") into the SCREAMING_SNAKE_CASE canonical values this app stores.
// Shared by every service that validates a classification field against a
// restricted list from both a manual-create form and free-text Excel cells —
// don't hand-roll a new label→code mapping per field.
export function normalizeCode(value: any): string {
  return String(value).trim().toUpperCase().replace(/[\s/-]+/g, '_');
}
