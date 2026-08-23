-- ─────────────────────────────────────────────────────────────────────────
-- Which units are going on which job line (§31).
--
-- ── WHY A TABLE AND NOT A COLUMN ON product_serials ──────────────────────
--
-- A column would be the obvious move: product_serials already carries
-- location_id and received_doc_id, so job_card_line_id looks like one more of
-- the same. It is not, and the difference is one-to-many.
--
-- A job line for five compressors needs five serials. A column can hold one
-- link per unit, which is the right shape for "where is it" and the wrong shape
-- for "what is on this line" -- reading the line's allocation would mean
-- scanning every serial of that product looking for a match, and the count that
-- decides whether the line is fully allocated would have no index behind it.
--
-- ── WHY NOT REUSE THE SALES ALLOCATION ───────────────────────────────────
--
-- salesPosting already allocates serials, through markSold, at the moment an
-- invoice is finalised. That is where allocation has always happened and it is
-- not being moved.
--
-- What is being added is EARLIER: the technician standing at the van with the
-- box in their hand, who knows which unit they are about to fit. Recording it
-- there means the invoice inherits an answer somebody checked on site rather
-- than asking an office clerk days later which of four compressors went where.
--
-- So this table is the INTENT, and markSold remains the act. A row here says
-- "this unit is spoken for by this line"; the serial itself stays in_stock and
-- keeps its location until the invoice posts.
--
-- ── WHAT THIS DELIBERATELY DOES NOT DO ───────────────────────────────────
--
-- It does not reserve. A serial allocated to a job line is still in_stock and
-- still counted by every stock read, exactly as before -- because the QUANTITY
-- is already claimed by job_stock_reservations (220), and deducting it a second
-- time because a specific unit was named is precisely the double-count that
-- table's header spends forty lines on.
--
-- What it prevents is two lines naming the SAME unit, which the unique key below
-- makes impossible.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS job_line_serials (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,

  job_card_line_id INT UNSIGNED NOT NULL,
  serial_id        INT UNSIGNED NOT NULL,

  -- Denormalised so the job card can show what was allocated without joining
  -- through to products, and so the row still reads correctly in an audit after
  -- somebody edits the serial text. Same reasoning as the destination column on
  -- job_notifications: what was recorded at the time is the fact.
  serial_text  VARCHAR(64) NOT NULL,

  allocated_by_user_id INT UNSIGNED NULL,
  allocated_by_name    VARCHAR(120) NOT NULL DEFAULT '',
  allocated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),

  -- ONE line may claim a unit. Not (line, serial) -- that would let two
  -- different job lines both name the same compressor, which is the exact
  -- mistake this table exists to make impossible. The serial alone is the key.
  UNIQUE KEY uq_jls_serial (serial_id),

  -- The read the job card performs: everything allocated to this line.
  KEY ix_jls_line (job_card_line_id),

  -- CASCADE on both, and for the same reason job_stock_reservations does: an
  -- allocation is not a historical fact, it is a live claim on a unit. A row
  -- outliving its line would hold a serial against something that no longer
  -- exists, and nothing would ever release it.
  --
  -- The permanent record of which unit went to which customer is written by
  -- markSold into serial_movements when the invoice posts. That is the history;
  -- this is the intent, and intent expires.
  CONSTRAINT fk_jls_line FOREIGN KEY (job_card_line_id)
    REFERENCES job_card_lines (id) ON DELETE CASCADE,
  CONSTRAINT fk_jls_serial FOREIGN KEY (serial_id)
    REFERENCES product_serials (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
