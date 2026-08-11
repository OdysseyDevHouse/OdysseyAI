-- Paying tips back out to staff.
--
-- RECONSTRUCTED 2026-08-11. Recorded as applied in ody10000_master on
-- 2026-08-10 with no committed file. Shape taken verbatim from
-- SHOW CREATE TABLE on the live database; the comments below are inference.
-- No code in src/ touches it today - see the note in 093_supplier_price_lists.sql.
--
-- 091_tips.sql records what a customer LEFT, on the sale. This records what the
-- shop PAID OUT, which is a separate event with its own date, method and
-- authoriser. Keeping them apart is what lets the two be reconciled against
-- each other: takings minus payouts is what the drawer still owes the floor.
CREATE TABLE IF NOT EXISTS tip_payouts (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- Who was paid. SET NULL on delete, with the name kept alongside, so a payout
  -- stays readable after the staff member leaves and their user row goes.
  user_id      INT UNSIGNED NULL,
  user_name    VARCHAR(120) NOT NULL DEFAULT '',

  amount       DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  -- How it reached them. Cash out of the drawer is the common case; wages means
  -- it went onto a payslip instead.
  method       ENUM('cash','wages','transfer','other') NOT NULL DEFAULT 'cash',

  -- Whether this came out of the shared pool or off one server own tips.
  from_pool    TINYINT(1) NOT NULL DEFAULT 0,

  note         VARCHAR(200) NULL,

  -- Who authorised it, on the same terms as user_id above.
  paid_by      INT UNSIGNED NULL,
  paid_by_name VARCHAR(120) NOT NULL DEFAULT '',

  paid_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),

  -- "What has this person been paid" and "what went out this shift" are the two
  -- reads; neither should scan the table.
  KEY ix_payout_user (user_id, paid_at),
  KEY ix_payout_paid_at (paid_at),
  KEY fk_payout_paid_by (paid_by),

  CONSTRAINT fk_payout_user    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_payout_paid_by FOREIGN KEY (paid_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
