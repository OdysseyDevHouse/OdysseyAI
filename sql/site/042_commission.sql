-- Commission.
--
-- `sales_reps.commission_pct` has existed since 012 with nothing calculating
-- from it, in the same way `products.max_discount_pct` sat unenforced until
-- 037. This is what finally gives it teeth — and replaces it, because one
-- percentage per person cannot express "8% on furniture, 1% on cigarettes".
--
-- ── WHY PROFIT AND NOT TURNOVER ─────────────────────────────────────────
--
-- Both bases are supported per rule, but profit is the default and the reason
-- is behavioural. On a turnover scheme a rand of discount costs the
-- salesperson only their rate — 2c in the rand — while costing the business
-- the whole rand of margin. Discounting is therefore nearly free to the person
-- giving it away. On a profit basis the discount comes out of their own
-- commission automatically, with nobody having to police it.
--
-- Turnover still earns its place: on a category where margin is fixed and
-- tiny, paying on profit produces figures too small to motivate anyone.
--
-- ── WHY THIS CAN BE TRUSTED ─────────────────────────────────────────────
--
-- Commission is only worth having if the number does not move after someone
-- has been paid. Three things make that true here:
--
--   1. `sales_document_lines.unit_cost_excl` is snapshotted at sale time
--      (015), so a supplier price change cannot rewrite last month's profit.
--   2. `commission_entries` records the rule, basis and rate that were used,
--      not just the answer — so a statement can be re-read years later even if
--      every rule has since been rewritten or deleted.
--   3. A run locks. Open means recalculable; locked means frozen.
--
-- ── VAT ─────────────────────────────────────────────────────────────────
--
-- Every figure here is EXCLUSIVE of VAT and NET of discount. That is the South
-- African norm, and on a profit basis it is arithmetically required: cost is
-- held excl. VAT, so the selling side must be too or every margin is inflated
-- by 15%.

