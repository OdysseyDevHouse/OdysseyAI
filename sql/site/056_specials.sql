-- Specials: automatic price reductions the till and the shop apply themselves.
--
-- ── TWO TABLES, BECAUSE A SPECIAL HAS A VARIABLE-LENGTH SCOPE ────────────
--
-- The special itself is one row. What it applies to — and, for a combo, what
-- triggers it and what it gives away — is a list, so it lives in its own
-- table. Roles distinguish the three uses of that list rather than three
-- separate tables that would all have the same shape.

CREATE TABLE specials (
  id                  INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name                VARCHAR(100) NOT NULL,

  -- What the special DOES. Each kind reads a different set of the columns
  -- below; see lib/specialsEngine.ts for the arithmetic of each.
  kind                ENUM('percent_off','fixed_price','cheapest_free','free_item',
                           'bundle_price','spend_get') NOT NULL DEFAULT 'percent_off',

  is_active           TINYINT(1) NOT NULL DEFAULT 1,

  /*
   * Four independent gates, all of which must pass. Kept separate rather than
   * folded into one "is it on" flag because they answer different questions:
   * is_active is the owner's switch, the dates are the campaign, and the daily
   * band and day mask are the recurring pattern inside it.
   */
  starts_at           DATETIME NOT NULL,
  ends_at             DATETIME NOT NULL,
  -- 'HH:MM', or empty for all day. A band whose end is BEFORE its start runs
  -- overnight (22:00–02:00), which is a real thing shops do.
  daily_start         VARCHAR(5) NOT NULL DEFAULT '',
  daily_end           VARCHAR(5) NOT NULL DEFAULT '',
  -- Seven characters of 0/1, MONDAY FIRST. Monday-first because that is how a
  -- shop reads a week; the conversion from JS's Sunday-first getDay() happens
  -- in one place in the engine.
  days_of_week        CHAR(7) NOT NULL DEFAULT '1111111',

  -- percent_off, cheapest_free, spend_get: how much comes off.
  discount_pct        DECIMAL(6,3) NOT NULL DEFAULT 0,
  -- percent_off only: ignore the scope list and apply to the whole shop.
  applies_to_all      TINYINT(1) NOT NULL DEFAULT 0,
  -- cheapest_free: how many must be bought before one is discounted.
  trigger_qty         INT UNSIGNED NOT NULL DEFAULT 0,
  -- bundle_price: what the whole group sells for, VAT inclusive.
  bundle_price_incl   DECIMAL(12,4) NOT NULL DEFAULT 0,
  -- spend_get: the basket total that unlocks it.
  spend_amount_incl   DECIMAL(12,4) NOT NULL DEFAULT 0,

  /*
   * Lower fires first, and the FIRST special to claim a line owns it.
   *
   * Not best-price-wins: a combo cannot be compared against a simple discount
   * without knowing the whole basket, and a shop needs to be able to say which
   * promotion runs. Dragging the list is how that is expressed.
   */
  priority            INT NOT NULL DEFAULT 0,

  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  updated_by          VARCHAR(120) NOT NULL DEFAULT '',

  PRIMARY KEY (id),
  -- The till asks "what is live" on every catalogue refresh.
  KEY idx_specials_live (is_active, ends_at),
  KEY idx_specials_priority (priority, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE special_items (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  special_id    INT UNSIGNED NOT NULL,

  -- 'scope'   — what a simple special applies to
  -- 'trigger' — what must be bought for a combo to fire
  -- 'reward'  — what the customer gets free
  role          ENUM('scope','trigger','reward') NOT NULL DEFAULT 'scope',

  /*
   * A product or a whole department. Departments are matched by ID, not by
   * name — the legacy system matched major departments on their NAME, so
   * renaming one silently stopped every special that targeted it. An id
   * survives a rename.
   */
  product_id    INT UNSIGNED NULL,
  department_id INT UNSIGNED NULL,

  -- How many per deal. Ignored for a simple special's scope rows.
  qty           DECIMAL(12,3) NOT NULL DEFAULT 1,
  -- fixed_price only: what this row's product is marked down to, incl VAT.
  price_incl    DECIMAL(12,4) NOT NULL DEFAULT 0,

  PRIMARY KEY (id),
  KEY idx_special_items_special (special_id, role),
  CONSTRAINT fk_special_items_special
    FOREIGN KEY (special_id) REFERENCES specials (id) ON DELETE CASCADE,
  CONSTRAINT fk_special_items_product
    FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE CASCADE,
  CONSTRAINT fk_special_items_department
    FOREIGN KEY (department_id) REFERENCES departments (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Which special caused a line's discount.
--
-- The legacy system folded a special's reduction into the line's ordinary
-- discount percentage and kept no link back, so "what did this promotion cost
-- us" could not be answered from the sales data at all. The percentage still
-- rides on discount_pct exactly as before — this only records WHY.
--
-- ON DELETE SET NULL rather than RESTRICT: deleting a finished promotion must
-- not be blocked by the history it created, and a sale with a forgotten
-- special is still a correct sale.
ALTER TABLE sales_document_lines
  ADD COLUMN special_id INT UNSIGNED NULL AFTER discount_incl,
  ADD KEY idx_sales_lines_special (special_id),
  ADD CONSTRAINT fk_sales_lines_special
    FOREIGN KEY (special_id) REFERENCES specials (id) ON DELETE SET NULL;
