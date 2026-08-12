-- Which columns a list screen shows, decided once for the store.
--
-- ── WHY A TABLE AND NOT A SETTING ────────────────────────────────────────
--
-- `settings` is a flat key/value store with VARCHAR(255) values, and its own
-- header says what belongs there: single scalar values a store owner changes
-- and nothing joins to. A column list is nearly that, and it was tempting.
--
-- It does not fit for two reasons. The products list alone offers about
-- twenty-five columns; a fully-expanded set of ids runs past 255 bytes, and
-- MySQL outside strict mode truncates rather than refuses — the failure would
-- be a column list that silently loses its tail. And one key per screen means
-- the SettingKey union grows every time a list gains a picker, which is the
-- "queried in bulk" smell settings.ts warns against.
--
-- So it earns a table, shaped like saved_reports (054): a TEXT blob of JSON,
-- one row per thing, for a structure the database never needs to look inside.
--
-- ── WHY PER STORE AND NOT PER USER ───────────────────────────────────────
--
-- The opposite call to report favourites (054), and deliberately. A favourite
-- is "the four reports I run every morning" — a fact about a person. Which
-- columns belong on the products list is a fact about how the SHOP works: a
-- store that does not use pack weights wants that column gone for everyone,
-- not gone for whoever last hid it.
--
-- The per-device picker (useColumnPrefs, localStorage) stays and sits ON TOP:
-- this row is the store's default, and a person may still tweak their own view
-- for an afternoon. Reset returns them here rather than to a hardcoded set.
--
-- ── WHAT IS STORED ───────────────────────────────────────────────────────
--
-- The VISIBLE ids, not the hidden ones. A column added to the catalogue in a
-- later release is then absent from every stored row and stays hidden until
-- someone asks for it, rather than appearing unannounced on every screen in
-- every store. Storing the hidden set would invert that, and a new column
-- would arrive switched on for everybody.
--
-- Unknown ids are dropped on read (useColumnPrefs already filters against the
-- catalogue), so a column removed from the code needs no migration here.

CREATE TABLE IF NOT EXISTS list_columns (
  -- Which screen. Namespaced like the localStorage keys it shadows —
  -- 'products', 'customers', 'suppliers'. One row per list.
  list_key    VARCHAR(60) NOT NULL,
  -- JSON array of visible column ids, in the order the catalogue declares
  -- them. Order is NOT stored: a list that renders its columns in a different
  -- order per store is a support call nobody can reproduce.
  columns     TEXT        NOT NULL,
  updated_by  INT UNSIGNED NULL,
  updated_at  DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (list_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ── When a product was last counted ──────────────────────────────────────
--
-- Posting a stock take writes last_adjust_date, exactly as a manual adjustment
-- does (stockTakes.ts, stockAdjustments.ts — the same UPDATE statement). So
-- "last counted" and "last adjusted" were the same stamp, and offering both as
-- columns would have shown two headings over one number.
--
-- They answer different questions. "Last adjusted" is when someone corrected
-- the figure; "last stock take" is when the shelf was physically counted, which
-- is what an auditor asks and what tells you a count is overdue.
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS last_stock_take_date DATETIME NULL AFTER last_adjust_date;

-- Backfilled from the counts themselves, so the column is true for history
-- rather than only from today. stock_take_lines.counted_at is stamped when a
-- line is counted; the latest across a posted take is when that product was
-- last seen on a shelf.
UPDATE products p
   SET p.last_stock_take_date = (
     SELECT MAX(l.counted_at)
       FROM stock_take_lines l
       JOIN stock_takes t ON t.id = l.stock_take_id
      WHERE l.product_id = p.id
        AND t.status = 'posted'
        AND l.counted_at IS NOT NULL
   )
 WHERE p.last_stock_take_date IS NULL;
