-- Per-item statement periods.
--
-- A run used to carry ONE period that every item was sent for. Once accounts
-- have their own statement cycle (065), that is wrong for most of them: a
-- weekly account and a monthly one cannot share a period, and giving the weekly
-- one a month-long "statement" is not a small inaccuracy — it is a different
-- document.
--
-- The alternative was one run per distinct period, which turns a 300-account
-- month-end into forty runs and makes "did the run go out" unanswerable. So the
-- period moves onto the ITEM, resolved when the run is queued.
--
-- The run keeps its own period_from/period_to. Their meaning narrows slightly:
-- they are now the REFERENCE WINDOW — what the operator asked for, and what the
-- run screen shows in its header — rather than what every item was sent for.

ALTER TABLE customer_statement_items
  -- NULL means "use the run's period", which is exactly how every row written
  -- before this migration behaved. So existing runs keep reproducing the same
  -- document, and no backfill is needed or wanted: rewriting history to a
  -- period that was never used would falsify what was actually sent.
  ADD COLUMN period_from DATE NULL AFTER email,
  ADD COLUMN period_to   DATE NULL AFTER period_from;

-- No index. Items are only ever read by run_id or customer_id, both already
-- indexed, and a run holds at most a thousand rows.
