-- ── A service-charge band may now be a flat amount ────────────────────────
--
-- The bands could only ever take a PERCENTAGE of the bill. That is the right
-- instrument for a restaurant's 10% service, and the wrong one for the two
-- cases shops actually asked for next: a flat delivery or tray charge, and a
-- small-order fee — "under R100, add R15" — where a percentage of a small bill
-- is too little to cover what it exists to cover.
--
-- Two columns rather than one, and a DISCRIMINATOR rather than "an amount
-- overrides the percent when it is set":
--
--   * zero is a legitimate value for either, so "unset" cannot be spelled as 0.
--     A shop that sets an amount of R0 means no charge on that band, not "fall
--     back to whatever is in percent".
--   * the old rows keep their percent untouched, so a band that was 10% stays
--     10% with no backfill guesswork and no chance of reading a 0.000 amount as
--     the charge.
--
-- `percent` keeps its NOT NULL DEFAULT and is simply ignored on an 'amount'
-- band, which is what makes this migration a pure addition: nothing already
-- stored changes meaning. See serviceChargeFor() in src/lib/tipMath.ts for the
-- matching rule, including why the overlap tie-break now compares the RESOLVED
-- charge instead of the percent — 10% and R25 are not comparable numbers.
--
-- 091_tips.sql is NOT edited: it is applied on both sites and
-- `schema_migrations` records by NAME, so an edit there would change nothing on
-- a database that has run it while quietly making the file disagree with
-- reality. That file says so itself.
--
-- DDL auto-commits, so every step here is re-runnable.

ALTER TABLE service_charge_tiers
  ADD COLUMN IF NOT EXISTS charge_kind ENUM('percent','amount') NOT NULL DEFAULT 'percent'
    AFTER max_total,
  ADD COLUMN IF NOT EXISTS charge_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00
    AFTER percent;

-- Every band that existed before this ran was a percentage one, which is what
-- the column default already says. Stated anyway so a re-run on a part-migrated
-- database cannot leave a row on the wrong side of the discriminator.
UPDATE service_charge_tiers SET charge_kind = 'percent' WHERE charge_kind IS NULL;
