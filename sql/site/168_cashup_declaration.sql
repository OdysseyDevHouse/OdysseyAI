-- ── The detailed cash declaration ──────────────────────────────────────────
--
-- 016 gave a shift a count per tender: expected, counted, variance. That is the
-- arithmetic of a cash-up and it stays exactly as it was. What it is not is the
-- DECLARATION — the thing a supervisor signs, that says who counted, what notes
-- and coins were physically in the drawer, what the card machine's own slip
-- reported, and what went to the bank.
--
-- The difference matters because of what an auditor asks. "The drawer was
-- R693" is a conclusion. "Eleven R50 notes, six R20s, and R23 in coin" is a
-- COUNT, and only the second one can be checked by recounting the drawer.
--
-- ── WHY THE TENDER ROWS ARE NOT IN HERE ─────────────────────────────────────
--
-- The legacy screen has fixed slots — Other 1, Other 2, Other 3, Yoco, Rooms,
-- Dir. Deposit — and every shop sees all of them whether they use them or not.
-- tender_types is already a behaviour-flag table with a position column, so the
-- declaration generates one row per ACTIVE tender and shift_counts (016) still
-- holds them. A shop adding Yoco in Setup gets it on the cash-up with no
-- migration and no deploy; a shop that has never heard of Yoco never sees a box
-- that will always read zero.
--
-- So this migration adds the three things that genuinely have nowhere to live:
-- the denominations, the declaration header, and the counted grid.

