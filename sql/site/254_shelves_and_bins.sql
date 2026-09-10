-- ─────────────────────────────────────────────────────────────────────────
-- Shelves and bins: WHERE IN THE ROOM, inside one stock location.
--
-- 025_stock_locations.sql answered "which room" — a wholesaler with three
-- stock rooms holds one product in three piles, and product_location_stock is
-- the pile. It stops there. A warehouse holding 480 units gives nobody a clue
-- which aisle to walk to, and a stock take sheet built from that knows no
-- order but the product code, so a counter criss-crosses the room instead of
-- walking it once.
--
-- This file adds the missing level, and only that level.
--
-- ── A BIN HOLDS NO QUANTITY ──────────────────────────────────────────────
--
-- The whole design turns on this. 025 promised three invariants:
--
--   (A)  Σ stock_movements.qty_change            = products.stock_on_hand
--   (B)  Σ qty_change per (product, location)    = product_location_stock.stock_on_hand
--   (C)  Σ product_location_stock.stock_on_hand  = products.stock_on_hand
--
-- Not one of them is touched here. There is no (D). A placement is a LABEL
-- saying where to walk, not a fourth pile to keep in step — so no movement
-- path changes, reconcileStock() is unchanged, and there is nothing new that
-- can drift.
--
-- The alternative was real bin-level quantity, which is a much larger animal:
-- every sale, GRV, transfer, adjustment, build and count would have to name a
-- bin or silently fall back to one, and every one of those fallbacks is a
-- place the figures come apart. A shop that cannot say which of two bins the
-- 480 are in is not worse off than today; a shop whose bin quantities disagree
-- with the location pile is.
--
-- If bin-level quantity is ever genuinely wanted, it arrives as a new table
-- with its own invariant and its own reconciliation, and this one stays what
-- it is.
--
-- ── THE SHAPE ────────────────────────────────────────────────────────────
--
--   stock_locations   (025)      WAREHOUSE
--     └─ stock_shelves           A03  "Aisle A, rack 3"    sort 30
--          └─ stock_bins         2    "middle"             sort 20
--                                3    "bottom"             sort 30
--
--   product_placements   product x location -> (shelf, bin?)   one primary
--
-- A SHELF is a run of storage: an aisle rack, a counter display, a cold room
-- wall. A BIN is a numbered slot on one. Shelves need not have bins at all —
-- a shop with shelving and no numbered slots is the normal case, and a
-- placement may name a shelf alone. That is why the shelf is its own row and
-- not a prefix inside a bin code: half the sites that use this will never
-- create a single bin, and they still need somewhere to sort a count by.
--
-- ── EVERY SITE STARTS WITH NONE ──────────────────────────────────────────
--
-- No seed and no backfill. A site that never opens the shelves screen has no
-- shelves, therefore no placements, and every screen and query behaves exactly
-- as it did before this file ran — buildSheetLines falls back to its existing
-- ordering, and the product and count screens do not render a bin column at
-- all. This is checked, not hoped for; see the verification notes.
--
-- ── DELETION IS CASCADE, ON PURPOSE ──────────────────────────────────────
--
-- Everything here is a label rather than history, which is what makes CASCADE
-- correct where stock_movements demands RESTRICT. Losing the note that a
-- product used to live in bin 2 costs nothing anybody can audit; losing the
-- movement that says six of them left does.
--
-- The code still clears placements explicitly before deleting a bin — see
-- deleteBin() in stockBins.ts — because a deleted bin should leave the product
-- placed on its SHELF rather than nowhere. The CASCADE below is the backstop
-- for paths that do not go through it, not the intended behaviour.
--
-- DDL auto-commits, so every step here is re-runnable.
--
-- NOTE: no apostrophes in comments anywhere in this file. The runner sends it
-- as one multipleStatements batch, and a lone quote character inside a comment
-- can be read as opening a string literal, swallowing the SQL that follows.
-- 024_laybys.sql fails to apply for exactly this reason.
--
-- 025 and 081 carry this same warning and then spell the character out inside
-- it, which is a trap worth not copying: the rule is easy to keep and the
-- failure it prevents is silent, so this file states it without demonstrating
-- it.
-- ─────────────────────────────────────────────────────────────────────────

