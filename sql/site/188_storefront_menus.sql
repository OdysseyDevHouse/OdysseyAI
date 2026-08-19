-- ─────────────────────────────────────────────────────────────────────────
-- The shop's own menu, instead of one we generate for it.
--
-- Until now the rail was assembled: every published department in tree order,
-- then a divider, then whichever standard pages had `show_in_nav`. A shop could
-- not put "Sale" first, could not link to its own Instagram, could not add a
-- product it wanted pushed, and could not hide a department from the menu while
-- leaving it browsable. `navPages` is `WHERE kind = 'standard'`, so a department
-- page could never appear in the menu at all.
--
-- ── TWO MENUS, WITH FIXED NAMES ──────────────────────────────────────────
--
-- 'main' and 'footer', and no way to create a third. Shopify lets you name
-- menus because its themes have arbitrary menu slots; this shop front has one
-- masthead and one footer. A create-a-menu screen would have to explain what a
-- menu is FOR, and would introduce a state — a menu attached to nothing — that
-- cannot be reached any other way.
--
-- ── ONE LEVEL OF NESTING, ENFORCED IN THE WRITE PATH ─────────────────────
--
-- `parent_id` may only point at a top-level item. Two levels is a mega-menu;
-- three is a maintenance problem in a shop run by one person. The constraint
-- cannot be expressed in the schema — a self-referencing FK permits any depth
-- — so `saveMenuItems` enforces it, and a cycle here is an infinite render
-- rather than a cosmetic bug.
--
-- ── AN EMPTY TABLE MEANS "STILL GENERATED" ───────────────────────────────
--
-- Deliberately, and it is the whole migration story. A shop that has never
-- opened the editor has no rows, and `resolveMenu` returns exactly the rail it
-- returns today. The editor's first action materialises that generated rail
-- into real rows, so an owner starts from what they already have rather than
-- from an empty menu they have to rebuild before their shop works again.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS storefront_menus (
  id     INT UNSIGNED NOT NULL AUTO_INCREMENT,
  -- 'main' | 'footer'. A fixed set — see above.
  slug   VARCHAR(24) NOT NULL,
  title  VARCHAR(60) NOT NULL DEFAULT '',
  PRIMARY KEY (id),
  UNIQUE KEY uq_menu_slug (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS storefront_menu_items (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  menu_id     INT UNSIGNED NOT NULL,
  -- NULL for a top-level item. Only ever points at a top-level item; the depth
  -- rule lives in the write path, not here.
  parent_id   INT UNSIGNED NULL,
  sort_order  INT NOT NULL DEFAULT 0,
  label       VARCHAR(60) NOT NULL DEFAULT '',
  /*
   * What this item points at.
   *
   * A KIND plus a reference, never a stored URL. A department's address is
   * `/c/<id>` today and the shop's token sits in front of it — storing the
   * built path would freeze both, and a menu full of dead links is the failure
   * an owner discovers from a customer. The renderer builds the href from the
   * kind, which means a routing change moves every menu in every shop at once.
   *
   * 'url' is the exception and the only one: an outside link has no id to hold.
   */
  target_kind VARCHAR(16) NOT NULL DEFAULT 'url',
  target_id   INT UNSIGNED NULL,
  target_url  VARCHAR(300) NOT NULL DEFAULT '',
  -- Optional, for a menu that shows pictures beside its top-level items.
  image_id    BIGINT UNSIGNED NULL,
  PRIMARY KEY (id),
  KEY ix_menu_items_menu (menu_id, sort_order),
  CONSTRAINT fk_menu_item_menu FOREIGN KEY (menu_id)
    REFERENCES storefront_menus (id) ON DELETE CASCADE,
  -- A child goes when its parent does, rather than becoming a top-level item
  -- nobody put there.
  CONSTRAINT fk_menu_item_parent FOREIGN KEY (parent_id)
    REFERENCES storefront_menu_items (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
