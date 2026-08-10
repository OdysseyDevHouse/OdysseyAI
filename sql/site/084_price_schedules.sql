-- Scheduled price changes: a new price list that arrives on its own.
--
-- ── THE PROBLEM ──────────────────────────────────────────────────────────
--
-- product_prices holds exactly one row per (product, price type) and no date.
-- The only way to change a price is to change it NOW, so an owner who wants new
-- prices on Monday morning has to BE there on Monday morning — or change them
-- on Sunday evening and trade a whole night on next week's prices.
--
-- ── WHY THIS IS NOT A SPECIAL ────────────────────────────────────────────
--
-- 056 already does time-boxed price reductions, and this is deliberately not
-- that. A special is a promotion: it runs for a window and the shelf price
-- underneath it never moves. This is the shelf price itself changing, once and
-- permanently. Modelling "my new menu" as a special that never ends would leave
-- the real price wrong in every report, every stock valuation and every
-- integration that reads product_prices.
--
-- ── TWO TABLES, BECAUSE A CHANGE HAS A VARIABLE-LENGTH SCOPE ─────────────
--
-- Same shape as specials/special_items, for the same reason: the change itself
-- is one row, and what it does to each product is a list.

CREATE TABLE price_schedules (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  -- What the owner calls it. 'Winter menu', 'April increase'.
  name           VARCHAR(120) NOT NULL,

  /*
   * When it happens — local wall-clock text, 'YYYY-MM-DDTHH:mm', NOT a DATETIME.
   *
   * The same decision 057 made for specials and 075 for page publishing, for
   * the same reason. The site pools connect with timezone:'Z', so mysql2 reads
   * every DATETIME as UTC and converts on the way out. A special written to
   * start at 07:30 came back as 09:30 in South Africa and simply never ran.
   *
   * "New prices at six" means six on the SHOP's clock, in the shop's town, and
   * text compared as text puts no timezone between what was typed and when it
   * fires. VARCHAR(16) is exactly the format's width.
   */
  effective_at   VARCHAR(16) NOT NULL DEFAULT '',

  /*
   * draft     — being built. Invisible to tills; changes freely.
   * armed     — approved and shipped to the tills, waiting for its moment.
   * applied   — written to product_prices. The lines are now history.
   * cancelled — withdrawn, or reverted after firing.
   */
  status         ENUM('draft','armed','applied','cancelled') NOT NULL DEFAULT 'draft',

  /*
   * Stamped by the tick, inside the same transaction that writes the prices.
   *
   * This is the idempotence guard. The tick claims a schedule with
   * `UPDATE ... WHERE status='armed' AND applied_at IS NULL`, so two overlapping
   * runs cannot both apply it — a read-then-write would let both see 'armed'
   * and both proceed, and every price would be written twice.
   */
  applied_at     DATETIME NULL,

  -- How many prices actually moved. Kept rather than re-derived because the
  -- count beside the Undo button must not be a guess about a catalogue that has
  -- changed since.
  applied_count  INT UNSIGNED NOT NULL DEFAULT 0,

  -- Why it did not go cleanly, if it did not. A schedule whose products were
  -- deleted under it must SAY so rather than looking quietly successful.
  note           VARCHAR(400) NOT NULL DEFAULT '',

  -- How many times firing has thrown. A schedule that cannot succeed is
  -- cancelled after a few attempts rather than churning every five minutes
  -- forever, which is noise nobody reads and load nobody wanted.
  fail_count     INT UNSIGNED NOT NULL DEFAULT 0,

  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by     VARCHAR(120) NOT NULL DEFAULT '',
  updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  updated_by     VARCHAR(120) NOT NULL DEFAULT '',

  PRIMARY KEY (id),
  /*
   * The two queries that matter, both covered by this one index:
   *   the tick's  "anything armed and due?"   — asked every five minutes,
   *   the till's  "what is armed and coming?" — asked on every catalogue sync.
   * Almost always empty, so the cheapest possible "nothing to do" is the point.
   */
  KEY ix_sched_due (status, effective_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE price_schedule_lines (
  id                 INT UNSIGNED NOT NULL AUTO_INCREMENT,
  schedule_id        INT UNSIGNED NOT NULL,

  product_id         INT UNSIGNED NOT NULL,

  /*
   * The price type sits on the LINE, not the header.
   *
   * A shop raising Retail and Wholesale together means one change, and a header
   * that named a single price type would force two schedules for it. Two
   * schedules can fire a minute apart, fail independently, and be reverted
   * separately — so for that one minute the shop is selling at new retail and
   * old wholesale, which is not a state anybody asked for.
   */
  price_structure_id INT UNSIGNED NOT NULL,

  /*
   * What it becomes. ABSOLUTE and VAT-inclusive — never a delta.
   *
   * This is load-bearing for the tills. A till applies the change on its own
   * clock at 06:00 and the tick writes the same number to product_prices a few
   * minutes later; when the till then reloads its catalogue, the base price it
   * reads is already the new one. Because the pending line REPLACES rather than
   * adjusts, both sides of that write resolve to the same number and the price
   * does not move. Stored as '+2.00' it would resolve to 14 the moment the base
   * became 12, and every till would double-apply until its next refresh.
   */
  new_price_incl     DECIMAL(12,4) NOT NULL,

  /*
   * What it WAS when this line was built — captured at build time, not at fire
   * time.
   *
   * This is the only price history the system has ever had. It fills the
   * "before" column so an owner can see a 40% rise before approving it, and it
   * is what "put these prices back" restores from.
   *
   * NULL means the product had NO price under that price type at all, which
   * restores to having none again rather than to zero. Zero is a price; a shop
   * that gave everything away because an undo wrote 0.00 would be a bad day.
   */
  old_price_incl     DECIMAL(12,4) NULL,

  -- 'typed' — somebody keyed this exact number.
  -- 'rule'  — the reprice planner generated it and it was MATERIALISED here.
  -- Per line, so a schedule built both ways can say which half came from where.
  origin             ENUM('typed','rule') NOT NULL DEFAULT 'typed',

  PRIMARY KEY (id),
  /*
   * One price per product per price type per schedule. A second row would be
   * two different answers to the same question, and whichever the batch wrote
   * last would silently win.
   */
  UNIQUE KEY uq_sched_line (schedule_id, product_id, price_structure_id),
  KEY ix_sched_line_product (product_id),

  CONSTRAINT fk_sched_line_schedule
    FOREIGN KEY (schedule_id) REFERENCES price_schedules (id) ON DELETE CASCADE,
  /*
   * CASCADE, not RESTRICT. Deleting a product must not be blocked by a price
   * somebody pencilled in for it next week, and a schedule that loses one line
   * still applies the other four hundred.
   */
  CONSTRAINT fk_sched_line_product
    FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE CASCADE,
  CONSTRAINT fk_sched_line_structure
    FOREIGN KEY (price_structure_id) REFERENCES price_structures (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
