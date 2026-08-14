-- ── Asking for a part the shop does not have (28) ───────────────────────────
--
-- Today a technician who needs a part that is not on the shelf hits a hard
-- refusal and there is nowhere to go from it:
--
--   "BRK-PAD-01 has only 0 in Main Store — cannot move 4."
--
-- That message, raised in stockTransfers.ts and forwarded unchanged by
-- issueParts, is the dead end this table replaces with "ask for it".
--
-- ── A REQUEST IS NOT A DOCUMENT ─────────────────────────────────────────────
--
-- The doctrine comes from job_requests (129): no sequence number is burned on
-- something that is usually declined, and nothing is posted. A request records
-- that somebody asked. What it becomes — a purchase order, or nothing — is a
-- separate act by somebody who buys.
--
-- ── AND IT RESERVES NOTHING ─────────────────────────────────────────────────
--
-- Emphatically. jobParts.ts:23-41 records that a job reservation folded into
-- reservedQtyFor() was designed and DELIBERATELY DROPPED: availableToSell()
-- subtracts a site-wide reservation from the MAIN pile, which has already
-- dropped by the transfer, so a surviving reservation deducts the same unit
-- twice for every part in every van, permanently.
--
-- A part that does not exist yet must certainly not reserve anything. This
-- table is a queue of questions, not a claim on stock.
--
-- ── MODELLED ON leave_requests (058) ────────────────────────────────────────
--
-- The repo has exactly one true requested-then-approved table and it is that
-- one, not job_requests. Three of its decisions are copied deliberately:
--
--   the requester name is SNAPSHOTTED with no FK, because a record is evidence
--   and must outlive the user row somebody tidies away;
--
--   the asked-for quantity is STORED, not derived, because what was asked for
--   and what was ordered are different facts and both matter;
--
--   decided_by / decided_at / decided_note travel together, so a refusal can
--   say why.

CREATE TABLE IF NOT EXISTS job_part_requests (
  id               INT UNSIGNED NOT NULL AUTO_INCREMENT,

  job_card_id      INT UNSIGNED NOT NULL,

  -- The line this is for, where there is one. SET NULL because a request is
  -- evidence of a request: deleting the line it was raised against must not
  -- destroy the record that somebody asked.
  job_card_line_id INT UNSIGNED NULL,

  -- Snapshotted alongside the id, following leave_requests: a product renamed
  -- or retired must not make an old request unreadable. product_id is nullable
  -- so a technician can ask for something not on file at all, which §28 wants
  -- and which is how a one-off part gets bought.
  product_id       INT UNSIGNED NULL,
  product_code     VARCHAR(48)  NULL,
  description      VARCHAR(190) NOT NULL,

  qty              DECIMAL(12,3) NOT NULL DEFAULT 1.000,

  --   requested  somebody asked
  --   approved   a buyer agreed, and has not raised the order yet
  --   ordered    it is on a purchase order
  --   received   the goods arrived
  --   cancelled  it was declined, or the need went away
  status           ENUM('requested','approved','ordered','received','cancelled')
                     NOT NULL DEFAULT 'requested',

  -- The technicians own words. "Customer is waiting" and "spare for the van"
  -- deserve different answers, and only the person asking knows which it is.
  reason           VARCHAR(400) NULL,

  requested_by_user_id INT UNSIGNED NULL,
  requested_by_name    VARCHAR(120) NOT NULL DEFAULT '',

  decided_by_user_id   INT UNSIGNED NULL,
  decided_by_name      VARCHAR(120) NULL,
  decided_at           DATETIME NULL,
  decided_note         VARCHAR(400) NULL,

  -- Which purchase line it ended up on, once a buyer raised one. SET NULL for
  -- the same reason as job_card_line_id, and because saveOrder rewrites its
  -- lines wholesale — see 163, which is where that trap is written down.
  purchase_line_id     INT UNSIGNED NULL,

  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                     ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),

  -- The two real screens, copying leave_requests two indexes:
  --   "what is this job waiting on"  and  "the buyers queue".
  KEY ix_jpr_job (job_card_id, status),
  KEY ix_jpr_status (status, created_at),
  KEY ix_jpr_line (job_card_line_id),
  KEY ix_jpr_purchase_line (purchase_line_id),

  CONSTRAINT fk_jpr_job FOREIGN KEY (job_card_id)
    REFERENCES job_cards (id) ON DELETE CASCADE,
  CONSTRAINT fk_jpr_job_line FOREIGN KEY (job_card_line_id)
    REFERENCES job_card_lines (id) ON DELETE SET NULL,
  CONSTRAINT fk_jpr_product FOREIGN KEY (product_id)
    REFERENCES products (id) ON DELETE SET NULL,
  CONSTRAINT fk_jpr_purchase_line FOREIGN KEY (purchase_line_id)
    REFERENCES purchase_document_lines (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Settings ────────────────────────────────────────────────────────────────
--
-- Whether a technician may ask at all. ON, because the feature is worthless
-- switched off by default and the refusal it replaces is already in front of
-- people; a business that does not want it can turn it off.
INSERT INTO settings (setting_key, setting_value)
SELECT 'job_part_requests_enabled', '1'
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE setting_key = 'job_part_requests_enabled');