-- ── What money this country is made of ─────────────────────────────────────
--
-- A TABLE rather than a constant in the code, because the list is not as fixed
-- as it looks. The R5 arrives as both a coin and (rarely) a note, the 5c was
-- withdrawn from circulation in 2012 while shops kept counting it for years,
-- and a site trading in another currency needs a different set entirely. None
-- of those should need a deploy.
--
-- is_note is not decoration: notes and coins are counted in separate piles and
-- a grid that interleaves them reads as an error to whoever is counting.
CREATE TABLE IF NOT EXISTS cash_denominations (
  id         INT UNSIGNED   NOT NULL AUTO_INCREMENT,

  -- What the cashier sees on the row: "R100", "50c".
  label      VARCHAR(24)    NOT NULL,

  -- The multiplier. DECIMAL, not an integer of cents: the grid multiplies this
  -- by a quantity and every other money column in this schema is DECIMAL(12,4).
  -- Mixing the two units is how a 20c row silently becomes R20.
  value      DECIMAL(12,4)  NOT NULL,

  is_note    TINYINT(1)     NOT NULL DEFAULT 0,

  -- Descending by value is the order a person counts in, so position is seeded
  -- that way rather than left to id.
  position   INT UNSIGNED   NOT NULL DEFAULT 0,
  is_active  TINYINT(1)     NOT NULL DEFAULT 1,

  created_at DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  -- One row per value. A duplicate R50 would double every count that used it,
  -- and the total would still look plausible.
  UNIQUE KEY uq_denom_value (value),
  KEY ix_denom_active (is_active, position)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- South African coin and note, largest first.
--
-- The 5c is included but INACTIVE: it was demonetised in 2012, yet shops with
-- old float in a safe still find them, and a site that wants it back should tick
-- a box rather than call support. Seeded with ON DUPLICATE KEY UPDATE so
-- re-running this migration never disturbs a site that has since edited them.
INSERT INTO cash_denominations (label, value, is_note, position, is_active) VALUES
  ('R200', 200.0000, 1, 10, 1),
  ('R100', 100.0000, 1, 20, 1),
  ('R50',   50.0000, 1, 30, 1),
  ('R20',   20.0000, 1, 40, 1),
  ('R10',   10.0000, 1, 50, 1),
  ('R5',     5.0000, 0, 60, 1),
  ('R2',     2.0000, 0, 70, 1),
  ('R1',     1.0000, 0, 80, 1),
  ('50c',    0.5000, 0, 90, 1),
  ('20c',    0.2000, 0, 100, 1),
  ('10c',    0.1000, 0, 110, 1),
  ('5c',     0.0500, 0, 120, 0)
  ON DUPLICATE KEY UPDATE value = VALUES(value);

-- ── The declaration itself ─────────────────────────────────────────────────
--
-- One row per cash-up. Separate from `shifts` rather than more columns on it,
-- for a reason that is not tidiness: a declaration is DRAFTED. Somebody counts
-- the drawer, pre-prints it, finds they miscounted the R20s, and counts again.
-- Those working figures must be storable without touching the shift, because a
-- half-finished count must never look like a closed one to any of the guards
-- that ask `closed_at IS NULL`.
--
-- The shift closes when the declaration is FINALIZED, and not before.
CREATE TABLE IF NOT EXISTS shift_declarations (
  id                 INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  shift_id           INT UNSIGNED  NOT NULL,

  -- ── WHO SIGNED IT ────────────────────────────────────────────────────────
  --
  -- Two people, because a cash-up is a handover and one name cannot describe
  -- it. The user is whose takings these are; the supervisor is who witnessed
  -- the count. On a one-person shop they are the same person and the screen
  -- defaults them that way — but the shape has to allow two or the control it
  -- represents does not exist.
  --
  -- Snapshotted names, like everywhere else: cp2_users lives in another
  -- database and a person who leaves must not blank the cash-ups they signed.
  user_id            INT UNSIGNED  NULL,
  user_name          VARCHAR(120)  NOT NULL DEFAULT '',
  supervisor_id      INT UNSIGNED  NULL,
  supervisor_name    VARCHAR(120)  NOT NULL DEFAULT '',

  -- ── THE FROZEN TOTALS ────────────────────────────────────────────────────
  --
  -- Everything below is derived at finalize and then never recomputed. The
  -- argument is the same one 016 makes for shift_counts: a figure somebody
  -- signed off must stay the figure on the report, even if a late sale, a
  -- re-rate, or a tender rename would change what a fresh query returns.
  --
  -- Nullable-free with 0.0000 defaults so a draft reads as zeros rather than
  -- as NULLs that every SUM downstream has to COALESCE.
  declared_cash      DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  expected_cash      DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  declared_total     DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  expected_total     DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  -- declared - expected. Negative is short, matching shifts.variance so the two
  -- can never be read with opposite signs.
  variance           DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  -- The float this shift opened on, copied here so the declaration is readable
  -- without joining the shift it came from.
  opening_float      DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  -- Non-sale drawer movement, split by direction. shift_movements stores these
  -- signed and summable, but the report shows payouts and pay-ins as separate
  -- lines and deriving one from a signed total loses which was which.
  payouts_total      DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  payins_total       DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  drops_total        DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  -- Turnover-side figures the legacy screen reconciles against. Each is a plain
  -- SUM at finalize time; see cashupDeclaration.ts for where each comes from.
  refunds_total      DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  rounding_total     DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  tips_total         DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  -- ── BANKING ──────────────────────────────────────────────────────────────
  --
  -- What actually left for the bank, against what the drawer said should. The
  -- difference is its own question: a drawer can reconcile perfectly and still
  -- have the wrong amount put in the bag.
  bank_declared      DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  bank_expected      DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  bank_reference     VARCHAR(60)   NULL,

  -- Required when the variance is outside tolerance, exactly as on shifts.
  variance_note      VARCHAR(400)  NULL,
  note               VARCHAR(400)  NULL,

  -- ── DRAFT UNTIL SIGNED ───────────────────────────────────────────────────
  --
  -- NULL while counting. Set once, at finalize, in the same transaction that
  -- closes the shift — so "is this cash-up done" has exactly one answer and it
  -- cannot disagree with shifts.closed_at.
  finalized_at       DATETIME      NULL,
  finalized_by_id    INT UNSIGNED  NULL,
  finalized_by_name  VARCHAR(120)  NULL,

  -- How many times it was pre-printed before being signed. Not bureaucracy: a
  -- declaration printed six times is a count somebody was struggling with, and
  -- that is worth seeing next to a variance.
  print_count        INT UNSIGNED  NOT NULL DEFAULT 0,

  created_at         DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  -- ONE declaration per shift. The screen upserts into it, so a second tab or a
  -- double-tapped button revises the draft rather than starting a rival count
  -- that could be finalized independently.
  UNIQUE KEY uq_declaration_shift (shift_id),
  KEY ix_declaration_finalized (finalized_at),
  CONSTRAINT fk_declaration_shift FOREIGN KEY (shift_id) REFERENCES shifts (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── The counted grid ───────────────────────────────────────────────────────
--
-- Quantity per denomination. The AUDITABLE half of the cash count: `amount` is
-- qty × value, stored rather than derived so the row still reads correctly if
-- somebody later edits what a "R5" is worth.
--
-- denomination_id is RESTRICT, not CASCADE: deleting a denomination that has
-- been counted would silently rewrite history, and the label snapshot below is
-- only half a defence against that.
CREATE TABLE IF NOT EXISTS shift_count_denominations (
  id              INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  declaration_id  INT UNSIGNED  NOT NULL,
  denomination_id INT UNSIGNED  NOT NULL,

  -- Snapshots, like tender_code/tender_name on shift_counts. A renamed or
  -- revalued denomination must not retrospectively change a signed count.
  label           VARCHAR(24)   NOT NULL,
  value           DECIMAL(12,4) NOT NULL,

  qty             INT UNSIGNED  NOT NULL DEFAULT 0,
  amount          DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  created_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_count_denom (declaration_id, denomination_id),
  CONSTRAINT fk_countdenom_declaration FOREIGN KEY (declaration_id)
    REFERENCES shift_declarations (id) ON DELETE CASCADE,
  CONSTRAINT fk_countdenom_denomination FOREIGN KEY (denomination_id)
    REFERENCES cash_denominations (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── What shift_counts was missing ──────────────────────────────────────────
--
-- 016 froze three money columns per tender and no counts at all. The legacy
-- report shows transaction counts beside the money — "13 card sales, R2 919.72"
-- — and that count cannot be recovered afterwards once a sale is voided or a
-- tender renamed, so it has to be frozen at the same moment as the money.
--
-- MariaDB syntax note: ADD COLUMN IF NOT EXISTS, never ADD CONSTRAINT IF NOT
-- EXISTS. Re-runnable so a site part-way through this migration can finish it.
ALTER TABLE shift_counts
  -- How many tender rows made up `expected`. Deliberately tender rows and not
  -- sales: a split-tender sale is one sale but two tenders, and the figure that
  -- belongs beside a per-tender total is the per-tender one.
  ADD COLUMN IF NOT EXISTS transaction_count INT UNSIGNED NOT NULL DEFAULT 0 AFTER variance,
  -- The float and drawer movements folded into this tender's expected figure.
  -- Only ever non-zero for a drawer-cash tender. Stored because the screen
  -- shows the build-up ("float 500 + takings 193") and recomputing it after the
  -- fact would need the movements to have stayed unchanged, which is exactly
  -- what freezing exists to stop depending on.
  ADD COLUMN IF NOT EXISTS float_included DECIMAL(12,4) NOT NULL DEFAULT 0.0000 AFTER transaction_count,
  ADD COLUMN IF NOT EXISTS movements_included DECIMAL(12,4) NOT NULL DEFAULT 0.0000 AFTER float_included;

-- Which declaration this count belongs to.
--
-- Nullable, and that is not laziness: every shift_counts row written before this
-- migration belongs to a cash-up that had no declaration, and backfilling a
-- fabricated one would invent a supervisor who never signed anything.
ALTER TABLE shift_counts
  ADD COLUMN IF NOT EXISTS declaration_id INT UNSIGNED NULL AFTER shift_id;

ALTER TABLE shift_counts
  ADD FOREIGN KEY IF NOT EXISTS fk_count_declaration (declaration_id)
    REFERENCES shift_declarations (id) ON DELETE SET NULL;
