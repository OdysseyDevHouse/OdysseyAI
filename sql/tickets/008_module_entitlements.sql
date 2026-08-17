-- What a site has BOUGHT, and who pays for it.
--
-- ── THE THREE AXES, AND WHY THIS IS A FOURTH ────────────────────────────────
--
-- The app already answers three different access questions, and this adds the
-- one that was missing:
--
--   may this person OPEN this store?   cp2_user_sites
--   may this person DO this thing?     the site database's roles/permissions
--   may this MACHINE ring up a sale?   cp2_devices
--   has this store BOUGHT this?        ← here
--
-- They must stay separate. A `loyalty` row here is not a `loyalty.view`
-- capability grant: buying Loyalty says the business pays for it, not that
-- every cashier may read member balances. Folding the two together would mean
-- a purchase silently widened everyone's permissions.
--
-- ── WHY A BILLING ACCOUNT IS NOT A STORE GROUP ──────────────────────────────
--
-- cp2_store_groups already links stores, but it links them for SHARING product
-- data. Who pays is a different question with a different shape: an operator
-- can own two unrelated shops that should appear on one debit order while
-- keeping entirely separate product files, and a franchise group can share a
-- product file across stores that each pay their own way. Reusing the group
-- for billing would make those two arrangements unrepresentable.
--
-- The backfill below nonetheless SEEDS accounts from store groups, which is not
-- a contradiction: a group is the best available evidence of "one operator"
-- when the billing tables are empty, and it is only a starting point. Once the
-- rows exist, a site moves between accounts freely and the two groupings drift
-- apart as they should.
--
-- ── THE CATALOGUE ───────────────────────────────────────────────────────────
--
--   starter             the base package, always on, never sold separately
--   inventory_advanced  counting, correcting, moving and tracing stock
--   multi_branch        one product file and consolidated reporting across stores
--   customers           accounts, statements, credit
--   online_store        the public shop front
--   loyalty             points, tiers and cards
--   job_cards           jobs from request to invoice
--   accounting          the general ledger and the financial statements
--   pos_device          a QUANTITY, not a feature — see cp2_devices
--
-- These strings are persisted, so they are permanent. src/lib/control/modules.ts
-- holds the same list as MODULE_KEYS and is the authority for the application;
-- this seed only ensures every one of them has a price row.
--
-- ── NOTE ON THE SHARED DATABASE ─────────────────────────────────────────────
--
-- odyssey_tickets is shared with the v2 backend. Everything here is new and
-- cp2_-prefixed; nothing existing is altered. There are deliberately NO foreign
-- keys to cp2_sites — that table is the v2 backend's, and constraining it from
-- this repo would couple the two products' deploys together.

