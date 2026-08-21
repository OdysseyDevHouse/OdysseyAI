-- Loyalty — points, tiers, punch cards, vouchers and a stored-value wallet.
--
-- ── A MEMBER IS ITS OWN THING, NOT A FACET OF A CUSTOMER ─────────────────
--
-- This file used to key every loyalty row to `customers.id`, and said so:
--
--     "Keyed BY customer_id rather than carrying its own id: there is exactly
--      one loyalty standing per customer, and a surrogate key would allow two."
--
-- That was right for what it assumed, and the assumption was wrong. A shopper
-- who joins with a cell number is a member and will never be a debtor; an
-- account customer may never join. Tying the two together meant loyalty could
-- only ever be as central as the customer file — a group with twenty separate
-- debtors books could not run one programme, which is the ordinary case.
--
-- It also broke the till outright. `salesPosting` writes loyalty INSIDE the
-- sale's own transaction, on the branch's connection, and with a shared
-- customer file the member row lives in the owner's database while
-- `loyalty_ledger` still carried a foreign key to the BRANCH's `customers`.
-- Measured, not reasoned about: ER_NO_REFERENCED_ROW_2, the throw propagates,
-- and the whole sale rolls back. A shop that switched sharing on could not sell
-- to a loyalty customer at any branch.
--
-- So a member is a row of its own with its own number, and `customer_id` is a
-- NULLABLE LINK. Four states are legal and all four are ordinary:
--
--     member, no customer   a walk-in who joined with a cell number
--     member and customer   an account holder who is also on the programme
--     customer, no member   an account holder who never joined
--     neither               a walk-in sale
--
-- `customer_id` is UNIQUE so one customer cannot hold two memberships — the
-- guarantee the old composite key was buying, kept without the coupling.
--
-- UNIQUE does not constrain NULL, and here that is the point: many members have
-- no customer at all. It is also the trap this codebase has been bitten by
-- twice, so it is worth stating plainly — the uniqueness of the LINK is
-- enforced and the uniqueness of nothing else is.
--
-- ── POINTS ARE A LEDGER, NEVER A BALANCE COLUMN ──────────────────────────
--
-- Every event — earning on a sale, spending at the till, expiring, a manual
-- correction, a refund clawing points back — appends one immutable row, and the
-- balance is SUM(points). A balance column would be a read-modify-write, so two
-- tills crediting the same member at the same moment would race and one event
-- would silently vanish. It also buys the audit trail for free: "why does she
-- have 1 240 points" is answerable, and a refund becomes an ordinary entry
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
-- ── NOTHING HERE KEYS INTO A TABLE THAT MIGHT BE ELSEWHERE ───────────────
--
-- No foreign key from a loyalty table to `customers`, `sales_documents`,
-- `products` or `departments`. Under a separate loyalty owner those tables are
-- in another database, and 197 already established that a key cannot span the
-- boundary and that repointing is unavailable, because one schema has to serve
-- both a sharing store and a non-sharing one.
--
-- So the references that cross are held as VALUES that mean the same thing
-- everywhere: `product_code`, `department_name`, and `(origin_site_id,
-- document_id)` for a sale. This is the shape 201 converted the programme
-- configuration to, adopted here natively rather than as a later ALTER —
-- product ids are per-database and mean nothing across stores, product codes
-- are how this system already identifies "the same product" everywhere.
--
-- `origin_site_id` on the rows a shared file receives is 198's fix, folded in
-- for the same reason: document ids are per-database auto-increments, so store
-- 3's sale 5001 and store 7's sale 5001 both exist, and a unique key on
-- document_id alone would refuse the second perfectly good award.
--
-- ── HOW THIS DIFFERS FROM THE OLD DESKTOP SCHEME ──────────────────────────
--
-- The old system keyed loyalty off a customer CODE string and stored redemption
-- in a general-purpose "Other 1" tender slot that stores had to rename by hand.
-- Here redemption is an ordinary `tender_types` row with
-- `integration_key = 'loyalty'` — the till already knows how to render, split
-- and validate one of those, so points and wallet spend need no special case in
-- the tender engine.