-- ── Rules ───────────────────────────────────────────────────────────────
--
-- One rule = "who earns what, on which sales".
--
-- PRECEDENCE IS AN EXPLICIT NUMBER, not inferred from how specific the scope
-- is. Inferred hierarchies look elegant and break the first time someone wants
-- "the Defy promotion beats the furniture rate, even though brand is broader
-- than department". `priority` is seeded from specificity when a rule is
-- created and can then be overridden.
--
-- EXACTLY ONE RULE APPLIES PER LINE — the lowest priority number that matches.
-- Rules never stack. Stacking is how a line quietly earns 12% because three
-- overlapping rules all fired and nobody noticed.
CREATE TABLE commission_rules (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name          VARCHAR(120) NOT NULL,

  -- Lowest number wins. Ties broken by id, so the result is deterministic
  -- even when two rules are left on the same priority.
  priority      INT UNSIGNED NOT NULL DEFAULT 100,

  -- What the percentage is applied to.
  --   gross_profit — (line_total_excl - unit_cost_excl * qty)
  --   turnover     — line_total_excl
  basis         ENUM('gross_profit','turnover') NOT NULL DEFAULT 'gross_profit',

  -- ── Scope. All NULL = every line at this site. ────────────────────────
  --
  -- Several may be set at once, and all of them must match. A rule with both
  -- department and user set is "this person, selling furniture".
  --
  -- department_id matches the line's department INCLUDING descendants:
  -- "Furniture" is expected to cover "Furniture > Lounge" without anyone
  -- listing every child.
  department_id INT UNSIGNED NULL,
  product_id    INT UNSIGNED NULL,
  brand_id      INT UNSIGNED NULL,

  -- Supplier is many-to-many (013): a product is routinely available from
  -- several. A supplier rule therefore matches if ANY of the product's
  -- suppliers is this one — which means two supplier rules CAN both match one
  -- line, and priority is what decides. That ambiguity is inherent in the data
  -- model, not introduced here; brand_id is the unambiguous alternative.
  supplier_id   INT UNSIGNED NULL,

  -- Whose sales this applies to. NULL = anyone.
  user_id       INT UNSIGNED NULL,

  -- Turns a matching rule into an exclusion: lines it matches earn NOTHING and
  -- stop looking. "Everything in Appliances except clearance stock" needs this,
  -- and expressing it as a 0% rule would be indistinguishable from a rule
  -- somebody forgot to finish.
  is_exclusion  TINYINT(1)   NOT NULL DEFAULT 0,

  -- The flat rate, used when the rule has no tiers. Percent, so 8.5 = 8.5%.
  rate_pct      DECIMAL(6,3) NOT NULL DEFAULT 0.000,

  -- Commission only starts once the person's running total for the period
  -- passes this. Below it they earn nothing on this rule. Zero = no threshold.
  threshold     DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  is_active     TINYINT(1)   NOT NULL DEFAULT 1,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_commission_rule_priority (is_active, priority, id),
  KEY ix_commission_rule_dept (department_id),
  KEY ix_commission_rule_product (product_id),
  KEY ix_commission_rule_user (user_id),
  -- SET NULL, not CASCADE: deleting a department must not silently delete the
  -- commission rule that pointed at it and leave nobody paid. The rule widens
  -- to "everything", which is visible on the rules screen.
  CONSTRAINT fk_commission_rule_dept     FOREIGN KEY (department_id) REFERENCES departments (id) ON DELETE SET NULL,
  CONSTRAINT fk_commission_rule_product  FOREIGN KEY (product_id)    REFERENCES products (id)    ON DELETE SET NULL,
  CONSTRAINT fk_commission_rule_brand    FOREIGN KEY (brand_id)      REFERENCES brands (id)      ON DELETE SET NULL,
  CONSTRAINT fk_commission_rule_supplier FOREIGN KEY (supplier_id)   REFERENCES suppliers (id)   ON DELETE SET NULL,
  CONSTRAINT fk_commission_rule_user     FOREIGN KEY (user_id)       REFERENCES users (id)       ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Tiers ───────────────────────────────────────────────────────────────
--
-- Rate bands by the person's running total for the period. A rule with no tier
-- rows uses `rate_pct` flat.
--
-- MARGINAL, NOT RETROACTIVE. Each band's rate applies only to the slice of
-- earnings inside that band. Crossing 50,000 does NOT re-rate the first 50,000.
--
-- This matters more than it sounds. Under retroactive tiers, selling R249,999
-- versus R250,001 can be worth thousands, and the rational response is to hold
-- deals back and push them into whichever period pays best. Marginal tiers have
-- no cliff to game. Sage Pastel — which many users here will have come from —
-- is also incremental, so this matches the arithmetic they already expect.
CREATE TABLE commission_tiers (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  rule_id    INT UNSIGNED NOT NULL,

  -- Where this band starts, on the running period total of the rule's basis.
  -- The first band starts at 0; each subsequent band starts where the last
  -- ended. The top band has no end — it runs to infinity.
  from_amount DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  rate_pct    DECIMAL(6,3)  NOT NULL DEFAULT 0.000,

  PRIMARY KEY (id),
  UNIQUE KEY uq_commission_tier (rule_id, from_amount),
  CONSTRAINT fk_commission_tier_rule FOREIGN KEY (rule_id) REFERENCES commission_rules (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Runs ────────────────────────────────────────────────────────────────
--
-- A run is one period's commission for the whole site.
--
-- OPEN MEANS RECALCULABLE, LOCKED MEANS FROZEN. That distinction is the entire
-- reason anyone can trust these figures enough to pay on them. A locked run's
-- entries are never recomputed, never deleted, and survive the rules that
-- produced them being rewritten.
--
-- A credit note raised against a sale in a LOCKED period does not reopen it.
-- The clawback lands in the current open run as a negative entry, which is
-- both the industry norm and the only version that keeps a paid figure paid.
CREATE TABLE commission_runs (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- Inclusive both ends, matching how every other date range in this schema
  -- is expressed.
  period_start DATE NOT NULL,
  period_end   DATE NOT NULL,

  status       ENUM('open','locked') NOT NULL DEFAULT 'open',

  -- Set when it was last calculated, so a screen can say whether the figures
  -- on it are stale relative to sales captured since.
  calculated_at DATETIME NULL,
  locked_at     DATETIME NULL,
  locked_by_user_id INT UNSIGNED NULL,
  locked_by_name    VARCHAR(120) NULL,

  -- Header totals, so a list screen needs no join.
  total_amount DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  note         VARCHAR(400) NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  -- Two runs covering the same day would pay the same sale twice.
  UNIQUE KEY uq_commission_run_period (period_start, period_end),
  KEY ix_commission_run_status (status, period_start)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Entries ─────────────────────────────────────────────────────────────
--
-- One row per sale line that earned (or clawed back) commission.
--
-- EVERYTHING IS SNAPSHOTTED — the rule's name, the basis, the rate. A rule
-- renamed, re-rated or deleted next year must not change what a statement says
-- was paid last year, and a foreign key alone cannot promise that.
--
-- Kept at line level rather than summarised per person because the first
-- question anyone asks about a commission figure is "on what?", and a total
-- with no lines behind it cannot answer.
CREATE TABLE commission_entries (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  run_id       INT UNSIGNED NOT NULL,

  user_id      INT UNSIGNED NOT NULL,
  user_name    VARCHAR(120) NOT NULL DEFAULT '',

  -- The line this came from. SET NULL rather than CASCADE: a paid commission
  -- entry must outlive the document being purged, and the snapshots below
  -- carry enough to explain it.
  line_id      INT UNSIGNED NULL,
  document_id  INT UNSIGNED NULL,
  document_number VARCHAR(32) NULL,
  document_date   DATE NULL,
  -- 'invoice' or 'credit_note', so a statement can show clawbacks apart from
  -- earnings without joining back to a document that may be gone.
  doc_type     VARCHAR(24) NOT NULL DEFAULT 'invoice',

  product_code VARCHAR(48)  NULL,
  description  VARCHAR(200) NULL,

  rule_id      INT UNSIGNED NULL,
  rule_name    VARCHAR(120) NOT NULL DEFAULT '',
  basis        ENUM('gross_profit','turnover') NOT NULL DEFAULT 'gross_profit',

  -- The amount the rate was applied to — profit or turnover, excl. VAT, net of
  -- discount. Negative on a credit note.
  base_amount  DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  rate_pct     DECIMAL(6,3)  NOT NULL DEFAULT 0.000,
  -- base_amount * rate_pct / 100, rounded once, here. Stored rather than
  -- derived so the figure on the statement is the figure that was paid.
  amount       DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_commission_entry_run (run_id, user_id),
  KEY ix_commission_entry_user (user_id, document_date),
  KEY ix_commission_entry_line (line_id),
  CONSTRAINT fk_commission_entry_run  FOREIGN KEY (run_id)  REFERENCES commission_runs (id) ON DELETE CASCADE,
  CONSTRAINT fk_commission_entry_line FOREIGN KEY (line_id) REFERENCES sales_document_lines (id) ON DELETE SET NULL,
  CONSTRAINT fk_commission_entry_rule FOREIGN KEY (rule_id) REFERENCES commission_rules (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Settings ────────────────────────────────────────────────────────────
--
-- Site-wide switches that are not per-rule. Stored as settings rows rather
-- than columns on a one-row table, matching how 015 handles cash rounding.
--
--   commission_exclude_returns — when '1', credit notes earn no negative
--     entry at all. Some shops treat returns as a cost of business rather than
--     the salesperson's problem.
--
--   commission_returns_original_rep — when '1' (the default), a credit note
--     is charged to the rep on the ORIGINAL invoice line, not to whoever
--     happened to be at the till when the goods came back. Without this the
--     person who processes refunds slowly accumulates everyone else's
--     clawbacks, which is both wrong and demoralising.
--
--   commission_layby_on_completion — when '1' (the default), a lay-by earns
--     nothing until it is paid up. A lay-by that lapses was never a sale, and
--     paying commission at take-on means clawing it back later.
INSERT INTO settings (setting_key, setting_value) VALUES
  ('commission_exclude_returns',      '0'),
  ('commission_returns_original_rep', '1'),
  ('commission_layby_on_completion',  '1')
ON DUPLICATE KEY UPDATE setting_value = settings.setting_value;
