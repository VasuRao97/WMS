-- WarehouseStorageType.maxSkusClassB default: 2 -> 1 (2026-08-29) — an
-- interim workaround for a real self-exclusion bug in suggestBin()'s
-- cap-enforcement logic (a SKU already occupying a lane could get wrongly
-- blocked from its own lane's last empty depth once the lane hit its
-- distinct-SKU cap, since the check doesn't exclude "myself" from the
-- occupant count). Only triggers when a lane's cap allows more than one
-- distinct SKU — dropping B to the same exclusivity as A (1) sidesteps it
-- entirely until the real fix + a client-facing toggle are built later
-- (see ROADMAP.md's deferred list). Only affects the default applied to a
-- NEW row — does not retroactively change any already-existing row's
-- stored value (this field has never been wired to any UI/API, so every
-- existing row already just holds the old default of 2 as a literal
-- stored value, same as this project's other default-only-affects-new-rows
-- changes).

ALTER TABLE "WarehouseStorageType" ALTER COLUMN "maxSkusClassB" SET DEFAULT 1;
