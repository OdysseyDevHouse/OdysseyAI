-- ─────────────────────────────────────────────────────────────────────────
-- The money this shop counts.
--
-- 168 gave the cash-up a denomination TABLE rather than a constant, and said
-- why: "a site trading in another currency needs a different set entirely."
-- That was right, and then nothing was ever built to change it — the table has
-- exactly one reader (listDenominations) and no writer at all, so every site
-- counts its drawer in the twelve South African rows the migration seeded.
--
-- Customers trade in Namibia, Botswana and Canada. A Canadian cash-up asking a
-- cashier how many R200 notes are in the drawer is not a cosmetic problem: the
-- grid is the thing they are counting INTO, so the count cannot be done at all.
--
-- ── WHAT IS ACTUALLY MISSING ─────────────────────────────────────────────
--
-- Not the table. The table is fine — label, value, is_note, position,
-- is_active, and a UNIQUE on value so a duplicate R50 cannot double a count.
-- What is missing is a way to EDIT it, and one column: nothing records which
-- currency the rows are, so a screen offering to replace them has no way to say
-- what is there now.
--
-- ── WHY THE CODE LIVES IN `settings` AND NOT ON THE TABLE ────────────────
--
-- Because it describes the SET, not a row. Putting it on each denomination
-- would make it possible to store half a Canadian float — eleven ZAR rows and
-- one CAD — which is a state no screen could sensibly render and no cash-up
-- could reconcile. One shop, one currency, one row in the settings KV.
--
-- ── AND WHY THIS IS NOT online_store_settings.currency_code ──────────────
--
-- 190 added a currency to the STOREFRONT and was explicit that it stopped
-- there: "the back office, the POS and every printed document keep the Rand
-- default … Anyone widening it later starts here." This is that widening, and
-- it starts by not repeating 190's shape.
--
-- A shop's trading currency is not a property of its online store. A site with
-- the storefront module switched off still has one, still counts a drawer, and
-- still prints money on a slip. Reading it out of online_store_settings would
-- mean the cash-up screen depended on a module the shop may not own.
--
-- The two are left free to differ, deliberately. A shop CAN sell online in one
-- currency and bank in another; that is unusual, but the alternative is this
-- migration silently rewriting a storefront setting somebody chose on purpose.
-- ─────────────────────────────────────────────────────────────────────────

-- ISO 4217, and the symbol that goes in front of a number.
--
-- Both, for the reason 190 gives: the symbol is what a person reads and the
-- code is what a machine reads, and deriving either from the other is guesswork
-- — "$" is eight different currencies, and nothing about "ZAR" says the symbol
-- leads. ZAR/R keeps every existing site exactly as it is.
INSERT INTO settings (setting_key, setting_value) VALUES
  ('currency_code', 'ZAR'),
  ('currency_symbol', 'R')
  ON DUPLICATE KEY UPDATE setting_value = setting_value;

-- Which currency the rows in cash_denominations ARE.
--
-- Needed because the set is REPLACED rather than edited when a shop switches:
-- swapping twelve rand rows for eight Canadian ones is one act, and a screen
-- that cannot say "these are currently ZAR" cannot ask "replace them with CAD?"
-- without risking a half-converted grid.
--
-- On the row rather than derived from `settings.currency_code`, because the two
-- genuinely can disagree for a moment: a shop that changes its currency has not
-- yet replaced its denominations, and the screen must be able to SEE that
-- rather than assume it. That gap is what the setup screen exists to close.
ALTER TABLE cash_denominations
  ADD COLUMN IF NOT EXISTS currency_code VARCHAR(3) NOT NULL DEFAULT 'ZAR' AFTER value;

-- The UNIQUE on `value` alone was right while every row was rand and became
-- wrong the moment a set can be replaced: 1.00 is a rand coin AND a Canadian
-- loonie, and a shop switching to CAD could not insert its own 1.00 while the
-- old one existed. Uniqueness is per currency.
--
-- Dropped and re-added rather than altered: MariaDB has no ALTER INDEX, and the
-- IF EXISTS guards make this safe to re-run on a site that has already had it.
--
-- Standalone DROP INDEX, matching 092 and 164: MariaDB takes IF EXISTS in that
-- form, and the ALTER TABLE ... DROP INDEX IF EXISTS spelling is the one to
-- distrust. 164 learned that the hard way.
DROP INDEX IF EXISTS uq_denom_value ON cash_denominations;

ALTER TABLE cash_denominations
  ADD UNIQUE KEY IF NOT EXISTS uq_denom_currency_value (currency_code, value);
