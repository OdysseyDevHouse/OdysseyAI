-- ─────────────────────────────────────────────────────────────────────────
-- Catch-up: users.mobile and the per-channel consent columns.
--
-- ── WHY THIS FILE EXISTS AT ALL ──────────────────────────────────────────
--
-- These columns were added by EDITING 031 and 041 in place, on the reasoning
-- that nothing is live yet so the schema may as well read as though designed
-- once. That reasoning was sound and the execution was not.
--
-- schema_migrations keys on FILENAME. An edited file is never re-read on a
-- database that already ran it, so an in-place edit reaches exactly the
-- databases that are rebuilt from scratch afterwards — and this repo has
-- TWENTY-TWO site databases, of which one was rebuilt. The other twenty-one
-- carried on without the columns until the back office asked for u.mobile on
-- every page load and threw "Unknown column 'u.mobile' in 'SELECT'" before
-- rendering anything.
--
-- The symptom was ugly: every route in the app returned a server error, sign-in
-- still worked because it is a server action against the control database, and
-- the screenshot tool showed Chrome's own error page with no document behind it.
-- Easy to mistake for a broken build. It was a missing column on 21 databases.
--
-- ── SO THE RULE, WRITTEN DOWN ────────────────────────────────────────────
--
-- Editing an applied migration is only safe when EVERY database that ran it is
-- rebuilt. Where that is not going to happen — and with 22 sites it is not — the
-- edit must be paired with a guarded catch-up like this one. Both paths then
-- converge on the same schema: a fresh install gets the columns from 031 and
-- 041, an existing one gets them here, and IF NOT EXISTS makes the second a
-- no-op on the first.
-- ─────────────────────────────────────────────────────────────────────────

-- Where a text message reaches this person (PRD 36). See the column comment in
-- 041 for why it is local to the site rather than copied from upstream.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS mobile VARCHAR(40) NULL AFTER email;

-- Consent, per channel and per contact (PRD 17.3, 36, rule 14).
--
-- Email defaults ON and the two metered channels default OFF, which is the
-- existing behaviour written down: job mail already reaches whoever is on the
-- job, so defaulting it off would silently stop notifications that work today,
-- while defaulting SMS or WhatsApp on would start billing shops for messages
-- nobody asked for. The full reasoning is on the columns in 031.
ALTER TABLE customer_contacts
  ADD COLUMN IF NOT EXISTS consent_email    TINYINT(1) NOT NULL DEFAULT 1 AFTER notes,
  ADD COLUMN IF NOT EXISTS consent_sms      TINYINT(1) NOT NULL DEFAULT 0 AFTER consent_email,
  ADD COLUMN IF NOT EXISTS consent_whatsapp TINYINT(1) NOT NULL DEFAULT 0 AFTER consent_sms;
