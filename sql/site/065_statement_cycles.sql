-- Statement cycles — how often an account is statemented, and on what rhythm.
--
-- Distinct from payment_terms_days, which decides when an invoice is DUE. The
-- cycle decides when the account is CUT: a customer on 30-day terms may still
-- want a statement every Friday. Conflating the two is the mistake this pair of
-- columns exists to prevent, so they are deliberately not derived from one
-- another and the form states the difference in words.
--
-- Everything before this migration behaved as a calendar-month cycle, which is
-- exactly what the defaults below reproduce. No backfill is needed: the DDL is
-- the whole migration.

ALTER TABLE customers
  -- Monthly is a CALENDAR month of 28-31 days, not "30 days" — an integer
  -- column could not express that, and payment_terms_days already owns the
  -- integer-days idea. Three named values, matching how status and account_type
  -- constrain themselves on this table.
  ADD COLUMN statement_cycle ENUM('monthly','14day','7day')
    NOT NULL DEFAULT 'monthly' AFTER payment_terms_days,

  -- Monthly only. 1-31 cuts the period on that day of the month; 0 means the
  -- calendar month, 1st to last. A day past the end of a short month clamps to
  -- the last day (31 Jan -> 27 Feb, then 28 Feb -> 30 Mar) rather than rolling
  -- forward, because consecutive periods MUST be contiguous with no gap: a
  -- balance brought forward is only correct if every transaction falls in
  -- exactly one period. Rolling would orphan 28-30 Feb.
  ADD COLUMN statement_anchor_day TINYINT UNSIGNED NOT NULL DEFAULT 0
    AFTER statement_cycle,

  -- 7/14-day only. Any day a period starts on — it sets the PHASE, not a
  -- boundary to be recomputed, which is what lets two accounts run Tue-Mon and
  -- Fri-Thu side by side. NULL falls back to the account's created_at, so a
  -- weekly account configured without one still has a stable, deterministic
  -- rhythm rather than one that moves with today's date.
  ADD COLUMN statement_anchor_date DATE NULL AFTER statement_anchor_day;

-- No index: nothing filters or sorts by cycle, and a three-value ENUM would
-- never be chosen by the planner.

-- The same two on the group, as defaults a new account inherits — the rule
-- stated at the top of 012_customers.sql and followed by 037. A creation-time
-- starting point, never a live lookup: changing a group's cycle must not
-- silently re-cut the statements of accounts already on it.
--
-- No group anchor DATE. "Every account in Trade cuts on the same Tuesday"
-- defeats the point of a per-account rhythm, and the fallback to created_at
-- already gives a sensible answer without one.
ALTER TABLE customer_groups
  ADD COLUMN default_statement_cycle ENUM('monthly','14day','7day') NOT NULL DEFAULT 'monthly',
  ADD COLUMN default_statement_anchor_day TINYINT UNSIGNED NOT NULL DEFAULT 0;
