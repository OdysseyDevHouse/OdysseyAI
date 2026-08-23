-- ─────────────────────────────────────────────────────────────────────────
-- How a customer's account behaves.
--
-- Replaces the `is_cash_only` boolean with a four-value type, because the
-- boolean could only ever answer one of the questions this actually decides.
--
-- ── THE FOUR TYPES ───────────────────────────────────────────────────────
--
--   open_item     Credit granted. A payment is presented with the customer's
--                 unpaid invoices and the user chooses what it settles — R300
--                 to one, R200 to another. This is the default and what every
--                 posting path already does.
--
--   balance_fwd   Credit granted, but nobody allocates anything by hand. A
--                 payment is applied to the OLDEST outstanding invoice first
--                 and works forward until it is used up.
--
--   cash          No credit, ever. Must pay at the till. This is the old
--                 is_cash_only = 1, and the reason it is worth keeping
--                 distinct from `status = 'on_hold'`: a cash account was
--                 never granted credit, a held one had it withdrawn.
--
--   lay_by        Goods are reserved and paid off in instalments. Nothing is
--                 invoiced and no stock moves until it is paid in full; the
--                 deposits sit on the account as unapplied credit meanwhile.
--
-- ── WHY A COLUMN AND NOT A SEPARATE TABLE ────────────────────────────────
--
-- Each value is a small fixed behaviour the engine branches on, not data a
-- store configures. A lookup table would add a join to every customer query
-- to store four rows nobody edits.
--
-- ── THE DIFFERENCE THAT MATTERS ──────────────────────────────────────────
--
-- open_item vs balance_fwd is ONLY about who decides where a payment goes.
-- Both keep a full open-item ledger underneath — every transaction still
-- carries its own amount_outstanding, and the age analysis still buckets by
-- each document's own date. balance_fwd simply runs the allocation
-- automatically instead of asking. Nothing is lost by choosing it, and a
-- customer can be switched between the two at any time.
--
-- DDL auto-commits, so every step here is re-runnable.
-- ─────────────────────────────────────────────────────────────────────────

-- ── 1. Add the column, defaulting everyone to today's behaviour ──────────
-- The column default is 'balance_fwd' to match DEFAULT_ACCOUNT_TYPE in
-- src/lib/accountTypes.ts, so the schema and the code cannot disagree about
-- what an unstated account type means. In practice nothing relies on it —
-- every insert names the column — but a default that contradicts the app is
-- the kind of thing somebody later reads as the intended answer.
-- Step 2 below still puts EXISTING rows on open_item, which is what they were.
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS account_type
    ENUM('open_item','balance_fwd','cash','lay_by') NOT NULL DEFAULT 'balance_fwd'
    AFTER status_reason;

-- Everyone the column was just created for was an open-item account, whatever
-- the default now says — set them so, before the cash-only carry-across below.
UPDATE customers SET account_type = 'open_item' WHERE account_type = 'balance_fwd';

-- ── 2. Carry the old boolean across ──────────────────────────────────────
-- Everyone else stays open_item, which is what they were: a customer with
-- credit whose payments were allocated by hand.
UPDATE customers SET account_type = 'cash' WHERE is_cash_only = 1;

-- ── 3. Drop the boolean ──────────────────────────────────────────────────
-- The whole point of doing this now is that nothing is left saying the old
-- thing. Two columns answering overlapping questions is how they drift.
ALTER TABLE customers DROP COLUMN IF EXISTS is_cash_only;

-- Filtering the debtors list by account type is a normal thing to want, and
-- the list is already indexed on status for the same reason.
--
-- MySQL has no CREATE INDEX IF NOT EXISTS, and DDL auto-commits — so a
-- re-run would fail on the duplicate key. Added only when absent.
SET @ix := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'customers'
     AND INDEX_NAME = 'ix_customer_account_type'
);
SET @sql := IF(@ix = 0,
  'CREATE INDEX ix_customer_account_type ON customers (account_type)',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