-- ── Who pays ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cp2_billing_accounts (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name            VARCHAR(160) NOT NULL,
  -- Where the invoice goes. Deliberately NOT read from cp2_sites: a site's
  -- email is the shop's trading address, and the person who pays is very often
  -- not the person standing behind the counter.
  billing_email   VARCHAR(190) NULL,
  billing_contact VARCHAR(120) NULL,
  vat_number      VARCHAR(40)  NULL,
  -- The day of the month the period rolls over. Scheduled downgrades land on
  -- the day before this one.
  --
  -- Capped at 28 by the app, not by a constraint: a billing day of the 31st
  -- would skip February entirely, and a downgrade scheduled for a date that
  -- never arrives is a module the customer keeps being charged for.
  billing_day     TINYINT UNSIGNED NOT NULL DEFAULT 1,
  -- 'trial' bills nothing and gates nothing. 'suspended' is the seam a future
  -- dunning process writes to — nothing in this phase ever sets it, but the
  -- entitlement layer already reads it, so switching dunning on later is a data
  -- change rather than a schema change.
  status          ENUM('trial','active','suspended','closed') NOT NULL DEFAULT 'trial',
  -- The payment-gateway seam. Null forever in this phase. Two nullable columns
  -- rather than a table, because nobody can yet shape a table for a gateway
  -- that has not been chosen.
  gateway         VARCHAR(30)  NULL,
  gateway_ref     VARCHAR(120) NULL,
  currency        CHAR(3) NOT NULL DEFAULT 'ZAR',
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_ba_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Which stores that account pays for ─────────────────────────────────────
-- One row per site. A site is billed to exactly ONE account, which is what
-- makes "what is this month's bill" answerable at all — without the unique key
-- a site's modules could be counted on two accounts at once.
CREATE TABLE IF NOT EXISTS cp2_billing_account_sites (
  account_id INT UNSIGNED NOT NULL,
  site_id    INT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (account_id, site_id),
  UNIQUE KEY uq_bas_site (site_id),
  CONSTRAINT fk_bas_account FOREIGN KEY (account_id)
    REFERENCES cp2_billing_accounts (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── The price book ─────────────────────────────────────────────────────────
-- Prices live here rather than in code so a change is an UPDATE, not a deploy.
CREATE TABLE IF NOT EXISTS cp2_module_prices (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  module_key     VARCHAR(40) NOT NULL,
  -- Per site, per month, VAT-exclusive, in the account's currency.
  --
  -- DECIMAL and never FLOAT. src/lib/db.ts sets decimalNumbers:false, so this
  -- arrives as a string and is converted once, deliberately, rather than
  -- accumulating binary rounding error across a ten-store total.
  unit_price     DECIMAL(10,2) NOT NULL,
  -- DATE, not DATETIME. A price change is a calendar decision someone makes
  -- "from the 1st"; storing an instant would bill somebody the old price for
  -- one more hour and there would be no good way to explain why.
  effective_from DATE NOT NULL,
  -- NULL = still current. INCLUSIVE upper bound — the last day this price
  -- applies — matching how cp2_devices treats expiry_date. One convention
  -- across both licence systems, so nobody has to remember which is which.
  effective_to   DATE NULL,
  note           VARCHAR(200) NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  -- Two prices for one module starting the same day is an unanswerable
  -- question, so it cannot be stored.
  UNIQUE KEY uq_mp_module_from (module_key, effective_from),
  KEY ix_mp_lookup (module_key, effective_from, effective_to)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── What each site holds ───────────────────────────────────────────────────
--
-- ── HOW A DOWNGRADE WORKS, AND WHY THERE IS NO CRON JOB ─────────────────────
--
-- Removing a module does not delete the row. It stamps `ends_on` with the last
-- day of the period the customer has already paid for. The row keeps matching
-- the "live today" predicate until that date passes, and then stops.
--
-- That is the whole mechanism. Nothing has to run at midnight, which matters:
-- a scheduled job is a thing that can fail silently, and its failure mode here
-- would be a customer still holding — and still being charged for — a module
-- they cancelled weeks ago.
--
-- Re-adding before the end date is `ends_on = NULL` on the same row. The
-- customer never lost access, no second row is created, and a grandfathered
-- price survives untouched.
CREATE TABLE IF NOT EXISTS cp2_site_modules (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  site_id      INT UNSIGNED NOT NULL,
  module_key   VARCHAR(40) NOT NULL,
  -- 1 for every feature module. Kept on the row anyway so a future metered
  -- add-on does not need a second table and a second SUM.
  quantity     SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  -- Live on day D when starts_on <= D AND (ends_on IS NULL OR ends_on >= D).
  -- Inclusive at BOTH ends — see the note on cp2_module_prices.effective_to.
  starts_on    DATE NOT NULL,
  ends_on      DATE NULL,
  -- The price agreed when this row was created, copied from the book.
  --
  -- NULL means "charge today's price", which is what a new sale should do.
  -- A value PINS the rate: a shop sold Loyalty at R99 keeps R99 when the book
  -- moves to R149, and keeps it even if that R99 price row is later deleted.
  -- That last part is why this is a snapshot and not a foreign key.
  agreed_price DECIMAL(10,2) NULL,
  -- Snapshotted, with no foreign key behind it, for the same reason the audit
  -- trail elsewhere in this app carries names: the row has to still make sense
  -- to a support person after the user who made the change is gone.
  created_by   VARCHAR(120) NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  -- One row per (site, module, start date).
  --
  -- This does NOT prevent two overlapping live rows with different start dates
  -- — MySQL has no exclusion constraint. The write path closes the previous row
  -- before opening a new one, and the read takes the latest start; this key is
  -- the backstop for a path that ever skips that function, in the same spirit
  -- as the unique serial index behind claimSpot().
  UNIQUE KEY uq_sm_site_module_start (site_id, module_key, starts_on),
  -- The hot path: every module a site holds today, one index scan, no join.
  KEY ix_sm_site_live (site_id, ends_on, starts_on),
  KEY ix_sm_module (module_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── What was decided, and by whom ──────────────────────────────────────────
-- cp2_site_modules records STATE. This records DECISIONS.
--
-- "Who turned Loyalty off, and when?" cannot be answered from state alone once
-- the module has been added, removed and added again — the earlier rows say
-- what was held, not who chose it or when they chose it. This is the table a
-- support person opens during a billing dispute.
CREATE TABLE IF NOT EXISTS cp2_module_change_log (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  account_id   INT UNSIGNED NULL,
  site_id      INT UNSIGNED NOT NULL,
  module_key   VARCHAR(40) NOT NULL,
  action       ENUM('added','scheduled_removal','removal_cancelled','quantity_changed','removed')
               NOT NULL,
  -- The date the change takes effect: today for an upgrade, period end for a
  -- scheduled removal. Stored because it is the number the customer was shown
  -- when they agreed to it.
  effective_on DATE NOT NULL,
  quantity     SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  unit_price   DECIMAL(10,2) NULL,
  actor_name   VARCHAR(120) NULL,
  actor_email  VARCHAR(190) NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_mcl_site (site_id, created_at),
  KEY ix_mcl_account (account_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Seed: the catalogue ────────────────────────────────────────────────────
--
-- EVERY PRICE IS 0.00 ON PURPOSE. The whole reason prices live in this table is
-- that they can be set without a deploy — so they are set with an UPDATE after
-- this runs, by someone who knows what the product actually costs. A guessed
-- price shipped in a migration is worse than an obviously-blank one: the blank
-- is visibly unfinished on screen, whereas a plausible wrong number gets
-- invoiced.
--
--   UPDATE cp2_module_prices SET unit_price = 399.00 WHERE module_key = 'starter';
--
-- effective_from is deliberately far in the past so `starts_on <= today` holds
-- from the very first read. ON DUPLICATE KEY UPDATE keeps this file re-runnable
-- by hand, which the migration runner's contract requires, and — importantly —
-- re-running it must NOT reset a price somebody has since set, so the update
-- clause touches only the note.
INSERT INTO cp2_module_prices (module_key, unit_price, effective_from, note) VALUES
  ('starter',            0.00, '2020-01-01', 'Base package — always included. Set the real price.'),
  ('inventory_advanced', 0.00, '2020-01-01', 'Set the real price.'),
  ('multi_branch',       0.00, '2020-01-01', 'Set the real price.'),
  ('customers',          0.00, '2020-01-01', 'Set the real price.'),
  ('online_store',       0.00, '2020-01-01', 'Set the real price.'),
  ('loyalty',            0.00, '2020-01-01', 'Set the real price.'),
  ('job_cards',          0.00, '2020-01-01', 'Set the real price.'),
  -- The double-entry layer only. The cashbook, expenses and the VAT return are
  -- part of the base package — every shop banks money and pays bills.
  ('accounting',         0.00, '2020-01-01', 'The general ledger and financial statements.'),
  ('pos_device',         0.00, '2020-01-01', 'Per till, per month. Set the real price.')
ON DUPLICATE KEY UPDATE note = VALUES(note);

-- ── Backfill: nobody loses anything the morning this deploys ───────────────
--
-- This is the most important part of the file. Every existing site gets a
-- billing account and a Starter Pack row. Miss a site here and its owner signs
-- in tomorrow to a back office with half the menu gone, indistinguishable from
-- a bug.
--
-- 'suspended' is included alongside 'active' deliberately: sites.ts lets a
-- suspended site still be opened so its owner can settle the account, and
-- locking them out of the screen where they would do that is exactly backwards.
--
-- ── WHICH SITES SHARE AN ACCOUNT ───────────────────────────────────────────
--
-- A site already in a cp2_store_groups group joins ONE account for that whole
-- group; a site in no group gets its own. That is the closest thing to a
-- statement of "these stores belong to one operator" the database already
-- holds — linking two stores requires credentials for both, so a group is
-- something somebody deliberately set up rather than a guess.
--
-- It is deliberately NOT inferred from anything softer. Matching on
-- company_name would merge two unrelated customers who registered under the
-- same legal name; matching on billing email would merge every store a
-- bookkeeper administers. Both produce one wrong debit order per guess, and a
-- wrongly merged bill is far harder to notice than a wrongly split one.
--
-- Grouping for BILLING and grouping for PRODUCT SHARING remain separate
-- concepts — see the header. This only uses the latter as the starting guess
-- for the former, and an operator who wants them different moves the site to
-- another account afterwards, which the schema allows freely.
--
-- `gateway_ref` carries the group or site key during the backfill purely so the
-- mapping below can find the row it just created. It is cleared immediately
-- afterwards, before the payment provider ever has an opinion about it.

-- One account per store GROUP, named after the group.
INSERT INTO cp2_billing_accounts
       (name, billing_email, billing_contact, vat_number, status, gateway, gateway_ref)
SELECT g.name,
       MIN(s.email), MIN(s.contact_name), MIN(s.vat_number), 'active',
       'backfill', CONCAT('group:', g.id)
  FROM cp2_store_groups g
  JOIN cp2_store_group_members gm ON gm.group_id = g.id
  JOIN cp2_sites s ON s.id = gm.site_id
 WHERE g.status = 'active'
   AND s.status IN ('active', 'suspended')
   AND NOT EXISTS (
     SELECT 1 FROM cp2_billing_account_sites bas WHERE bas.site_id = s.id
   )
   AND NOT EXISTS (
     SELECT 1 FROM cp2_billing_accounts a2 WHERE a2.gateway_ref = CONCAT('group:', g.id)
   )
 GROUP BY g.id, g.name;

INSERT INTO cp2_billing_account_sites (account_id, site_id)
SELECT a.id, gm.site_id
  FROM cp2_billing_accounts a
  JOIN cp2_store_group_members gm
    ON gm.group_id = CAST(SUBSTRING(a.gateway_ref, 7) AS UNSIGNED)
  JOIN cp2_sites s ON s.id = gm.site_id
 WHERE a.gateway = 'backfill'
   AND a.gateway_ref LIKE 'group:%'
   AND s.status IN ('active', 'suspended')
   AND NOT EXISTS (
     SELECT 1 FROM cp2_billing_account_sites bas WHERE bas.site_id = gm.site_id
   );

-- Then one account per remaining ungrouped site.
INSERT INTO cp2_billing_accounts
       (name, billing_email, billing_contact, vat_number, status, gateway, gateway_ref)
SELECT s.company_name, s.email, s.contact_name, s.vat_number, 'active',
       'backfill', CONCAT('site:', s.id)
  FROM cp2_sites s
 WHERE s.status IN ('active', 'suspended')
   AND NOT EXISTS (
     SELECT 1 FROM cp2_billing_account_sites bas WHERE bas.site_id = s.id
   );

INSERT INTO cp2_billing_account_sites (account_id, site_id)
SELECT a.id, CAST(SUBSTRING(a.gateway_ref, 6) AS UNSIGNED)
  FROM cp2_billing_accounts a
 WHERE a.gateway = 'backfill'
   AND a.gateway_ref LIKE 'site:%'
   AND NOT EXISTS (
     SELECT 1 FROM cp2_billing_account_sites bas
      WHERE bas.site_id = CAST(SUBSTRING(a.gateway_ref, 6) AS UNSIGNED)
   );

-- The marker has done its job; the gateway columns belong to the payment
-- provider, not to this migration.
UPDATE cp2_billing_accounts
   SET gateway = NULL, gateway_ref = NULL
 WHERE gateway = 'backfill';

-- The Starter Pack: every site, from today, open-ended.
INSERT INTO cp2_site_modules (site_id, module_key, quantity, starts_on, created_by)
SELECT s.id, 'starter', 1, CURDATE(), 'migration 008'
  FROM cp2_sites s
 WHERE s.status IN ('active', 'suspended')
   AND NOT EXISTS (
     SELECT 1 FROM cp2_site_modules sm
      WHERE sm.site_id = s.id AND sm.module_key = 'starter'
   );
