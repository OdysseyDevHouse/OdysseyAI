-- Loyalty — points, tiers, punch cards, vouchers and a stored-value wallet.
--
-- ── POINTS ARE A LEDGER, NEVER A BALANCE COLUMN ──────────────────────────
--
-- Every event — earning on a sale, spending at the till, expiring, a manual
-- correction, a refund clawing points back — appends one immutable row, and the
-- balance is SUM(points). A balance column would be a read-modify-write, so two
-- tills crediting the same customer at the same moment would race and one
-- event would silently vanish. It also buys the audit trail for free: "why does
-- she have 1 240 points" is answerable, and a refund becomes an ordinary entry
-- rather than a destructive edit to a number nobody can explain.
--
-- `loyalty_members.points_balance` is a CACHE of that sum, refreshed inside
-- every write transaction so the till can show a figure without summing the
-- whole history. It is always recomputable and is never read to make a
-- decision — every spend re-reads the ledger under a lock.
--
-- ── TIER STANDING IS MEASURED IN SPEND, NOT IN POINTS ─────────────────────
--
-- Each earning row also records `basis_amount`: the rand value the points were
-- earned on. Tier qualification sums THAT over a rolling window, never the
-- points balance. Getting this wrong is the classic loyalty bug — a customer
-- spends their points on a reward and is demoted from Gold for having done
-- exactly what the programme invited them to do.
--
-- ── THE WALLET IS MONEY, AND STAYS SEPARATE FROM POINTS ───────────────────
--
-- Points are earned and priced through a redemption rate. Wallet rand is money
-- the customer already handed over ("put R200 on my card") and spends 1:1.
-- Merging them would mean either pricing real cash through the points rate — so
-- changing that rate silently revalues money people already paid in — or losing
-- the audit line between money taken and points granted. Every rand of float
-- liability the shop is carrying has a row behind it.
--
-- ── HOW THIS DIFFERS FROM THE OLD DESKTOP SCHEME ──────────────────────────
--
-- The old system keyed loyalty off a customer CODE string and stored redemption
-- in a general-purpose "Other 1" tender slot that stores had to rename by hand.
-- Here a member is a real foreign key to `customers`, and redemption is an
-- ordinary `tender_types` row with `integration_key = 'loyalty'` — the till
-- already knows how to render, split and validate one of those, so points and
-- wallet spend need no special case in the tender engine.

