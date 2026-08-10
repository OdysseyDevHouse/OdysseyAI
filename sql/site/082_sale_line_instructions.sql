-- ============================================================================
-- What was actually chosen, on the line it was chosen for.
--
-- 010 and 080 describe the QUESTIONS a till asks. This is the first table that
-- records the ANSWERS — until now the whole feature was configuration that
-- nothing at sale time ever read, so a shop could define "how would you like
-- your eggs?" and the till would never ask it, never charge for it, and never
-- deduct the extra rasher from stock.
--
-- ── WHY A CHILD TABLE AND NOT MORE sales_document_lines ─────────────────────
--
-- The obvious shortcut is to write "Extra bacon" as another line. It is wrong
-- for the reason onlineOrders already records about a synthetic discount line:
-- everything downstream of sales_document_lines is built on "one row is one
-- product sold". The report builder says so in as many words; salesPosting moves
-- stock once per row. A modifier posing as a line lands in units-sold, margin and
-- department reports as if somebody had bought a bacon, and every one of the six
-- modules reading that table would need to learn to exclude it. The one that got
-- forgotten would be silently wrong, and nobody would find out from a number
-- that merely looks a bit high.
--
-- ── WHY NOT JSON ON THE LINE ────────────────────────────────────────────────
--
-- It would ride along through the line rewrite for free, which is genuinely
-- tempting. But "how many extra bacon did we sell in March" then means scanning
-- and parsing every line in the range, and — worse — the report builder's
-- catalogue is built out of tables and columns, so a blob can never become a
-- source in it. The shop could never ask that question of its own data. In
-- hospitality the modifiers ARE the margin, so making them the one unqueryable
-- thing in the schema is precisely backwards.
--
-- ── SNAPSHOT EVERYTHING ─────────────────────────────────────────────────────
--
-- The same rule the lines table states at 015: group_name, option_name, the
-- price and the stock quantity are copied here at sale time. Renaming "Extra
-- bacon" to "Bacon (extra)" next month must not rewrite what last month's
-- tickets said, and deleting the option must leave the invoice readable — which
-- is why both ids are ON DELETE SET NULL and neither is relied on to render a
-- historic document.
-- ============================================================================

CREATE TABLE sales_document_line_instructions (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- The line this answers for. CASCADE is what makes this table safe under
  -- saveDraft, which rewrites a document's lines wholesale — it deletes every
  -- line and re-inserts, and these go with them rather than being orphaned or
  -- needing their own delete pass.
  line_id     INT UNSIGNED NOT NULL,

  -- Reachable through the line, and stored anyway.
  --
  -- Redundant on purpose: "every modifier on this document" is what the kitchen
  -- ticket, the receipt and the recall path each want, and without this it is a
  -- join through the lines table every time. One indexed read instead. The same
  -- trade the lines table already makes with department_id.
  document_id INT UNSIGNED NOT NULL,

  -- The order they were asked in, so a ticket reads the way the cashier worked.
  sort_order  INT NOT NULL DEFAULT 0,

  -- ── The snapshot ──────────────────────────────────────────────────────────
  group_id    INT UNSIGNED NULL,
  group_name  VARCHAR(120) NOT NULL DEFAULT '',
  option_id   INT UNSIGNED NULL,
  option_name VARCHAR(120) NOT NULL DEFAULT '',

  -- How many of this option ONE ITEM on the line carries.
  --
  -- Per item, not per line: two burgers each with bacon ×3 stores 3 here, and the
  -- line's own qty does the multiplying. Storing 6 would make the row unreadable
  -- the moment somebody changes the line quantity, and would answer "how much
  -- bacon per burger" with arithmetic instead of a number.
  qty         DECIMAL(12,3) NOT NULL DEFAULT 1.000,

  -- What one of this option adds, INCLUSIVE of VAT and signed, copied from
  -- instruction_options at the moment of sale.
  price_adjust_incl DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  -- What this option contributed to the line in total: qty × price_adjust_incl ×
  -- the line's quantity. Stored rather than derived because it is the figure
  -- every report wants to sum, and re-deriving it needs a join back to the line
  -- to find a quantity that may since have been part-delivered.
  --
  -- It is NOT a charge in its own right. The money is already inside the line's
  -- unit_price_incl — the option price is folded in there so that specials,
  -- discounts and VAT all see the item at the price it was actually sold at.
  -- This column is the BREAKDOWN of a figure that has already been charged.
  -- Summing it alongside line_total_incl double-counts.
  line_adjust_incl  DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  -- ── The stock half ────────────────────────────────────────────────────────
  -- Set when choosing this deducted a real product. NULL is the ordinary case:
  -- most answers are just words on a ticket.
  product_id  INT UNSIGNED NULL,
  -- How much of that product ONE of this option consumes, snapshotted for the
  -- same reason as the price: re-reading it later would revalue history.
  stock_qty_per DECIMAL(12,3) NOT NULL DEFAULT 0.000,

  -- ── Where it gets repeated ────────────────────────────────────────────────
  -- Snapshotted from the option so a reprinted ticket matches the one the
  -- kitchen originally worked from, even if the flags have since been changed.
  prints_on_kitchen TINYINT(1) NOT NULL DEFAULT 1,
  prints_on_receipt TINYINT(1) NOT NULL DEFAULT 1,

  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY ix_sdli_line (line_id, sort_order),
  KEY ix_sdli_document (document_id),
  -- The reporting read: "how many of this option did we sell". Indexed on the
  -- option rather than the name, because a rename must not split the history.
  KEY ix_sdli_option (option_id),
  KEY ix_sdli_product (product_id),

  CONSTRAINT fk_sdli_line     FOREIGN KEY (line_id)     REFERENCES sales_document_lines (id) ON DELETE CASCADE,
  CONSTRAINT fk_sdli_document FOREIGN KEY (document_id) REFERENCES sales_documents (id)      ON DELETE CASCADE,
  -- SET NULL on all three: the snapshot above is what renders the document, so
  -- losing the id costs nothing a customer would notice, while CASCADE here
  -- would delete a piece of an invoice because somebody tidied the menu.
  CONSTRAINT fk_sdli_group    FOREIGN KEY (group_id)    REFERENCES instruction_groups (id)   ON DELETE SET NULL,
  CONSTRAINT fk_sdli_option   FOREIGN KEY (option_id)   REFERENCES instruction_options (id)  ON DELETE SET NULL,
  CONSTRAINT fk_sdli_product  FOREIGN KEY (product_id)  REFERENCES products (id)             ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
