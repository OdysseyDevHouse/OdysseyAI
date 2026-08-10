-- Quick keys: the till's own buttons, arranged by the shop that uses them.
--
-- ── WHAT THIS IS FOR ─────────────────────────────────────────────────────
--
-- A cashier should not have to search for the six things they sell fifty times a
-- day, and a till whose only route to a product is a department drill is a till
-- that is slower than the shop needs. Quick keys are the shop's answer to "what
-- do I reach for", and only the shop knows.
--
-- Four kinds of key, one table. They differ in WHAT they point at, not in what
-- they are, and three tables of near-identical shape would need three joins to
-- draw one grid:
--
--   action      — runs something (void, price check, cash-up). `action_slug`.
--   product     — puts one product on the sale. `product_id`.
--   department  — drills into a department. `department_id`.
--   group       — a folder of other keys. Holds nothing itself.
--
-- ── ONE LEVEL OF NESTING, AND WHY NOT MORE ───────────────────────────────
--
-- `parent_id` is self-referencing, so the schema would permit any depth. The
-- code enforces one level deliberately: a cashier who has to remember which
-- folder inside which folder holds the milk is slower than one reading a flat
-- grid, and the reference POS this is modelled on grew three levels that nobody
-- could navigate. A folder of folders is a menu, and a till is not a menu.

CREATE TABLE pos_quick_keys (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- NULL means the key sits on a bar rather than inside a group.
  parent_id     INT UNSIGNED NULL,

  -- Which grid this belongs to. 'tables' is the hospitality floor plan's own
  -- set, kept apart so a restaurant's table keys never appear on a retail till.
  section       ENUM('main','tables') NOT NULL DEFAULT 'main',

  kind          ENUM('action','product','department','group') NOT NULL DEFAULT 'action',

  -- Exactly one of these three carries the target, by `kind`. Nullable rather
  -- than one polymorphic column so the FKs below can be real.
  action_slug   VARCHAR(50)  NOT NULL DEFAULT '',
  product_id    INT UNSIGNED NULL,
  department_id INT UNSIGNED NULL,

  -- What the key SAYS. Empty falls back to the target's own name, so a shop that
  -- never types a caption still gets readable keys — and a product renamed in the
  -- product file renames its key with it.
  caption       VARCHAR(60)  NOT NULL DEFAULT '',

  -- A kit icon NAME, not an SVG and not an emoji. See QUICK_KEY_ICONS: swapping
  -- the icon set stays one edit instead of a data migration across every site,
  -- and a lucide glyph inherits currentColor so it is dark-mode-correct, which a
  -- coloured emoji is not.
  icon          VARCHAR(40)  NOT NULL DEFAULT '',

  -- 'tile-1'…'tile-7', a gradient, or 'tile-none' — never a hex value. A record
  -- stores the token so restyling the palette repaints existing keys instead of
  -- leaving them pinned to a literal. Sized 32 for the same reason 068 widened
  -- products.image_color: `tile-grad-1` is eleven characters and a token is a
  -- name that may grow.
  colour_token  VARCHAR(32)  NOT NULL DEFAULT '',

  position      INT UNSIGNED NOT NULL DEFAULT 0,

  -- Hidden rather than deleted, so a shop can put a seasonal key away and get it
  -- back in November without rebuilding it.
  is_hidden     TINYINT(1)   NOT NULL DEFAULT 0,

  /*
   * A supervisor PIN before this key runs.
   *
   * SEPARATE from `capability`, and both are needed. The capability asks "may
   * this person do it at all"; require_auth asks "prove it is still them",
   * which is what a manager wants on a key that writes off stock even when the
   * cashier holding the till legitimately has the right.
   */
  require_auth  TINYINT(1)   NOT NULL DEFAULT 0,

  -- The capability this key needs, typed as `Capability` in the code so a typo
  -- is a compile error rather than a key nobody can press.
  capability    VARCHAR(60)  NOT NULL DEFAULT '',

  /*
   * The key's target, as one string — 'a:void-sale', 'p:1234', 'd:57',
   * 'g:supervisor'.
   *
   * This exists so `uq_slot` below can be a real unique index. MySQL cannot
   * index "whichever of action_slug, product_id or department_id applies", and
   * without it a shop could put the same product on one bar twice and then
   * wonder which of two identical keys to edit.
   *
   * SERVER-WRITTEN, never client-supplied: it is derived from the other columns,
   * and a client that could set it independently could make it disagree with
   * them — at which point the uniqueness it enforces is uniqueness of nothing.
   */
  sig           VARCHAR(80)  NOT NULL DEFAULT '',

  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),

  /*
   * One of each target per slot.
   *
   * ⚠ MySQL treats NULLs as DISTINCT in a unique index, so this does NOT
   * constrain top-level keys — every key on a bar has parent_id NULL, and any
   * number of NULLs coexist. The same property `uq_doc_number` and
   * `uq_terminal_device` already lean on, working against us here.
   *
   * So the code checks the slot as well, and `listQuickKeys` is the only reader.
   * Written down because it will otherwise be rediscovered by somebody adding a
   * duplicate top-level key and finding the database perfectly happy.
   */
  UNIQUE KEY uq_slot (parent_id, section, sig),
  KEY idx_scope (section, parent_id, position),

  -- CASCADE, and this is the one place the FK and the intended behaviour
  -- DISAGREE: deleting a group is meant to PROMOTE its members to the bar, not
  -- delete them. deleteQuickKey therefore re-parents to NULL before deleting, and
  -- the cascade is the backstop for a row removed any other way.
  CONSTRAINT fk_quick_keys_parent FOREIGN KEY (parent_id)
    REFERENCES pos_quick_keys (id) ON DELETE CASCADE,

  -- A key pointing at a deleted product is a key that cannot work, so it goes
  -- with it. By ID rather than by code — a renamed product code would orphan a
  -- key that stored the code, which is the argument 056_specials.sql already
  -- makes about departments.
  CONSTRAINT fk_quick_keys_product FOREIGN KEY (product_id)
    REFERENCES products (id) ON DELETE CASCADE,
  CONSTRAINT fk_quick_keys_department FOREIGN KEY (department_id)
    REFERENCES departments (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
