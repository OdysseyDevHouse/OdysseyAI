-- ── What stops a promotion running away ───────────────────────────────────
--
-- Until now a special had no ceiling of any kind. A mistyped 90 in the discount
-- box discounted the whole store by 90 percent, on every sale, until somebody
-- noticed -- and the person most likely to notice is the owner reading the
-- month end.
--
-- The gap is sharper than it sounds, because the till ALREADY refuses this from
-- a human. A cashier typing 30 percent off a line is checked against that
-- product's `max_discount_pct` and sent to a supervisor. The same 30 percent
-- written into a special was applied without a word. The rule existed; only the
-- automatic path went around it.
--
-- Every column here defaults to "no limit", so a special written before this
-- migration behaves exactly as it did.
--
-- ── THE GUARDS CLAMP; THEY DO NOT CANCEL ──────────────────────────────────
--
-- When a guard bites, the engine reduces the discount and STILL claims the
-- line. Cancelling the special instead would hand the line to whatever
-- promotion sits below it in the list -- which is very likely the one the guard
-- was protecting the shop from. A smaller discount is a bad day; a different,
-- unguarded special firing in its place is a worse one.

ALTER TABLE specials
  -- How many times one sale may complete this deal. 0 is unlimited.
  --
  -- "Buy 3, cheapest free" repeats without end today: 300 tins earns 100 free.
  -- Every real till has a "limit 2 per customer" because that is how a
  -- promotion is kept to its purpose rather than becoming wholesale.
  ADD COLUMN max_deals_per_sale INT UNSIGNED NOT NULL DEFAULT 0,

  -- Honour the product's own max_discount_pct ceiling.
  --
  -- OFF by default, deliberately, and this is the uncomfortable choice. A shop
  -- that has set 5% ceilings for its cashiers may well intend a 20% promotion,
  -- and switching this on for everyone would silently gut the specials they
  -- already run. So it is offered rather than assumed.
  ADD COLUMN respect_max_discount TINYINT(1) NOT NULL DEFAULT 0,

  -- Refuse to take a line below this gross margin. 0 is off.
  ADD COLUMN min_margin_pct DECIMAL(6,3) NOT NULL DEFAULT 0,

  -- The hard floor: never sell below what it cost.
  --
  -- Separate from min_margin_pct rather than expressed as "margin of 0",
  -- because they answer different questions. A shop that wants 15% margin is
  -- protecting profit; a shop that wants "never below cost" is protecting
  -- against a loss, and wants to say so plainly rather than by typing a zero
  -- that reads like the feature is switched off.
  ADD COLUMN never_below_cost TINYINT(1) NOT NULL DEFAULT 0,

  -- How many times the promotion may be used in total. NULL is unlimited.
  ADD COLUMN max_redemptions INT UNSIGNED NULL,

  -- The counter the concurrency guard locks and compares. See 073 for the same
  -- pattern on discount codes, and for why the counter EARNS its place beside
  -- the ledger table below rather than being derivable from it.
  ADD COLUMN redemptions_count INT UNSIGNED NOT NULL DEFAULT 0;

-- ── A redemption is a row, not just a number ──────────────────────────────
--
-- Exactly the reasoning 073 gives for discount_code_uses. `redemptions_count`
-- on its own says a promotion was used forty times and nothing else. This is
-- what answers "did that campaign bring in new customers or discount the
-- regulars", and it is what a dispute is settled from.
--
-- The counter stays as well, deliberately: it is what the lock compares, and
-- counting rows under a lock on every sale is the expensive way to ask a
-- question the counter already answers.
CREATE TABLE IF NOT EXISTS special_redemptions (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  special_id  INT UNSIGNED NOT NULL,

  -- The sale that used it. The evidence -- a redemption pointing at nothing is
  -- not evidence of anything, which is why the writer refuses one.
  document_id INT UNSIGNED NULL,

  -- Who, when there was a who. A walk-in is a legitimate redemption with no
  -- customer, so this is nullable rather than the row being refused.
  customer_id INT UNSIGNED NULL,

  -- What the promotion gave away on this sale, VAT inclusive. This is the
  -- figure "what did that campaign cost us" is summed from.
  amount_incl DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  used_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY ix_redemption_special (special_id, used_at),
  KEY ix_redemption_customer (special_id, customer_id),

  -- One redemption per special per sale. A sale that rings the same promotion
  -- across four lines used it once, and counting it four times would exhaust a
  -- "first 100 customers" campaign in twenty-five sales.
  UNIQUE KEY uq_redemption_per_document (special_id, document_id),

  CONSTRAINT fk_redemption_special FOREIGN KEY (special_id)
    REFERENCES specials (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- No foreign key on document_id or customer_id, matching how loyalty (052)
-- holds its cross-references. Deleting a finished promotion must not be blocked
-- by the history it created, and the sale is the durable record either way.
