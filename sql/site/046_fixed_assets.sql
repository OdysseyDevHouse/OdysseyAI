-- Fixed assets — what the business owns and uses, rather than sells.
--
-- 042 already separates capital spending from operating cost: an expense
-- category typed 'capital' is kept OUT of the profit and loss because a laptop
-- is not a cost of trading, it is a thing the business now owns. What has been
-- missing is the other half of that sentence — the asset itself, and the
-- depreciation that turns it into a cost slowly, over the years it is used.
--
-- Without this, a business that buys a R300 000 bakkie shows it nowhere: not as
-- a cost (correctly), and not as an asset either (incorrectly), so the balance
-- sheet understates what the business is worth by everything it has ever
-- bought.
--
-- ── STRAIGHT LINE ONLY, DELIBERATELY ─────────────────────────────────────
--
-- (cost − residual) ÷ useful life, spread evenly. That is what the SARS
-- wear-and-tear allowances in Interpretation Note 47 assume, what almost every
-- small business uses, and what an accountant expects unless told otherwise.
--
-- Reducing balance is not supported. It never fully depreciates an asset, so it
-- needs a write-off rule at the end that is one more thing to get wrong, and
-- the businesses using this system do not need it. `depreciation_method` exists
-- as a column anyway so adding one later is data rather than a migration.
--
-- ── THE REGISTER IS THE SOURCE OF TRUTH ──────────────────────────────────
--
-- Same shape as everything else here: the register owns
-- accumulated_depreciation, the GL mirrors it, and reconciliation proves they
-- agree. See 045 on why the ledger is a derived mirror.

