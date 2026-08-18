-- ─────────────────────────────────────────────────────────────────────────
-- How a listing looks: columns, what a tile shows, which facets, the order.
--
-- A department page had one knob — grid or list, shop-wide — and everything
-- else was hard-coded. The tile always drew nine things: the department chip,
-- the save-% badge, the stock badge, the brand, the title, the variant count,
-- the stars, the price and the Add button. On a phone that tile is 160px wide.
-- A butchery and a boutique want different subsets of those nine and there was
-- no way to say so.
--
-- ── ONE DEFAULT ROW, AND OVERRIDES ONLY WHERE ASKED FOR ──────────────────
--
-- `department_id IS NULL` is the shop's answer, and it is the row almost every
-- shop will ever have. A department row exists ONLY where somebody deliberately
-- overrode it, so the admin screen can say "following the shop default" until
-- they do.
--
-- Per-department-only was the alternative and it is worse in both directions: a
-- shop with forty departments will not configure forty rows, and forty rows that
-- drifted apart is a shop that looks assembled from parts rather than designed.
-- The cascade is the same shape `departmentPageFor` already uses.
--
-- ── WHY COLUMNS AND NOT JSON, WHEN 183 WENT THE OTHER WAY ────────────────
--
-- 183 argued for JSON because the theme is a document: read whole, written
-- whole, never filtered. This is the opposite. There is a ROW PER DEPARTMENT,
-- looked up by department_id on every listing request, and the set gets listed
-- and counted by the admin screen. That is a table, and the fields are a fixed
-- handful of scalars with a natural default each.
--
-- ── card_fields AND facets ARE CSV, DELIBERATELY ─────────────────────────
--
-- Both are a small SET drawn from a fixed vocabulary, and nothing queries
-- inside them — they are read whole with the row and handed to a renderer. A
-- join table for "which of nine flags is on" would be nine rows to answer one
-- question. The vocabulary lives in the model and anything not in it is dropped
-- on read, so a stale value from an older build degrades to "not shown" rather
-- than reaching a page.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS online_listing_presets (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  -- NULL is the shop's default. UNIQUE so a department cannot end up with two
  -- answers, and so the default row cannot be duplicated.
  department_id   INT UNSIGNED NULL,
  columns_desktop TINYINT UNSIGNED NOT NULL DEFAULT 4,
  columns_phone   TINYINT UNSIGNED NOT NULL DEFAULT 2,
  per_page        SMALLINT UNSIGNED NOT NULL DEFAULT 24,
  default_sort    VARCHAR(16) NOT NULL DEFAULT 'name',
  layout          VARCHAR(8) NOT NULL DEFAULT 'grid',
  -- CSV over a fixed vocabulary — see above.
  card_fields     VARCHAR(160) NOT NULL DEFAULT 'department,saving,stock,brand,variants,rating,price,add',
  facets          VARCHAR(60) NOT NULL DEFAULT 'brand,price',
  updated_at      DATETIME NULL,
  updated_by      VARCHAR(120) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_listing_department (department_id),
  CONSTRAINT fk_listing_department FOREIGN KEY (department_id)
    REFERENCES departments (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────────────────────────
-- A badge an owner puts on a product by hand.
--
-- The rule badges — "added in the last N days", "top N sellers", "stock is
-- low" — are computed and live on the shop's default preset row. This is the
-- other half: "Halaal", "Made here", "Award winner". No rule infers those, and
-- there is nowhere else on a product to say them.
--
-- A tone rather than a colour, so a badge cannot fight the shop's palette and
-- follows a theme change. The vocabulary is the kit's own Badge tones.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS online_badge VARCHAR(24) NULL,
  ADD COLUMN IF NOT EXISTS online_badge_tone VARCHAR(12) NULL;
