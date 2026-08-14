-- ── More than one piece of equipment on a job (18.4) ────────────────────────
--
-- A site visit that services four air conditioners is one job about four assets.
-- Today it can name one.
--
-- ── job_cards.asset_id STAYS, AND STAYS PRIMARY ─────────────────────────────
--
-- 115 argued the single column deliberately, and that argument still holds:
--
--   "making asset_id a join table would mean every cost, every check and every
--    warranty question needed to say WHICH asset it belonged to"
--
-- That is true and it is the reason this migration does NOT move the existing
-- data. asset_id remains the job's PRIMARY asset — the one a cost, a check or a
-- warranty question means when it does not say otherwise. The join table adds
-- the others.
--
-- 115 also said, in the same breath, "a join table can be added later without
-- moving the ones already recorded". This is that, done the way it said.
--
-- The alternative — migrate every asset_id into the join table and drop the
-- column — would be tidier and worse. Every one of the eleven places that reads
-- job_cards.asset_id today would have to become a join, "the asset this job is
-- about" would stop having an answer, and a job with two assets and no primary
-- would be a shape nothing on screen knows how to render.

CREATE TABLE IF NOT EXISTS job_card_assets (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  job_card_id  INT UNSIGNED NOT NULL,
  asset_id     INT UNSIGNED NOT NULL,

  -- What this particular unit needed, where the job as a whole may be "annual
  -- service, four units". Optional: a technician who writes nothing has still
  -- recorded that the unit was on the job.
  note         VARCHAR(400) NULL,

  sort_order   INT      NOT NULL DEFAULT 0,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),

  -- One row per asset per job. Adding the same unit twice is a mistake, not a
  -- quantity: two visits to one unit are two jobs.
  UNIQUE KEY uq_jca (job_card_id, asset_id),
  KEY ix_jca_asset (asset_id),

  CONSTRAINT fk_jca_job FOREIGN KEY (job_card_id)
    REFERENCES job_cards (id) ON DELETE CASCADE,

  -- RESTRICT, matching job_cards.asset_id in 115 and for its reason: an asset
  -- named by a job cannot be deleted, because the job is the record of what was
  -- done to it. Retiring is the offered alternative.
  CONSTRAINT fk_jca_asset FOREIGN KEY (asset_id)
    REFERENCES customer_assets (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Which asset a LINE or a CHECK is about ──────────────────────────────────
--
-- Nullable, and nullable is the point. Most jobs have one asset, and naming it
-- on every part and every check would be noise on the overwhelming majority of
-- rows to serve the minority.
--
-- NULL therefore means "the job's asset" — which, on a single-asset job, is the
-- only possible answer and needs no typing. On a four-unit job it means the
-- technician did not say, which is a true and useful thing to record: better
-- than forcing a guess that a warranty claim would later rely on.
--
-- SET NULL rather than CASCADE: removing an asset from a job must not delete
-- the parts fitted or the checks done. The work happened.

ALTER TABLE job_card_lines
  ADD COLUMN IF NOT EXISTS asset_id INT UNSIGNED NULL AFTER expense_category_id;

ALTER TABLE job_card_lines
  ADD KEY IF NOT EXISTS ix_jcl_asset (asset_id);

ALTER TABLE job_card_lines
  ADD FOREIGN KEY IF NOT EXISTS fk_jcl_asset (asset_id)
    REFERENCES customer_assets (id) ON DELETE SET NULL;

ALTER TABLE job_card_items
  ADD COLUMN IF NOT EXISTS asset_id INT UNSIGNED NULL AFTER attachment_id;

ALTER TABLE job_card_items
  ADD KEY IF NOT EXISTS ix_jci_asset (asset_id);

ALTER TABLE job_card_items
  ADD FOREIGN KEY IF NOT EXISTS fk_jci_asset (asset_id)
    REFERENCES customer_assets (id) ON DELETE SET NULL;

-- ── THE READ THAT HAS TO KEEP WORKING ───────────────────────────────────────
--
-- This is the whole risk of this migration, and it is worth stating in the
-- schema rather than only in a plan.
--
--   SELECT ... FROM job_cards WHERE asset_id = ?
--
-- is an asset service history today, and it appears ELEVEN times across
-- jobAssets.ts: the history query itself, three separate job_count subqueries,
-- an open-job count, the setter and the unlinker. A migration that adds a join
-- table and fixes only the history query leaves those counts quietly wrong —
-- an asset would show four jobs on one screen and six on another, and neither
-- number would look obviously broken.
--
-- So every one of them becomes a UNION over both, in ONE helper, and the test
-- asserts a secondary asset appears in the history AND in the count.