-- ── Members ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS loyalty_members (
  id               INT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- What the till matches on. This replaces `customers.loyalty_number`, which
  -- is dropped below: two columns holding the same claim is how they drift.
  member_number    VARCHAR(60) NOT NULL,

  -- The optional link to a debtors account. NULL for a walk-in member, which is
  -- expected rather than exceptional.
  --
  -- Deliberately NOT a foreign key: `customers` may live in another database
  -- when the customer file is shared and loyalty is not, or the reverse. The
  -- link is validated in code, where it can also say WHY it refused.
  customer_id      INT UNSIGNED NULL,

  name             VARCHAR(160) NOT NULL,
  phone            VARCHAR(40) NULL,
  email            VARCHAR(190) NULL,

  is_active        TINYINT(1) NOT NULL DEFAULT 1,

  -- Cached SUM(points) from loyalty_ledger. Display only, always recomputable.
  points_balance   DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  -- Cached SUM(amount) from loyalty_wallet. Same contract.
  wallet_balance   DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  -- The tier they currently sit in, plus when they reached it and when it is
  -- next reviewed. Downgrades happen only ON REVIEW, never the instant
  -- qualifying spend dips: a member who has a quiet month should not lose Gold
  -- on a Tuesday.
  tier_id          INT UNSIGNED NULL,
  tier_since       DATETIME NULL,
  tier_review_date DATE NULL,

  joined_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Last earn or spend — drives activity-based points expiry.
  last_activity_at DATETIME NULL,

  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_member_number (member_number),
  -- One membership per customer. NULLs are exempt, which is what allows any
  -- number of walk-in members — see the header.
  UNIQUE KEY uq_member_customer (customer_id),
  KEY idx_member_tier (tier_id),
  KEY idx_member_phone (phone),
  KEY idx_member_activity (last_activity_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Tiers ────────────────────────────────────────────────────────────────
--
-- Bronze / Silver / Gold / Platinum by default, fully editable. A member sits
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

-- No FK from loyalty_members.tier_id to loyalty_tiers. 200 dropped it and the
-- reason survives: the tiers are programme CONFIGURATION and a member is
-- programme DATA, and under a shared programme those may be the same database
-- or not. The tier is resolved in code, and a member pointing at a tier that no
-- longer exists reads as "no tier" and is re-placed at the next review — which
-- is what SET NULL did anyway.

-- ── The points ledger ────────────────────────────────────────────────────
--
-- The source of truth. `points` is SIGNED: positive when earned or adjusted up,
-- negative when spent, expired or clawed back.
CREATE TABLE IF NOT EXISTS loyalty_ledger (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

  member_id      INT UNSIGNED NOT NULL,

  -- earn     — granted by a sale
  -- redeem   — spent against a sale
  -- expire   — lapsed under the expiry policy
  -- adjust   — a manual correction or goodwill gesture, either sign
  -- reverse  — a refunded sale taking its points back
  entry_type     ENUM('earn','redeem','expire','adjust','reverse') NOT NULL,

  points         DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  -- The rand value these points were earned on. Earn rows only. Summed over the
  -- rolling window for tier standing — deliberately NOT derived from `points`,
  -- so spending points can never cost a member their tier.
  basis_amount   DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  -- The sale this came from, when it came from one, and WHICH STORE's sale.
  -- Both, because document ids are per-database: without origin_site_id the
  -- unique key below would refuse store 7's sale 5001 after store 3 had already
  -- earned on its own sale 5001, and the customer would silently lose points.
  document_id    INT UNSIGNED NULL,
  origin_site_id INT UNSIGNED NULL,
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
  KEY idx_ledger_member (member_id, created_at),
  KEY idx_ledger_document (origin_site_id, document_id),
  KEY idx_ledger_type_date (entry_type, created_at),

  -- What makes a retried finalise safe. A sale may grant points exactly once;
  -- a SELECT ... FOR UPDATE cannot lock a row that does not exist yet, so two
  -- concurrent first-ever awards would both find nothing and both insert. This
  -- lets the database arbitrate — the loser gets a duplicate-key error and
  -- awards nothing.
  UNIQUE KEY uq_ledger_document_earn (origin_site_id, document_id, entry_type),

  CONSTRAINT fk_loyalty_ledger_member FOREIGN KEY (member_id)
    REFERENCES loyalty_members (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── The wallet ───────────────────────────────────────────────────────────
--
-- Rand stored value. Append-only for the same reasons as the points ledger, and
-- separate from it for the reasons in the header.
CREATE TABLE IF NOT EXISTS loyalty_wallet (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

  member_id      INT UNSIGNED NOT NULL,

  -- topup  — money in at the till (positive)
  -- spend  — settled against a sale (negative)
  -- refund — a reversed sale giving the money back (positive)
  -- adjust — a manual correction, either sign
  entry_type     ENUM('topup','spend','refund','adjust') NOT NULL,

  -- SIGNED rand: positive credits the member, negative debits them.
  amount         DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  -- How the money ARRIVED, on top-up rows. A top-up takes real cash or a card
  -- payment, and the cash-up has to see it or the drawer will not balance
  -- against a day that included top-ups.
  --
  -- These three are BRANCH ids — a tender type, a shift and a terminal all
  -- belong to the shop that took the money — held in a table that may live at
  -- the loyalty owner. So origin_site_id below is what makes them resolvable:
  -- shift 12 means nothing without knowing whose shift 12.
  tender_type_id INT UNSIGNED NULL,
  shift_id       INT UNSIGNED NULL,
  terminal_id    INT UNSIGNED NULL,

  document_id    INT UNSIGNED NULL,
  origin_site_id INT UNSIGNED NULL,
  document_number VARCHAR(40) NOT NULL DEFAULT '',

  note           VARCHAR(255) NOT NULL DEFAULT '',

  user_id        INT UNSIGNED NULL,
  user_name      VARCHAR(120) NOT NULL DEFAULT '',

  created_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (id),
  KEY idx_wallet_member (member_id, created_at),
  KEY idx_wallet_document (origin_site_id, document_id),
  -- The cash-up reads top-ups for a shift, and only ever its OWN shifts, so the
  -- origin leads the key.
  KEY idx_wallet_shift (origin_site_id, shift_id, entry_type),
  KEY idx_wallet_type_date (entry_type, created_at),

  -- One wallet spend per sale, for the same reason the ledger has one.
  UNIQUE KEY uq_wallet_document_spend (origin_site_id, document_id, entry_type),

  CONSTRAINT fk_loyalty_wallet_member FOREIGN KEY (member_id)
    REFERENCES loyalty_members (id) ON DELETE CASCADE
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

  -- free_item — a voucher for reward_product_code, free
  -- value     — a voucher worth reward_value rand
  -- points    — reward_value points straight onto the balance
  reward_type        ENUM('free_item','value','points') NOT NULL DEFAULT 'free_item',
  -- By CODE, never by id: a card is programme configuration shared across the
  -- group, and a product id means nothing in another store's database.
  reward_product_code VARCHAR(32) NULL,
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
  KEY idx_card_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- What earns a stamp on a card: specific products, or a whole department.
-- A card with NO scope rows earns on anything — deliberate, so "spend R50, get
-- a stamp" needs no scope at all.
--
-- By code and name rather than id, for the reason on loyalty_cards above. This
-- table settled the argument on the customer side too: 199 kept it in the
-- branch precisely BECAUSE it had foreign keys to products and departments,
-- and "cannot follow the customer without dragging the product file with it".
-- Holding the portable key instead is what lets it move with the programme.
CREATE TABLE IF NOT EXISTS loyalty_card_items (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  card_id         INT UNSIGNED NOT NULL,

  -- Exactly one of these is set; the CHECK below enforces it.
  product_code    VARCHAR(32) NULL,
  department_name VARCHAR(120) NULL,

  PRIMARY KEY (id),
  KEY idx_card_item_card (card_id),
  UNIQUE KEY uq_card_product (card_id, product_code),
  UNIQUE KEY uq_card_department (card_id, department_name),

  CONSTRAINT fk_card_item_card FOREIGN KEY (card_id)
    REFERENCES loyalty_cards (id) ON DELETE CASCADE,

  -- A scope row that named both, or neither, would silently match nothing.
  CONSTRAINT ck_card_item_target CHECK (
    (product_code IS NOT NULL AND department_name IS NULL) OR
    (product_code IS NULL AND department_name IS NOT NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Stamps ───────────────────────────────────────────────────────────────
--
-- Append-only like the ledger: one row per stamp. Progress on a card is the
-- count of rows since the member last completed it, which makes reversing a
-- refunded sale an ordinary delete-by-document rather than decrementing a
-- counter that two tills might be touching at once.
CREATE TABLE IF NOT EXISTS loyalty_stamps (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

  card_id       INT UNSIGNED NOT NULL,
  member_id     INT UNSIGNED NOT NULL,

  document_id   INT UNSIGNED NULL,
  origin_site_id INT UNSIGNED NULL,
  -- This stamp's position within its sale. Only exists so the unique key below
  -- is possible when one sale legitimately earns several stamps.
  stamp_seq     SMALLINT UNSIGNED NOT NULL DEFAULT 1,

  -- Which product earned it, by code. Kept for the "what did I stamp" question
  -- on a card's history; not joined to anything.
  product_code  VARCHAR(32) NULL,

  -- Set when this stamp completed a card, and what it issued.
  completed     TINYINT(1) NOT NULL DEFAULT 0,
  voucher_id    BIGINT UNSIGNED NULL,

  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (id),
  KEY idx_stamp_member_card (member_id, card_id, created_at),
  KEY idx_stamp_document (origin_site_id, document_id),

  -- The same retry guard the ledger has, with the origin in it for the same
  -- reason: two branches' sale 5001 must both be able to earn a stamp.
  UNIQUE KEY uq_stamp_sale (card_id, origin_site_id, member_id, document_id, stamp_seq),

  CONSTRAINT fk_stamp_card FOREIGN KEY (card_id)
    REFERENCES loyalty_cards (id) ON DELETE CASCADE,
  CONSTRAINT fk_stamp_member FOREIGN KEY (member_id)
    REFERENCES loyalty_members (id) ON DELETE CASCADE
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

  member_id         INT UNSIGNED NULL,

  reward_type       ENUM('free_item','value') NOT NULL DEFAULT 'value',
  -- A voucher outlives the card that issued it and is redeemed at any branch,
  -- so it carries the reward by code rather than looking it back up.
  reward_product_code VARCHAR(32) NULL,
  reward_value      DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  description       VARCHAR(150) NOT NULL DEFAULT '',

  status            ENUM('issued','redeemed','expired','void') NOT NULL DEFAULT 'issued',

  -- What produced it.
  issued_by         ENUM('card','manual','birthday','tier') NOT NULL DEFAULT 'manual',
  card_id           INT UNSIGNED NULL,

  expires_on        DATE NULL,

  redeemed_at       DATETIME(3) NULL,
  redeemed_doc_id   INT UNSIGNED NULL,
  redeemed_site_id  INT UNSIGNED NULL,
  redeemed_doc_number VARCHAR(40) NOT NULL DEFAULT '',

  user_id           INT UNSIGNED NULL,
  user_name         VARCHAR(120) NOT NULL DEFAULT '',

  created_at        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (id),
  UNIQUE KEY uq_voucher_code (code),
  KEY idx_voucher_member (member_id, status),
  KEY idx_voucher_status_expiry (status, expires_on),
  KEY idx_voucher_document (redeemed_site_id, redeemed_doc_id),

  CONSTRAINT fk_voucher_member FOREIGN KEY (member_id)
    REFERENCES loyalty_members (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- No FK from loyalty_stamps.voucher_id to loyalty_vouchers, and none from
-- loyalty_vouchers.card_id to loyalty_cards. 199 dropped the card one and gave
-- the reason: a card is programme configuration and a voucher is a thing a
-- member holds, so under a shared programme they may be in different
-- databases. The stamp-to-voucher link is the same shape.

-- ── The tenders that spend it ────────────────────────────────────────────
--
-- Redemption is an ordinary tender, not a special case in the posting engine.
-- Both carry `integration_key = 'loyalty'`, which is how salesPosting knows to
-- draw the amount down off the balance.
--
--   requires_customer     — 0 now, and this is the change that matters: a
--                           MEMBER is not a customer, and requiring one would
--                           refuse every walk-in member the new schema exists
--                           to serve. salesPosting checks for a member instead.
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
  ('LOYALTY_POINTS', 'Loyalty points', 0, 0, 0, 0, 0, 1, 1, 0, NULL, 0,
   0.0000, 0.0000, 0.000, 'loyalty', 'gem', NULL, 80, 0, 0),
  ('LOYALTY_WALLET', 'Loyalty wallet', 0, 0, 0, 0, 0, 1, 1, 0, NULL, 0,
   0.0000, 0.0000, 0.000, 'loyalty', 'wallet', NULL, 81, 0, 0);

-- ── customers.loyalty_number STAYS, for now ──────────────────────────────
--
-- It is what the till matches on today, and `loyalty_members.member_number`
-- will replace it: two columns holding the same claim is how they drift, and
-- the one on `customers` cannot serve a walk-in member who has no customer row
-- at all. So it goes — but NOT in this migration.
--
-- Dropping it here was tried and reverted, and the reason is worth recording
-- rather than repeating. The column is written by createCustomer, so the moment
-- it disappeared EVERY suite that makes a customer failed — accounting, sales
-- posting, account sales, duplicates, the sharing probes — seven of them, none
-- about loyalty. A schema change landing ahead of the code that answers it does
-- not fail in the feature it belongs to; it fails everywhere that feature's
-- table is touched.
--
-- It is dropped in the same change that ports customers.ts, tillCustomers.ts
-- and the two report fields off it — the eight sites listed in
-- docs/plans/loyalty-members.md, decision 2. Until then it stands unused by the
-- loyalty tables above, which is harmless: nothing here reads it.

-- ── Programme settings ───────────────────────────────────────────────────
--
-- Rates and policy live in the `settings` KV alongside every other store
-- preference, rather than in a one-row loyalty table — a single-row table
-- invites a second row, and then every reader has to decide which one is real.
--
-- Deliberately NOT seeded here. Reads in settings.ts fall back to
-- SETTING_DEFAULTS, so the defaults are declared once in code where they can
-- carry a comment explaining themselves, and a row appears only when a store
-- actually changes something.
--
-- NOTE for the shared-programme work: these are read with getSettings(siteId),
-- which answers for the CALLER. Left that way under a shared programme every
-- branch keeps its own earn rate while sharing one balance, which is the same
-- incoherence 201 named about per-branch tiers — "Gold could mean R50,000 at
-- one branch and R30,000 at another, measured against one shared spend
-- figure". getLoyaltySettings resolves the loyalty owner for that reason.
--
-- The keys this feature adds are declared in src/lib/site/settings.ts:
--   loyalty_enabled, loyalty_earn_rate, loyalty_redeem_rate,
--   loyalty_min_redeem_points, loyalty_earn_on_discounted,
--   loyalty_expiry_mode, loyalty_expiry_months, loyalty_tier_basis,
--   loyalty_tier_window_months, loyalty_tier_grace_months
