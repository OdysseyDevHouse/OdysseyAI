-- ============================================================================
-- 116 — A STATUS COLUMN ON customer_assets
--
-- A follow-up to 115 rather than an edit to it: migrations are recorded by
-- filename, so changing an applied file does nothing on a site that has already
-- run it. 115 is applied.
--
-- WHY THIS COLUMN EXISTS AT ALL
--
-- verifySequence() counts numbers against whatever table OWN_TABLE_TYPES names,
-- and hard-codes SUM(CASE WHEN status = 'cancelled' ...) to separate voided
-- numbers from live ones. A table with no status column cannot be registered
-- there, and an unregistered numbered record is one nothing reconciles — which
-- means every AST number ever issued would report as missing.
--
-- job_cards already carries exactly this pair for exactly this reason: `status`
-- as the coarse record state alongside the workflow stage. This is the same
-- move.
--
-- ONE WRITER, ALWAYS
--
-- status is DERIVED from is_active and must only ever be written beside it.
-- retireAsset() and reviveAsset() in jobAssets.ts are the only writers; nothing
-- else may touch either column. Two columns saying the same thing is a
-- reconciliation risk, and the reconcile function reports it when they diverge.
--
-- 'retired' rather than 'cancelled' would have read better here, but
-- verifySequence looks for the literal string 'cancelled', so the ENUM carries
-- it. Naming it anything else would silently count every retired asset as a
-- live number.
-- ============================================================================

ALTER TABLE customer_assets
  ADD COLUMN IF NOT EXISTS status ENUM('active','cancelled') NOT NULL DEFAULT 'active'
  AFTER is_active;

-- Backfill from is_active, which is the authority until this column exists.
UPDATE customer_assets SET status = 'cancelled' WHERE is_active = 0 AND status = 'active';

ALTER TABLE customer_assets
  ADD KEY IF NOT EXISTS ix_asset_status (status, next_service_on);
