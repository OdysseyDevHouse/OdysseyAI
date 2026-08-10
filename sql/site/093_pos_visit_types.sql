-- How a table is being served: sit down, takeaway, delivery.
--
-- ── WHY A TABLE RATHER THAN AN ENUM ────────────────────────────────────────
--
-- The reference POS stored this as a fixed upper-case string ('SIT DOWN',
-- 'TAKEAWAY', 'DELIVERY') and the three were compiled into the client. That is
-- wrong for the same reason a hardcoded tender list was: the shop's own words are
-- part of its trade. A drive-through wants "Drive-thru", a hotel wants "Room
-- service", a caterer wants "Function", and none of them should need a release to
-- say so.
--
-- So the types are rows, the till reads them, and Setup → Visit types is where a
-- manager adds one. Exactly the shape `tender_types` already has, and for the same
-- reason — see the note in 042 about a redemption being a row rather than a slot.
--
-- ── WHY THE COLUMN IS NULLABLE AND STAYS THAT WAY ──────────────────────────
--
-- Every table that exists right now has no visit type, and back-filling one would
-- be inventing a fact about trade that already happened. NULL means "nobody said",
-- and the gate reads that as the DEFAULT type rather than as a fourth state — so a
-- floor that never touches this feature files every table under whatever the shop
-- calls sitting down, which is where a waiter looks for it.
--
-- That is also why `is_default` exists on the type rather than a default on the
-- column: the shop decides which type an unlabelled table answers to, and can
-- change its mind without a migration.

CREATE TABLE pos_visit_types (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- What the waiter sees: 'Sit down', 'Takeaway', 'Delivery', 'Drive-thru'.
  -- Sentence case, not upper — it is rendered as typed, so the shop controls how
  -- its own floor reads rather than having the UI shout it.
  name        VARCHAR(40)  NOT NULL,

  /*
   * Which type an unlabelled table counts as.
   *
   * Exactly one row should carry this. It is not enforced by a UNIQUE key because
   * the useful constraint — "exactly one" — is not expressible as one, and a
   * partial unique index on (is_default) would forbid the zero-default state that
   * exists for the instant between clearing one and setting the next. The server
   * module clears the others in the same transaction instead.
   */
  is_default  TINYINT(1)   NOT NULL DEFAULT 0,

  -- Hidden rather than deleted once a type has been used: a type still named by an
  -- open table cannot be removed without orphaning it, and a shop that stops doing
  -- deliveries wants last year's reports to keep saying "Delivery".
  is_active   TINYINT(1)   NOT NULL DEFAULT 1,

  -- The order the segments appear in on the gate. A waiter finds a filter by
  -- position, so it must not reshuffle alphabetically when one is renamed.
  sort_order  SMALLINT UNSIGNED NOT NULL DEFAULT 0,

  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),

  -- Two types with one name is a filter a waiter cannot tell apart. Case-insensitive
  -- by the table's collation, so 'Takeaway' and 'takeaway' collide, which is right.
  UNIQUE KEY uq_visit_type_name (name),

  KEY idx_visit_type_order (is_active, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The three the reference POS had, so a hospitality site opens with a floor that
-- already works and a manager renames rather than invents. A retail site never
-- sees them: the gate only exists in hospitality mode.
INSERT INTO pos_visit_types (name, is_default, sort_order) VALUES
  ('Sit down', 1, 10),
  ('Takeaway', 0, 20),
  ('Delivery', 0, 30);

/*
 * The table's own type.
 *
 * ON DELETE SET NULL, not RESTRICT: retiring a type must never be able to strand a
 * table with a live bill on it. The table falls back to the default type, which is
 * the same place an unlabelled one already lives — so the failure mode is "it moved
 * to the main segment", not "the floor lost a table".
 */
ALTER TABLE pos_tables
  ADD COLUMN visit_type_id INT UNSIGNED NULL AFTER seats,
  ADD KEY idx_table_visit_type (visit_type_id),
  ADD CONSTRAINT fk_table_visit_type FOREIGN KEY (visit_type_id)
    REFERENCES pos_visit_types (id) ON DELETE SET NULL;
