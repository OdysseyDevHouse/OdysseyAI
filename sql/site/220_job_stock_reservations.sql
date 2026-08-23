-- ─────────────────────────────────────────────────────────────────────────
-- Job stock reservations: parts promised to a job that have not moved yet.
--
-- ── WHY THIS REVERSES A DOCUMENTED DECISION ──────────────────────────────
--
-- 110_technician_vans.sql says "NO reservation columns" and gives the reason:
-- issuing a part to a van does not release its reservation, so the same unit
-- would be deducted twice from availableToSell -- which reads the MAIN pile and
-- subtracts a site-wide reservation -- permanently, for every part in every van.
--
-- That comment also names its own precondition: "That needs issued_qty below to
-- exist first, and it needs a quarter of the column being correct before it is
-- folded into the till's read path." Both now hold. issued_qty exists, every
-- issue and return maintains it, and reconcileJobParts has been checking it
-- against the transfers that moved it since 110 landed.
--
-- So the objection is answered by RELEASE ON ISSUE, and that is the one rule
-- this table cannot get wrong. The moment stock physically moves to a van, MAIN
-- has already dropped by the transfer -- so the reservation must go at the same
-- instant, in the same transaction, or the double deduction the old comment
-- warned about is exactly what happens.
--
-- ── WHAT THIS IS NOT ─────────────────────────────────────────────────────
--
-- NOT a stock movement. salesOrders.ts rule 2 is untouched and must stay that
-- way: stock_movements records actual movement only, so that Sigma qty_change
-- still equals stock_on_hand. A reservation has moved nothing -- it has made a
-- claim on what is there. Nothing in this file writes to stock_movements, and a
-- reservation never changes a pile.
--
-- The DERIVED reservations keep working exactly as they did. reservedQtyFor()
-- gains a fourth branch beside sales orders, lay-bys and online holds; it does
-- not replace them. What is new is only that a job can now make the same kind of
-- claim, which it never could.
--
-- ── WHY A TABLE, WHEN THE OTHER THREE ARE DERIVED ────────────────────────
--
-- The other three derive because their claim IS their document: an open sales
-- order line with reserves_stock is the reservation, and there is nothing to
-- store. A job line is not, because the same line means different things at
-- different moments -- quoted but unaccepted claims nothing, accepted claims the
-- stock, issued has already taken it, invoiced has consumed it.
--
-- Deriving that from the line would mean encoding the whole lifecycle in one
-- SELECT and getting the release right in a subquery. Storing the claim makes
-- reserve and release two explicit events that a reconciliation can check, which
-- is what every other risky quantity in this module already does.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS job_stock_reservations (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- The line that made the claim. One row per line, which is what makes
  -- release-on-issue a single targeted DELETE rather than a search.
  job_card_line_id INT UNSIGNED NOT NULL,

  -- Denormalised from the line so the reservation read never has to join job
  -- tables. reservedQtyFor runs on the till's critical path for every product in
  -- a basket, and it already UNIONs three sources; a fourth that dragged
  -- job_card_lines and job_cards behind it would be the slowest branch by far.
  --
  -- job_card_id is here for the same reason: the reconciliation asks "which job"
  -- without a join, and a drift report that cannot name the job is not actionable.
  job_card_id  INT UNSIGNED NOT NULL,
  product_id   INT UNSIGNED NOT NULL,

  -- Where the claim is made. Currently always the main location, because that is
  -- the pile availableToSell reads. Stored rather than assumed so a future
  -- per-location availability read has the column it needs, and so a claim
  -- against a room that is later retired is visible rather than silently
  -- becoming a claim on somewhere else.
  location_id  INT UNSIGNED NOT NULL,

  qty          DECIMAL(12,3) NOT NULL,

  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),

  -- One live claim per line. A second reserve for the same line UPDATEs rather
  -- than inserting, so a line cannot accumulate claims it will never release --
  -- which is the shape every stale-reservation bug takes.
  UNIQUE KEY uq_jobres_line (job_card_line_id),

  -- The read path: reservedQtyFor groups by product across the whole site.
  KEY ix_jobres_product (product_id, location_id),

  -- CASCADE, unlike the notification log which keeps rows after its people
  -- leave. A reservation is not a historical fact -- it is a claim that is
  -- either live or gone. A row surviving its job line would hold stock against a
  -- line nothing can release, which is a permanent phantom deduction at the till
  -- and precisely the failure 110 refused to risk.
  CONSTRAINT fk_jobres_line FOREIGN KEY (job_card_line_id)
    REFERENCES job_card_lines (id) ON DELETE CASCADE,
  CONSTRAINT fk_jobres_job FOREIGN KEY (job_card_id)
    REFERENCES job_cards (id) ON DELETE CASCADE,
  CONSTRAINT fk_jobres_product FOREIGN KEY (product_id)
    REFERENCES products (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
