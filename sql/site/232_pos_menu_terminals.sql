-- ─────────────────────────────────────────────────────────────────────────
-- Which tills a rotating menu applies to.
--
-- ── THE PROBLEM ──────────────────────────────────────────────────────────
--
-- 231 made a menu a property of the SHOP, so every till in the building
-- rotates together. A café with a counter and a bar does not work that way:
-- the bar's till should hold drinks all evening while the food counter moves
-- from lunch to dinner, and the drive-through should never see the sit-down
-- menu at all.
--
-- ── A LINK TABLE, NOT A COLUMN ───────────────────────────────────────────
--
-- One `terminal_id` on pos_menus would allow exactly one till per menu, so a
-- shop with three food counters sharing one lunch menu would need three
-- identical menus — three places to edit when the menu changes, and three
-- chances to leave one behind. The relationship is genuinely many-to-many:
-- a menu runs on several tills, and a till runs several menus through the day.
--
-- ── NO ROWS MEANS EVERY TILL ─────────────────────────────────────────────
--
-- This is the load-bearing decision, and it is the same shape 231 chose for an
-- empty scope: absence means "everywhere", never "nowhere".
--
--   • Every menu that exists today has no rows here, and must go on running on
--     every till exactly as it did before this migration. A default of
--     "nothing" would silently switch off every rotating menu already
--     configured, with nothing on screen to say why.
--   • It is also the honest default for new menus. A shop that has never
--     thought about per-till menus means "the shop", and should not have to
--     tick every till to say so.
--   • And it survives a NEW TILL. A shop that adds a fourth register gets the
--     all-tills menus on it automatically; only the menus deliberately pinned
--     to named tills need revisiting, which is exactly the set somebody
--     thought about in the first place.
--
-- The cost is that "this menu runs nowhere" cannot be expressed by clearing
-- the list — but that is what the `is_active` switch on pos_menus is for, and
-- it says so far more plainly than an empty list ever could.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pos_menu_terminals (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  menu_id     INT UNSIGNED NOT NULL,
  terminal_id INT UNSIGNED NOT NULL,

  PRIMARY KEY (id),

  /*
   * One row per pairing. Both columns are NOT NULL, so — unlike
   * pos_menu_items' uq_menu_target — this unique key really does constrain:
   * MySQL only treats NULLs as distinct, and there are none here.
   */
  UNIQUE KEY uq_menu_terminal (menu_id, terminal_id),

  -- The till's read: "which menus apply to me". Asked on every catalogue sync.
  KEY ix_menu_terminal_terminal (terminal_id),

  CONSTRAINT fk_pos_menu_terminal_menu FOREIGN KEY (menu_id)
    REFERENCES pos_menus (id) ON DELETE CASCADE,

  /*
   * CASCADE, and it has a consequence worth stating.
   *
   * Deleting a till removes its pinning rows. A menu pinned to ONLY that till
   * is then left with no rows at all — which, by the rule above, means it
   * reverts to running on EVERY till rather than on none.
   *
   * That is the safer of the two failures: a menu that suddenly appears
   * everywhere is visible and gets fixed, while one that silently stops
   * running anywhere is discovered by a cashier who cannot find the eggs. The
   * back office lists which tills each menu is pinned to, so the change is
   * legible rather than hidden.
   */
  CONSTRAINT fk_pos_menu_terminal_terminal FOREIGN KEY (terminal_id)
    REFERENCES terminals (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
