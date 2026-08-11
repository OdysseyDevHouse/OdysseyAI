-- Paying tips out to the people who earned them.
--
-- RECONSTRUCTED 2026-08-11. Recorded as applied in ody10000_master on
-- 2026-08-10 with no committed file. Shape taken verbatim from
-- SHOW CREATE TABLE on the live database; the comments below are inference.
-- No code in src/ touches it today - see the note in 093_supplier_price_lists.sql.
--
-- sales_tips records that a tip was TAKEN. Nothing until now recorded that it was
-- HANDED OVER, and without that the payout screen cannot tell owed from settled:
-- re-opening last week's date range shows the same money again, and a manager who
-- pays from that figure pays twice. Nothing in the data can catch it afterwards,
-- because there is nothing to catch it WITH.
--
-- So a payout is its own document-shaped record, and every tip it settles points
-- back at it. "Owed" then means exactly one thing — payout_id IS NULL — which is a
-- question the database answers rather than a figure a human reconciles.
--
-- The alternative designs and reasons are preserved in the original incoming text.

CREATE TABLE IF NOT EXISTS tip_payouts (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  /*
   * Who was handed the money. NULL only for a pool paid out as one lump, which
   * this build does not offer — the pool is split across named staff — but the
   * column permits it rather than forcing a fake attribution if that ever changes.
   */
  user_id        INT UNSIGNED NULL,
  /*
   * Denormalised at payout, like sales_tips.user_name and for the same reason: a
   * staff member who leaves and is deleted must not erase the record that they
   * were paid. The FK below is ON DELETE SET NULL, so the id goes and the name stays.
   */
  user_name      VARCHAR(120) NOT NULL DEFAULT '',
  amount         DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  /*
   * How the money reached them. Not an ENUM of tender types — this is not a tender,
   * it is a disbursement, and a shop that pays tips with the next wage run needs
   * 'wages' to be sayable.
   */
  method         ENUM('cash', 'wages', 'transfer', 'other') NOT NULL DEFAULT 'cash',
  /*
   * Where a POOL share came from. A split of the pool produces one payout per
   * person, and each says it was a share rather than that person's own tips —
   * otherwise the payout history reads as though they earned it directly.
   */
  from_pool      TINYINT(1) NOT NULL DEFAULT 0,
  note           VARCHAR(200) NULL,
  paid_by        INT UNSIGNED NULL,
  paid_by_name   VARCHAR(120) NOT NULL DEFAULT '',
  paid_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_payout_user (user_id, paid_at),
  KEY ix_payout_paid_at (paid_at),
  CONSTRAINT fk_payout_user FOREIGN KEY (user_id)
    REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_payout_paid_by FOREIGN KEY (paid_by)
    REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

/*
 * The settled marker. NULL means owed, which is the whole point.
 *
 * ON DELETE SET NULL, deliberately: if a payout is ever reversed the tips it
 * settled must return to OWED rather than vanish with it. The opposite (CASCADE)
 * would delete the tip rows themselves — the record that a customer left money —
 * to undo a payment. That is the single worst thing this schema could do.
 */
ALTER TABLE sales_tips
  ADD COLUMN payout_id INT UNSIGNED NULL AFTER user_name,
  ADD KEY ix_tip_payout (payout_id),
  ADD CONSTRAINT fk_tip_payout FOREIGN KEY (payout_id)
    REFERENCES tip_payouts (id) ON DELETE SET NULL;

