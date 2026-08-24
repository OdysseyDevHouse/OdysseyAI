-- ─────────────────────────────────────────────────────────────────────────
-- Rotating menus — what the till shows, by the hour.
--
-- A café serves breakfast until eleven, lunch until five and dinner after
-- that. Today the till draws one grid holding all three, so a cashier at
-- 08:00 is scrolling past ribeye to reach the eggs, and the shop's answer has
-- been to hide things by hand twice a day — which nobody remembers to do at
-- the end of a shift.
--
-- ── WHY THIS IS NOT A DEPARTMENT, AND NOT A SPECIAL ──────────────────────
--
-- Not a department: a product points at exactly ONE department_id (001), so
-- modelling each menu as a department would mean three Flat Whites in the
-- product file — three codes, three stock figures, three lines in every
-- report about a drink the shop thinks of as one thing.
--
-- Not a special: 056 already time-boxes PRICE, and this deliberately does not
-- touch price at all. A dinner steak that costs more after five is a special
-- with a daily band, and it composes with this rather than being replaced by
-- it. Menus answer "what is on the grid"; specials answer "what does it cost
-- right now". Folding the two together would give the shop two places to set
-- a price and no rule about which wins.
--
-- ── VISIBILITY ONLY, AND NEVER A REFUSAL ─────────────────────────────────
--
-- Off-menu means off the GRID. A scan or a search still finds the product and
-- still sells it, exactly as products.visible_in_pos already behaves
-- (menuDesigner.ts:38). This is the deliberate choice: a kitchen that will
-- still make you eggs at 11:05 is normal, and a till that refuses the sale
-- turns a hospitality decision into a software argument at the counter.
--
-- ── THE WINDOW IS WALL-CLOCK TEXT ────────────────────────────────────────
--
-- 'HH:MM' in a VARCHAR(5), and a Monday-first CHAR(7) day mask — the same
-- shape 056_specials.sql:31-36 uses, deliberately, so there is one convention
-- in this database for "recurring band inside a week" rather than two.
--
-- The site pools connect with timezone:'Z', so a TIME or DATETIME column is
-- read back shifted (see 084's docblock, and 057_specials_wallclock.sql).
-- "Breakfast ends at eleven" means eleven on the SHOP's clock; text compared
-- as text puts no timezone between what was typed and when it happens.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pos_menus (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- What the shop calls it, and what the till puts on the menu chip.
  -- 'Breakfast', 'Lunch', 'Winter dinner'.
  name         VARCHAR(80) NOT NULL,

  -- The owner's switch, separate from the window. Switching a menu off for a
  -- fortnight must not mean retyping its hours to bring it back.
  is_active    TINYINT(1) NOT NULL DEFAULT 1,

  /*
   * The band, as local wall-clock 'HH:MM'.
   *
   * An end BEFORE the start runs overnight — 22:00–02:00 — which is a real
   * thing a late-night menu does, and specialActiveAt already handles it.
   *
   * BOTH EMPTY MEANS ALL DAY, and that is a useful menu rather than a broken
   * one: a shop with a single all-day menu plus a late-night one wants the
   * first to have no band at all. One end alone is half-configured, and the
   * validator refuses it rather than inventing the other.
   */
  daily_start  VARCHAR(5) NOT NULL DEFAULT '',
  daily_end    VARCHAR(5) NOT NULL DEFAULT '',

  -- Seven characters of 0/1, MONDAY FIRST — the house convention shared by
  -- specials (056), report schedules (054) and alerts (186). The conversion
  -- from JS's Sunday-first getDay() happens in one place in the evaluator.
  days_of_week CHAR(7) NOT NULL DEFAULT '1111111',

  /*
   * Lower wins when two menus overlap.
   *
   * Overlap is not an error and must not be prevented. Breakfast 07:00–11:00
   * and an all-day menu both legitimately cover 09:00, and the shop's answer
   * is "breakfast, obviously" — which is a priority, not a conflict. The
   * alternative, refusing to save overlapping windows, would make the common
   * arrangement impossible to express.
   *
   * ⚠ The winner takes the grid ALONE; menus do not union. Two menus merged
   * would show a breakfast/lunch hybrid at 09:00 that no customer can order
   * from, and the shop would have no way to say which it meant.
   */
  priority     INT NOT NULL DEFAULT 0,

  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by   VARCHAR(120) NOT NULL DEFAULT '',
  updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  updated_by   VARCHAR(120) NOT NULL DEFAULT '',

  PRIMARY KEY (id),
  -- The only read that matters: "what menus does this till need to know
  -- about", asked on every catalogue sync. Almost always a handful of rows.
  KEY ix_pos_menu_live (is_active, priority, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── What is on the menu ──────────────────────────────────────────────────
--
-- The same two-table shape as specials/special_items, for the same reason:
-- the menu is one row and its scope is a list.
--
-- A DEPARTMENT row carries the bulk — "lunch is the Burgers and Salads
-- departments" is one row each, and a burger added to the file next week
-- joins the lunch menu without anybody editing it. A PRODUCT row is the
-- exception: the Flat White that belongs on all three menus, and the kids
-- burger that belongs on none.
CREATE TABLE IF NOT EXISTS pos_menu_items (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  menu_id       INT UNSIGNED NOT NULL,

  /*
   * 'include' — put this on the menu.
   * 'exclude' — keep this OFF, even though a department row put it on.
   *
   * Exclusions exist because the alternative is listing a department's other
   * forty products by hand to leave one out. EXCLUDE ALWAYS WINS over
   * include, whatever order the rows are in — the narrower statement is the
   * more deliberate one, and a rule that depended on row order would be a
   * rule nobody could predict from the screen.
   */
  effect        ENUM('include','exclude') NOT NULL DEFAULT 'include',

  /*
   * Exactly one of these carries the target. Nullable rather than one
   * polymorphic column so both foreign keys below can be real.
   *
   * A department matches its whole SUBTREE, resolved the same way
   * browseForTill already drills one (tillSearch.ts:295) — a shop that puts
   * "Drinks" on the lunch menu means the sodas and the coffees under it too.
   */
  product_id    INT UNSIGNED NULL,
  department_id INT UNSIGNED NULL,

  PRIMARY KEY (id),

  /*
   * One statement per target per menu.
   *
   * ⚠ MySQL treats NULLs as DISTINCT in a unique index, so this constrains a
   * pair only when both columns are set — and here exactly one ever is. It
   * therefore does NOT stop the same product being added twice. The same
   * property 069's uq_slot documents, and it bites here for the same reason;
   * saveMenuItems dedupes in code, and it is the only writer.
   */
  UNIQUE KEY uq_menu_target (menu_id, product_id, department_id),
  KEY ix_menu_items_menu (menu_id, effect),

  -- CASCADE throughout: a deleted menu takes its scope with it, and a product
  -- or department removed from the file simply stops being on any menu. A
  -- menu that loses one line still draws the other two hundred.
  CONSTRAINT fk_pos_menu_item_menu FOREIGN KEY (menu_id)
    REFERENCES pos_menus (id) ON DELETE CASCADE,
  CONSTRAINT fk_pos_menu_item_product FOREIGN KEY (product_id)
    REFERENCES products (id) ON DELETE CASCADE,
  CONSTRAINT fk_pos_menu_item_department FOREIGN KEY (department_id)
    REFERENCES departments (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
