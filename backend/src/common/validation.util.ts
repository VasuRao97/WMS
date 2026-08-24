// Shared field-format rules used by every master-data service's manual-create
// and bulk-import validation (SKU code, Warehouse Location Code, Customer
// Bill To ID all follow the same "code" shape; pincode is checked identically
// wherever it appears).
export const CODE_REGEX = /^[A-Za-z0-9-]{1,30}$/;
export const PINCODE_REGEX = /^\d{6}$/;
export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