-- ── 1. Shelves ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stock_shelves (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,

  location_id INT UNSIGNED NOT NULL,

  -- Short handle a person types, a label prints and a count sheet groups by:
  -- A03, FRONT, COLD2. Same rule and same reasons as a location code.
  code        VARCHAR(24)  NOT NULL,
  name        VARCHAR(120) NOT NULL,
  note        VARCHAR(190) NULL,

  -- Deactivating keeps existing placements pointing here while hiding the
  -- shelf from the pickers, so a bay being re-racked does not silently unplace
  -- everything on it.
  is_active   TINYINT(1)   NOT NULL DEFAULT 1,

  -- THE WALK ORDER, and the reason this column matters more here than it does
  -- on most tables. A count sheet sorts by it, so a site can put its shelves in
  -- the order somebody actually walks them rather than in code order — which is
  -- alphabetical, and no room is.
  sort_order  INT          NOT NULL DEFAULT 0,

  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),

  -- Unique within the ROOM, not the site. Two stock rooms may both have a
  -- shelf called A03 and there is nothing wrong with that; forcing a site-wide
  -- code would make the second room invent names for shelves that already have
  -- ones painted on them.
  UNIQUE KEY uq_shelf_code (location_id, code),

  -- Not redundant with the PK. It is the target of the composite foreign key on
  -- product_placements below, which is what makes it impossible to place a
  -- product on a shelf that lives in a different room. MariaDB will point a
  -- foreign key at any index whose leftmost columns match, and this is that
  -- index.
  UNIQUE KEY uq_shelf_id_location (id, location_id),

  KEY ix_shelf_walk (location_id, sort_order, code),

  CONSTRAINT fk_shelf_location FOREIGN KEY (location_id)
    REFERENCES stock_locations (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 2. Bins ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stock_bins (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,

  shelf_id   INT UNSIGNED NOT NULL,

  -- Unique within the SHELF, so a bin reads as its full address: A03 then 2.
  -- Numbering slots 1, 2, 3 on every shelf is how shelves are actually
  -- labelled, and demanding a room-wide unique code would force A03-2 into a
  -- field that only ever needed to say 2.
  code       VARCHAR(24)  NOT NULL,
  name       VARCHAR(120) NULL,

  is_active  TINYINT(1)   NOT NULL DEFAULT 1,
  sort_order INT          NOT NULL DEFAULT 0,

  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_bin_code (shelf_id, code),

  -- Same trick as uq_shelf_id_location, one level down: the target of the
  -- composite foreign key that stops a placement naming a bin on some other
  -- shelf.
  UNIQUE KEY uq_bin_id_shelf (id, shelf_id),

  KEY ix_bin_walk (shelf_id, sort_order, code),

  CONSTRAINT fk_bin_shelf FOREIGN KEY (shelf_id)
    REFERENCES stock_shelves (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 3. Where a product lives ─────────────────────────────────────────────
--
-- Deliberately its own table rather than two columns on product_location_stock.
-- That table is the PILE — a quantity with a documented invariant over it — and
-- hanging a label off it would blur what it means. More practically: a table
-- can hold a pick face AND a bulk bay for the same product in the same room,
-- and a pair of columns can never grow to that without a migration.
CREATE TABLE IF NOT EXISTS product_placements (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,

  product_id  INT UNSIGNED NOT NULL,

  -- Carried alongside shelf_id rather than derived from it. It is half of the
  -- composite foreign key that keeps the two honest, and it is what every read
  -- filters by — "where is this product in THIS room" should not have to join
  -- through shelves to find out.
  location_id INT UNSIGNED NOT NULL,

  shelf_id    INT UNSIGNED NOT NULL,

  -- NULL means ON THE SHELF, no particular slot. A real and common answer, not
  -- a missing one.
  bin_id      INT UNSIGNED NULL,

  -- Where somebody is sent when they ask where this product is. The count sheet
  -- and the product screen read this one; the others are overflow.
  is_primary  TINYINT(1)   NOT NULL DEFAULT 1,

  note        VARCHAR(190) NULL,

  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  /*
   * ONE PRIMARY PER (PRODUCT, LOCATION), ENFORCED BY THE DATABASE.
   *
   * 025 wanted exactly this rule for is_main and could not have it: a UNIQUE on
   * (is_main) is useless because MariaDB permits any number of NULLs and any
   * number of zeroes, and "unique among rows where is_main = 1" is a partial
   * index, which is Postgres. So setMainLocation() holds that rule in code.
   *
   * Here it does not have to. A generated column that goes NULL on every
   * non-primary row inverts the problem — the unique index then constrains
   * exactly the primary ones, which is the rule we actually want. 016_shifts.sql
   * uses the same idiom for one open shift per till, and its comment makes the
   * argument in full.
   */
  primary_location_id INT UNSIGNED
    GENERATED ALWAYS AS (CASE WHEN is_primary = 1 THEN location_id ELSE NULL END) STORED,

  /*
   * Stands in for bin_id inside the uniqueness rule below.
   *
   * Needed because MySQL treats NULLs in a unique index as distinct from each
   * other, so a bare (product, location, shelf, bin) unique would happily accept
   * the same shelf-only placement twice — the exact duplicate the index exists to
   * refuse, and the commonest one, since a shelf-only placement is the default
   * shape.
   */
  bin_key INT UNSIGNED
    GENERATED ALWAYS AS (COALESCE(bin_id, 0)) STORED,

  PRIMARY KEY (id),

  UNIQUE KEY uq_placement (product_id, location_id, shelf_id, bin_key),
  UNIQUE KEY uq_placement_primary (product_id, primary_location_id),

  -- "What lives on this shelf" and "what lives in this bin" — the put-away and
  -- pick directions, and what deleteShelf and deleteBin count before offering
  -- to remove anything.
  KEY ix_placement_shelf (shelf_id, location_id),
  KEY ix_placement_bin (bin_id, shelf_id),
  -- The count sheet join: every placement in one room, in walk order.
  KEY ix_placement_location (location_id, is_primary),

  -- CASCADE like product_location_stock and unlike stock_movements: a
  -- placement is a current label, not history, so it must never be the thing
  -- that stops a genuinely deletable product from going.
  CONSTRAINT fk_placement_product FOREIGN KEY (product_id)
    REFERENCES products (id) ON DELETE CASCADE,

  -- The composite pair. These are what make it structurally impossible to
  -- place a product on a shelf in another room, or in a bin on another shelf —
  -- the two mistakes a pair of plain single-column keys would wave straight
  -- through, and the two that would put a picker in the wrong building.
  --
  -- A NULL bin_id skips the second check entirely, which is MATCH SIMPLE
  -- semantics doing exactly what the shelf-only case needs.
  CONSTRAINT fk_placement_shelf FOREIGN KEY (shelf_id, location_id)
    REFERENCES stock_shelves (id, location_id) ON DELETE CASCADE,
  CONSTRAINT fk_placement_bin FOREIGN KEY (bin_id, shelf_id)
    REFERENCES stock_bins (id, shelf_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 4. A counted line remembers where it was counted ─────────────────────
--
-- Copied onto the line at sheet creation, exactly as product_code and
-- description already are on the same table, and for the same reason: the room
-- gets re-racked, the product gets moved to another bay, and a sheet printed in
-- March has to keep saying what was actually counted and where.
--
-- Codes rather than ids. A reprint needs the words that were on the sheet, and
-- an id would resolve to wherever the product lives NOW — which is the one
-- thing this must not do.
ALTER TABLE stock_take_lines
  ADD COLUMN IF NOT EXISTS shelf_code VARCHAR(24) NULL AFTER description;

ALTER TABLE stock_take_lines
  ADD COLUMN IF NOT EXISTS bin_code VARCHAR(24) NULL AFTER shelf_code;