CREATE TABLE asset_categories (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name            VARCHAR(120) NOT NULL,
  code            VARCHAR(24)  NULL,

  -- The default life for assets of this kind, in months. A category exists
  -- mainly so that "vehicles depreciate over 5 years" is stated once rather
  -- than typed onto every vehicle.
  default_life_months SMALLINT UNSIGNED NOT NULL DEFAULT 36,
  -- What it is expected to be worth at the end, as a percentage of cost.
  -- Vehicles keep value; a laptop does not.
  default_residual_pct DECIMAL(5,2) NOT NULL DEFAULT 0.00,

  -- ── WHERE IT POSTS ───────────────────────────────────────────────────
  --
  -- Three accounts, because that is what depreciation needs:
  --   cost      — the asset at what it was bought for. Never changes.
  --   accum     — accumulated depreciation, a NEGATIVE asset that grows.
  --   expense   — the depreciation charge for the period.
  --
  -- Cost and accumulated are kept SEPARATE rather than netted into one
  -- account, because "we own R300 000 of vehicles, R180 000 depreciated" is
  -- the information; "we own R120 000 of vehicles" throws away both the
  -- original cost and the age of the fleet.
  cost_account_id     INT UNSIGNED NULL,
  accum_account_id    INT UNSIGNED NULL,
  expense_account_id  INT UNSIGNED NULL,

  is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
  sort_order      INT          NOT NULL DEFAULT 0,
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY ix_assetcat_active (is_active, sort_order),
  CONSTRAINT fk_assetcat_cost  FOREIGN KEY (cost_account_id)    REFERENCES gl_accounts (id) ON DELETE SET NULL,
  CONSTRAINT fk_assetcat_accum FOREIGN KEY (accum_account_id)   REFERENCES gl_accounts (id) ON DELETE SET NULL,
  CONSTRAINT fk_assetcat_exp   FOREIGN KEY (expense_account_id) REFERENCES gl_accounts (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One thing the business owns.
CREATE TABLE fixed_assets (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,

  asset_code      VARCHAR(32)  NOT NULL,
  name            VARCHAR(160) NOT NULL,
  description     VARCHAR(400) NULL,
  category_id     INT UNSIGNED NOT NULL,

  -- What identifies it in the real world: a VIN, a serial number, a licence
  -- plate. The field an insurer or an auditor asks for.
  serial_number   VARCHAR(120) NULL,
  location        VARCHAR(160) NULL,

  --   active    — in use, depreciating
  --   disposed  — sold, scrapped or written off. Stops depreciating.
  --   pending   — recorded but not yet in use, so not yet depreciating.
  --               A vehicle bought in March and delivered in May earns no
  --               depreciation for those two months.
  status          ENUM('pending','active','disposed') NOT NULL DEFAULT 'active',

  -- ── THE FIGURES DEPRECIATION IS BUILT FROM ───────────────────────────
  acquired_on     DATE          NOT NULL,
  -- Excluding VAT where it was claimable, because reclaimed VAT was never a
  -- cost. The expense that created the asset already made that split.
  cost            DECIMAL(14,4) NOT NULL DEFAULT 0.0000,
  -- What it is expected to be worth at the end of its life. Depreciation runs
  -- from cost DOWN TO this, never below it.
  residual_value  DECIMAL(14,4) NOT NULL DEFAULT 0.0000,
  life_months     SMALLINT UNSIGNED NOT NULL DEFAULT 36,
  -- The month depreciation starts. Usually the month of acquisition, but a
  -- machine commissioned three months after delivery starts when it is used.
  depreciation_start DATE       NOT NULL,
  depreciation_method ENUM('straight_line') NOT NULL DEFAULT 'straight_line',

  -- Maintained by the depreciation runs, in the same transaction as the run
  -- item that moves it. THE INVARIANT: this always equals the sum of posted
  -- depreciation_run_items for this asset. reconcileAssets() proves it.
  accumulated_depreciation DECIMAL(14,4) NOT NULL DEFAULT 0.0000,
  -- The last period charged, so a run cannot charge the same month twice.
  last_depreciated_to DATE      NULL,

  -- ── WHERE IT CAME FROM ───────────────────────────────────────────────
  -- The expense that bought it, when one did. Lets a capital expense become an
  -- asset in one step rather than being re-keyed, and lets the asset point
  -- back at its invoice for an auditor.
  expense_id      INT UNSIGNED NULL,
  supplier_id     INT UNSIGNED NULL,
  invoice_number  VARCHAR(60)  NULL,

  -- ── DISPOSAL ─────────────────────────────────────────────────────────
  disposed_on     DATE          NULL,
  -- What it was sold for. Zero for something scrapped.
  disposal_proceeds DECIMAL(14,4) NULL,
  -- proceeds − book value at disposal. Positive is a profit on sale, which is
  -- income; negative is a loss. Stored because it is what the journal posted
  -- and must stay explicable after the fact.
  disposal_result DECIMAL(14,4) NULL,
  disposal_reason VARCHAR(400)  NULL,

  notes           TEXT         NULL,
  user_id         INT UNSIGNED NULL,
  user_name       VARCHAR(120) NOT NULL DEFAULT '',
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_asset_code (asset_code),
  KEY ix_asset_status (status, acquired_on),
  KEY ix_asset_category (category_id),
  KEY ix_asset_expense (expense_id),
  KEY ix_asset_supplier (supplier_id),
  CONSTRAINT fk_asset_category FOREIGN KEY (category_id) REFERENCES asset_categories (id) ON DELETE RESTRICT,
  CONSTRAINT fk_asset_expense  FOREIGN KEY (expense_id)  REFERENCES expenses (id) ON DELETE SET NULL,
  CONSTRAINT fk_asset_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A depreciation run: propose, review, post.
--
-- The same shape as an interest run or a payment run, and for the same reason.
-- Depreciation is a real journal against the profit and loss — an asset entered
-- with the wrong life quietly misstates profit every month until somebody
-- notices — so the figures are shown before they are posted.
CREATE TABLE depreciation_runs (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- The month being charged. Depreciation is monthly: it is the smallest
  -- period a straight-line calculation divides into cleanly, and it lines up
  -- with how a management account is read.
  period_month    DATE         NOT NULL,

  status          ENUM('draft','posted','cancelled') NOT NULL DEFAULT 'draft',

  total_amount    DECIMAL(14,4) NOT NULL DEFAULT 0.0000,
  asset_count     INT UNSIGNED NOT NULL DEFAULT 0,
  posted_count    INT UNSIGNED NOT NULL DEFAULT 0,

  -- The journal this produced. Reversing it is how a run is undone.
  batch_id        INT UNSIGNED NULL,

  notes           VARCHAR(400) NULL,
  user_id         INT UNSIGNED NULL,
  user_name       VARCHAR(120) NOT NULL DEFAULT '',
  posted_at       DATETIME     NULL,
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  -- One posted run per month. A second would double-charge, and catching that
  -- in code alone leaves a race between two people pressing Post.
  UNIQUE KEY uq_deprun_month (period_month, status),
  KEY ix_deprun_status (status, period_month),
  CONSTRAINT fk_deprun_batch FOREIGN KEY (batch_id) REFERENCES journal_batches (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One asset's charge for one month, with the workings kept.
--
-- The workings matter for the same reason they do on an interest run: "why is
-- depreciation R5 958 this month" must be answerable from the screen, not by
-- re-deriving it from the register.
CREATE TABLE depreciation_run_items (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  run_id          INT UNSIGNED NOT NULL,
  asset_id        INT UNSIGNED NOT NULL,
  asset_code      VARCHAR(32)  NOT NULL,
  asset_name      VARCHAR(160) NOT NULL,

  -- Snapshotted so a life changed next year does not re-explain this month.
  cost            DECIMAL(14,4) NOT NULL DEFAULT 0.0000,
  residual_value  DECIMAL(14,4) NOT NULL DEFAULT 0.0000,
  life_months     SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  -- Accumulated BEFORE this charge, so the arithmetic can be shown in full.
  opening_accumulated DECIMAL(14,4) NOT NULL DEFAULT 0.0000,

  amount          DECIMAL(14,4) NOT NULL DEFAULT 0.0000,

  --   pending — proposed, not yet charged
  --   posted  — the register and the ledger have moved
  --   skipped — fully depreciated, disposed, or not yet in use
  status          ENUM('pending','posted','skipped') NOT NULL DEFAULT 'pending',
  skip_reason     VARCHAR(190) NULL,

  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_depitem_run (run_id, asset_name),
  KEY ix_depitem_asset (asset_id),
  CONSTRAINT fk_depitem_run   FOREIGN KEY (run_id)   REFERENCES depreciation_runs (id) ON DELETE CASCADE,
  CONSTRAINT fk_depitem_asset FOREIGN KEY (asset_id) REFERENCES fixed_assets (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Seed categories, mapped to the accounts 045 already created ──────────
--
-- The GL accounts exist (1500/1510 equipment, 1600/1610 vehicles, 6180
-- depreciation) and have been waiting for this. Lives follow the SARS
-- wear-and-tear write-off periods in Interpretation Note 47, which is what a
-- South African accountant will expect and what most businesses adopt
-- unchanged.

INSERT INTO asset_categories
  (name, code, default_life_months, default_residual_pct,
   cost_account_id, accum_account_id, expense_account_id, sort_order)
SELECT
  'Equipment', 'EQUIP', 36, 0.00,
  (SELECT id FROM gl_accounts WHERE account_code = '1500'),
  (SELECT id FROM gl_accounts WHERE account_code = '1510'),
  (SELECT id FROM gl_accounts WHERE account_code = '6180'),
  10
UNION ALL SELECT
  -- Computers: 3 years per IN47.
  'Computers', 'COMP', 36, 0.00,
  (SELECT id FROM gl_accounts WHERE account_code = '1500'),
  (SELECT id FROM gl_accounts WHERE account_code = '1510'),
  (SELECT id FROM gl_accounts WHERE account_code = '6180'),
  20
UNION ALL SELECT
  -- Furniture and fittings: 6 years.
  'Furniture and fittings', 'FURN', 72, 0.00,
  (SELECT id FROM gl_accounts WHERE account_code = '1500'),
  (SELECT id FROM gl_accounts WHERE account_code = '1510'),
  (SELECT id FROM gl_accounts WHERE account_code = '6180'),
  30
UNION ALL SELECT
  -- Vehicles: 5 years, and they keep real value, so a residual is the norm.
  'Vehicles', 'VEH', 60, 20.00,
  (SELECT id FROM gl_accounts WHERE account_code = '1600'),
  (SELECT id FROM gl_accounts WHERE account_code = '1610'),
  (SELECT id FROM gl_accounts WHERE account_code = '6180'),
  40;

-- Where a disposal's profit or loss lands. Profit on sale is other income; a
-- loss is a cost. One account either way, signed — splitting them into two
-- would mean every disposal picks an account based on its outcome.
INSERT INTO gl_mappings (mapping_key, ref_id, account_id)
SELECT 'asset_disposal', NULL, id FROM gl_accounts WHERE account_code = '4900';

-- The numbering sequence for assets.
INSERT IGNORE INTO document_sequences (doc_type, prefix, next_number, padding, reset_period)
VALUES ('asset', 'FA', 1, 5, 'none');
