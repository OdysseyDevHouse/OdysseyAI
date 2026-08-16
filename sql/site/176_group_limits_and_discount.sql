-- ─────────────────────────────────────────────────────────────────────────
-- Group-level spend limits and a group standing discount.
--
-- Three columns, but TWO different kinds of setting — and the split is the
-- whole point of this migration, because getting it wrong is how a back-office
-- edit silently reprices a shop or silently fails to.
--
-- ── THE CREDIT HALF SEEDS. THE PRICING HALF RESOLVES. ────────────────────
--
-- default_daily_limit / default_monthly_limit are DEFAULTS, exactly like
-- default_credit_limit beside them. They are copied onto a new account and
-- editable there afterwards; changing them here never restates an account
-- that already exists. 012 set that rule for a reason — an account agreed to
-- the terms it agreed to, and a group edit must not rewrite what was agreed.
--
-- default_discount_pct is NOT that. It is resolved LIVE, the way
-- price_structure_id has been since 135: the customer's own discount wins,
-- and NULL on the customer falls through to the group. Changing it here moves
-- every account that has not set its own, immediately.
--
-- Why the difference is right rather than merely convenient: a discount and a
-- price structure are two halves of one sentence — what this group pays. A
-- shop that renegotiates trade pricing changes it in ONE place and expects
-- the counter to follow. Credit terms are the opposite: they are a promise
-- made per account, and moving them in bulk from a group screen is precisely
-- the thing nobody wants to happen by accident.
--
-- ── NULL VERSUS ZERO ─────────────────────────────────────────────────────
--
-- default_discount_pct is NULLABLE, and NULL means "this group grants none"
-- rather than "0%". The distinction is inherited from customers.discount_pct
-- in 135 and has to survive here, because resolution reads it: a group at
-- NULL leaves the customer's own NULL meaning no discount at all, whereas a
-- group at an explicit 0.000 is a deliberate "no discount, and somebody
-- decided that" which still overrides nothing but reads differently on the
-- screen.
--
-- DECIMAL(6,3) matches customers.discount_pct, which matches
-- sales_document_lines.discount_pct — the column it eventually flows into, so
-- no step in that chain can disagree on precision.
--
-- The applied discount is still CAPPED at the product's max_discount_pct at
-- application time. A group discount is not a way around that ceiling; see
-- the note in 135.
--
-- The two limits mirror customers.daily_limit / monthly_limit from 175,
-- including the zero rule: ZERO MEANS NO LIMIT, which is the opposite of
-- default_credit_limit where zero means no credit granted.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE customer_groups
  ADD COLUMN IF NOT EXISTS default_daily_limit DECIMAL(12,4) NOT NULL DEFAULT 0.0000
    AFTER default_credit_limit,
  ADD COLUMN IF NOT EXISTS default_monthly_limit DECIMAL(12,4) NOT NULL DEFAULT 0.0000
    AFTER default_daily_limit,
  ADD COLUMN IF NOT EXISTS default_discount_pct DECIMAL(6,3) NULL
    AFTER default_monthly_limit;
