-- User.phone (2026-08-27) — closes a real gap found while building detention
-- alerting: only Driver had a phone field, so a staff-facing SMS/WhatsApp
-- alert had nowhere to be sent to. Purely a contact field, no login/identity
-- impact — email stays the login ID. Nullable, no unique constraint, same
-- shape as Driver.phone.
ALTER TABLE "User" ADD COLUMN "phone" TEXT;