-- ── Members ──────────────────────────────────────────────────────────────
--
-- One row per customer who has any loyalty standing. A customer with no row has
-- simply never transacted on the programme; readers treat that as "enrolled,
-- zero balance" rather than "not a member", because the programme is open to
-- every account and a missing row must not read as an exclusion.
--
-- Keyed BY customer_id rather than carrying its own id: there is exactly one
-- loyalty standing per customer, and a surrogate key would allow two.
CREATE TABLE IF NOT EXISTS loyalty_members (
  customer_id      INT UNSIGNED NOT NULL,

  is_active        TINYINT(1) NOT NULL DEFAULT 1,

  -- Cached SUM(points) from loyalty_ledger. Display only, always recomputable.
  points_balance   DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  -- Cached SUM(amount) from loyalty_wallet. Same contract.
  wallet_balance   DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  -- The tier they currently sit in, by name so a renamed tier does not orphan
  -- the row, plus when they reached it and when it is next reviewed.
  -- Downgrades happen only ON REVIEW, never the instant qualifying spend dips:
  -- a customer who has a quiet month should not lose Gold on a Tuesday.
  tier_id          INT UNSIGNED NULL,
  tier_since       DATETIME NULL,
  tier_review_date DATE NULL,

  joined_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Last earn or spend — drives activity-based points expiry.
  last_activity_at DATETIME NULL,

  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (customer_id),
  KEY idx_member_tier (tier_id),
  KEY idx_member_activity (last_activity_at),
  CONSTRAINT fk_loyalty_member_customer FOREIGN KEY (customer_id)
    REFERENCES customers (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Tiers ────────────────────────────────────────────────────────────────
--
-- Bronze / Silver / Gold / Platinum by default, fully editable. A customer sits
-- in the highest tier whose `qualifying_spend` they have met over the window.
--
-- `step` orders the ladder rather than the id, because a store tuning its
-- programme inserts a tier between two existing ones and the ids are already
-- taken.
CREATE TABLE IF NOT EXISTS loyalty_tiers (
  id               INT UNSIGNED NOT NULL AUTO_INCREMENT,

  name             VARCHAR(40) NOT NULL,
  step             SMALLINT UNSIGNED NOT NULL,

  -- Rolling-window spend needed to reach this tier. The entry tier is 0.
  qualifying_spend DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  -- Points earned here are multiplied by this. 1 = base rate, 2 = double points.
  multiplier       DECIMAL(6,3) NOT NULL DEFAULT 1.000,
  -- An optional standing discount for members of this tier.
  discount_pct     DECIMAL(6,3) NOT NULL DEFAULT 0.000,

  -- A design-system token name (not a hex value — see AGENTS.md), so the badge
  -- restyles with the rest of the app.
  color            VARCHAR(40) NOT NULL DEFAULT '',

  is_active        TINYINT(1) NOT NULL DEFAULT 1,

  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_tier_name (name),
  UNIQUE KEY uq_tier_step (step)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The starting ladder. INSERT IGNORE so re-running the migration by hand after
-- a store has renamed or retuned its tiers does not resurrect the defaults.
INSERT IGNORE INTO loyalty_tiers (name, step, qualifying_spend, multiplier, discount_pct, color) VALUES
  ('Bronze',    1,     0.0000, 1.000, 0.000, 'muted'),
  ('Silver',    2,  5000.0000, 1.250, 0.000, 'info'),
  ('Gold',      3, 15000.0000, 1.500, 2.000, 'warning'),
  ('Platinum',  4, 40000.0000, 2.000, 5.000, 'brand');

-- Members point at a tier, so the FK is added once the table it references
-- exists. Left as SET NULL rather than RESTRICT: deleting a retired tier should
-- drop its members to "no tier" and let the next review re-place them, not
-- refuse the delete forever.
ALTER TABLE loyalty_members
  ADD CONSTRAINT fk_loyalty_member_tier FOREIGN KEY (tier_id)
    REFERENCES loyalty_tiers (id) ON DELETE SET NULL;

-- ── The points ledger ────────────────────────────────────────────────────
--
-- The source of truth. `points` is SIGNED: positive when earned or adjusted up,
-- negative when spent, expired or clawed back.
CREATE TABLE IF NOT EXISTS loyalty_ledger (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

  customer_id    INT UNSIGNED NOT NULL,

  -- earn     — granted by a sale
  -- redeem   — spent against a sale
  -- expire   — lapsed under the expiry policy
  -- adjust   — a manual correction or goodwill gesture, either sign
  -- reverse  — a refunded sale taking its points back
  entry_type     ENUM('earn','redeem','expire','adjust','reverse') NOT NULL,

  points         DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  -- The rand value these points were earned on. Earn rows only. Summed over the
  -- rolling window for tier standing — deliberately NOT derived from `points`,
  -- so spending points can never cost a customer their tier.
  basis_amount   DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  -- The sale this came from, when it came from one.
  document_id    INT UNSIGNED NULL,
  document_number VARCHAR(40) NOT NULL DEFAULT '',

  -- The tier in force when the row was written, and the multiplier it applied.
  -- Snapshotted, not joined: re-tuning the ladder next year must not rewrite
  -- the history of what was actually granted.
  tier_name      VARCHAR(40) NOT NULL DEFAULT '',
  multiplier     DECIMAL(6,3) NOT NULL DEFAULT 1.000,

  note           VARCHAR(255) NOT NULL DEFAULT '',

  -- Who did it. The name is snapshotted so a deleted user does not erase the
  -- authorship of a points adjustment.
  user_id        INT UNSIGNED NULL,
  user_name      VARCHAR(120) NOT NULL DEFAULT '',

  created_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (id),
  KEY idx_ledger_customer (customer_id, created_at),
  KEY idx_ledger_document (document_id),
  KEY idx_ledger_type_date (entry_type, created_at),

  -- What makes a retried finalise safe. A sale may grant points exactly once;
  -- a SELECT ... FOR UPDATE cannot lock a row that does not exist yet, so two
  -- concurrent first-ever awards would both find nothing and both insert. This
  -- lets the database arbitrate — the loser gets a duplicate-key error and
  -- awards nothing.
  UNIQUE KEY uq_ledger_document_earn (document_id, entry_type),

  CONSTRAINT fk_loyalty_ledger_customer FOREIGN KEY (customer_id)
    REFERENCES customers (id) ON DELETE CASCADE,
  CONSTRAINT fk_loyalty_ledger_document FOREIGN KEY (document_id)
    REFERENCES sales_documents (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── The wallet ───────────────────────────────────────────────────────────
--
-- Rand stored value. Append-only for the same reasons as the points ledger, and
-- separate from it for the reasons in the header.
CREATE TABLE IF NOT EXISTS loyalty_wallet (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

  customer_id    INT UNSIGNED NOT NULL,

  -- topup  — money in at the till (positive)
  -- spend  — settled against a sale (negative)
  -- refund — a reversed sale giving the money back (positive)
  -- adjust — a manual correction, either sign
  entry_type     ENUM('topup','spend','refund','adjust') NOT NULL,

  -- SIGNED rand: positive credits the customer, negative debits them.
  amount         DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  -- How the money ARRIVED, on top-up rows. A top-up takes real cash or a card
  -- payment, and the cash-up has to see it or the drawer will not balance
  -- against a day that included top-ups.
  tender_type_id INT UNSIGNED NULL,
  -- Which shift banked it, stamped at the moment of the top-up.
  shift_id       INT UNSIGNED NULL,
  terminal_id    INT UNSIGNED NULL,

  document_id    INT UNSIGNED NULL,
  document_number VARCHAR(40) NOT NULL DEFAULT '',

  note           VARCHAR(255) NOT NULL DEFAULT '',

  user_id        INT UNSIGNED NULL,
  user_name      VARCHAR(120) NOT NULL DEFAULT '',

  created_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (id),
  KEY idx_wallet_customer (customer_id, created_at),
  KEY idx_wallet_document (document_id),
  -- The cash-up reads top-ups for a shift; both columns are in the key so it
  -- can scope by shift without a filesort.
  KEY idx_wallet_shift (shift_id, entry_type),
  KEY idx_wallet_type_date (entry_type, created_at),

  -- One wallet spend per sale, for the same reason the ledger has one.
  UNIQUE KEY uq_wallet_document_spend (document_id, entry_type),

  CONSTRAINT fk_loyalty_wallet_customer FOREIGN KEY (customer_id)
    REFERENCES customers (id) ON DELETE CASCADE,
  CONSTRAINT fk_loyalty_wallet_document FOREIGN KEY (document_id)
    REFERENCES sales_documents (id) ON DELETE SET NULL,
  CONSTRAINT fk_loyalty_wallet_tender FOREIGN KEY (tender_type_id)
    REFERENCES tender_types (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Punch cards ──────────────────────────────────────────────────────────
--
-- "Buy ten coffees, the eleventh is free." A card defines WHAT earns a stamp
-- (its scope rows), HOW MANY complete it, and WHAT completing it gives.
CREATE TABLE IF NOT EXISTS loyalty_cards (
  id                 INT UNSIGNED NOT NULL AUTO_INCREMENT,

  name               VARCHAR(100) NOT NULL,
  is_active          TINYINT(1) NOT NULL DEFAULT 1,

  required_stamps    SMALLINT UNSIGNED NOT NULL DEFAULT 10,

  -- free_item — a voucher for reward_product_id, free
  -- value     — a voucher worth reward_value rand
  -- points    — reward_value points straight onto the balance
  reward_type        ENUM('free_item','value','points') NOT NULL DEFAULT 'free_item',
  reward_product_id  INT UNSIGNED NULL,
  reward_value       DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  -- At most one stamp per sale when 1 — the usual coffee-card rule, so a
  -- trolley of ten tins earns one stamp rather than completing a card outright.
  one_stamp_per_sale TINYINT(1) NOT NULL DEFAULT 1,
  -- A line must be worth at least this much to count.
  min_line_amount    DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  -- How long a voucher this card issues stays valid. 0 = no expiry.
  voucher_valid_days SMALLINT UNSIGNED NOT NULL DEFAULT 0,

  starts_on          DATE NULL,
  ends_on            DATE NULL,

  created_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY idx_card_active (is_active),
  CONSTRAINT fk_loyalty_card_product FOREIGN KEY (reward_product_id)
    REFERENCES products (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- What earns a stamp on a card: specific products, or a whole department.
-- A card with NO scope rows earns on anything — deliberate, so "spend R50, get
-- a stamp" needs no scope at all.
CREATE TABLE IF NOT EXISTS loyalty_card_items (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  card_id       INT UNSIGNED NOT NULL,

  -- Exactly one of these is set; the CHECK below enforces it.
  product_id    INT UNSIGNED NULL,
  department_id INT UNSIGNED NULL,

  PRIMARY KEY (id),
  KEY idx_card_item_card (card_id),
  UNIQUE KEY uq_card_product (card_id, product_id),
  UNIQUE KEY uq_card_department (card_id, department_id),

  CONSTRAINT fk_card_item_card FOREIGN KEY (card_id)
    REFERENCES loyalty_cards (id) ON DELETE CASCADE,
  CONSTRAINT fk_card_item_product FOREIGN KEY (product_id)
    REFERENCES products (id) ON DELETE CASCADE,
  CONSTRAINT fk_card_item_department FOREIGN KEY (department_id)
    REFERENCES departments (id) ON DELETE CASCADE,

  -- A scope row that named both, or neither, would silently match nothing.
  CONSTRAINT ck_card_item_target CHECK (
    (product_id IS NOT NULL AND department_id IS NULL) OR
    (product_id IS NULL AND department_id IS NOT NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Stamps ───────────────────────────────────────────────────────────────
--
-- Append-only like the ledger: one row per stamp. Progress on a card is the
-- count of rows since the customer last completed it, which makes reversing a
-- refunded sale an ordinary delete-by-document rather than decrementing a
-- counter that two tills might be touching at once.
CREATE TABLE IF NOT EXISTS loyalty_stamps (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

  card_id       INT UNSIGNED NOT NULL,
  customer_id   INT UNSIGNED NOT NULL,

  document_id   INT UNSIGNED NULL,
  -- This stamp's position within its sale. Only exists so the unique key below
  -- is possible when one sale legitimately earns several stamps.
  stamp_seq     SMALLINT UNSIGNED NOT NULL DEFAULT 1,

  product_id    INT UNSIGNED NULL,

  -- Set when this stamp completed a card, and what it issued.
  completed     TINYINT(1) NOT NULL DEFAULT 0,
  voucher_id    BIGINT UNSIGNED NULL,

  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (id),
  KEY idx_stamp_customer_card (customer_id, card_id, created_at),
  KEY idx_stamp_document (document_id),

  -- The same retry guard the ledger has.
  UNIQUE KEY uq_stamp_sale (card_id, customer_id, document_id, stamp_seq),

  CONSTRAINT fk_stamp_card FOREIGN KEY (card_id)
    REFERENCES loyalty_cards (id) ON DELETE CASCADE,
  CONSTRAINT fk_stamp_customer FOREIGN KEY (customer_id)
    REFERENCES customers (id) ON DELETE CASCADE,
  CONSTRAINT fk_stamp_document FOREIGN KEY (document_id)
    REFERENCES sales_documents (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Vouchers ─────────────────────────────────────────────────────────────
--
-- Single-use rewards: a completed punch card, a birthday gift, a goodwill
-- issue. `status` is a state machine — issued → redeemed | expired | void — and
-- redemption flips it inside the sale's own transaction with a conditional
-- UPDATE, so a photographed code cannot be spent twice.
CREATE TABLE IF NOT EXISTS loyalty_vouchers (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- What the cashier scans or types. Unique, and drawn from an alphabet with no
  -- vowels (so it cannot spell anything) and no 0/O, 1/I, 5/S or Z, which are
  -- the characters people misread off a printed slip.
  code              VARCHAR(30) NOT NULL,

  customer_id       INT UNSIGNED NULL,

  reward_type       ENUM('free_item','value') NOT NULL DEFAULT 'value',
  reward_product_id INT UNSIGNED NULL,
  reward_value      DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  description       VARCHAR(150) NOT NULL DEFAULT '',

  status            ENUM('issued','redeemed','expired','void') NOT NULL DEFAULT 'issued',

  -- What produced it.
  issued_by         ENUM('card','manual','birthday','tier') NOT NULL DEFAULT 'manual',
  card_id           INT UNSIGNED NULL,

  expires_on        DATE NULL,

  redeemed_at       DATETIME(3) NULL,
  redeemed_doc_id   INT UNSIGNED NULL,
  redeemed_doc_number VARCHAR(40) NOT NULL DEFAULT '',

  user_id           INT UNSIGNED NULL,
  user_name         VARCHAR(120) NOT NULL DEFAULT '',

  created_at        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (id),
  UNIQUE KEY uq_voucher_code (code),
  KEY idx_voucher_customer (customer_id, status),
  KEY idx_voucher_status_expiry (status, expires_on),
  KEY idx_voucher_document (redeemed_doc_id),

  CONSTRAINT fk_voucher_customer FOREIGN KEY (customer_id)
    REFERENCES customers (id) ON DELETE CASCADE,
  CONSTRAINT fk_voucher_card FOREIGN KEY (card_id)
    REFERENCES loyalty_cards (id) ON DELETE SET NULL,
  CONSTRAINT fk_voucher_product FOREIGN KEY (reward_product_id)
    REFERENCES products (id) ON DELETE SET NULL,
  CONSTRAINT fk_voucher_document FOREIGN KEY (redeemed_doc_id)
    REFERENCES sales_documents (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The stamp that completed a card points at the voucher it issued. Added after
-- the vouchers table exists.
ALTER TABLE loyalty_stamps
  ADD CONSTRAINT fk_stamp_voucher FOREIGN KEY (voucher_id)
    REFERENCES loyalty_vouchers (id) ON DELETE SET NULL;

-- ── The tenders that spend it ────────────────────────────────────────────
--
-- Redemption is an ordinary tender, not a special case in the posting engine.
-- Both carry `integration_key = 'loyalty'`, which is how salesPosting knows to
-- draw the amount down off the balance inside the sale's transaction.
--
--   requires_customer     — you cannot redeem without knowing whose points
--   counts_as_drawer_cash — 0: no physical money arrives, so counting it in the
--                           drawer would report every loyalty sale as short
--   allows_change         — 0: points and stored value do not pay out cash,
--                           which would otherwise be a laundering route
--
-- Inactive on arrival. A store switches them on when it opens its programme,
-- so the buttons do not appear on tills at shops that do not run loyalty.
INSERT IGNORE INTO tender_types
  (code, name, posts_to_debtor, requires_customer, counts_as_drawer_cash,
   opens_cash_drawer, allows_change, allows_split, allows_refund,
   requires_reference, reference_label, rounds_to_cash_denomination,
   min_amount, max_amount, surcharge_pct, integration_key,
   icon, color, position, is_active, is_system)
VALUES
  ('LOYALTY_POINTS', 'Loyalty points', 0, 1, 0, 0, 0, 1, 1, 0, NULL, 0,
   0.0000, 0.0000, 0.000, 'loyalty', 'gem', NULL, 80, 0, 0),
  ('LOYALTY_WALLET', 'Loyalty wallet', 0, 1, 0, 0, 0, 1, 1, 0, NULL, 0,
   0.0000, 0.0000, 0.000, 'loyalty', 'wallet', NULL, 81, 0, 0);

-- ── Programme settings ───────────────────────────────────────────────────
--
-- Rates and policy live in the `settings` KV alongside every other store
-- preference, rather than in a one-row loyalty table — a single-row table
-- invites a second row, and then every reader has to decide which one is real.
--
-- Deliberately NOT seeded here. Reads in settings.ts fall back to
-- SETTING_DEFAULTS, so the defaults are declared once in code where they can
-- carry a comment explaining themselves, and a row appears only when a store
-- actually changes something. Seeding would duplicate that list in a second
-- place and let the two drift.
--
-- The keys this feature adds are declared in src/lib/site/settings.ts:
--   loyalty_enabled, loyalty_earn_rate, loyalty_redeem_rate,
--   loyalty_min_redeem_points, loyalty_earn_on_discounted,
--   loyalty_expiry_mode, loyalty_expiry_months, loyalty_tier_basis,
--   loyalty_tier_window_months, loyalty_tier_grace_months
