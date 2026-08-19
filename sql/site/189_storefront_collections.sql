-- ─────────────────────────────────────────────────────────────────────────
-- Collections: a shop's own way of grouping what it sells.
--
-- A merchant could not say what a group of products IS, other than which aisle
-- it lives in. Departments are the inventory tree — shared with the till, the
-- stockroom and every report — and "Gifts under R300", "Summer" and "New this
-- week" are none of those things. They cut across aisles, they come and go,
-- and putting them in the department tree would corrupt the one structure the
-- rest of the business counts on.
--
-- ── MANUAL AND RULE-BASED, BECAUSE BOTH ARE REAL ─────────────────────────
--
-- A summer lookbook is hand-picked and must stay hand-picked: it is a set of
-- decisions somebody made, and a rule that "maintains" it would be undoing
-- them. "On special" is the opposite — hand-picking it means re-picking it
-- every time a special starts or ends, which is how a shop ends up advertising
-- last month's prices. `storefrontModel` already makes this exact argument for
-- PRODUCT_SOURCES, and the vocabulary here is deliberately the same one so a
-- merchant learns the idea once.
--
-- ── A SLUG, UNLIKE A DEPARTMENT ──────────────────────────────────────────
--
-- Departments are reached by id because they are an internal tree that happens
-- to be browsable. A collection is a marketing surface whose whole purpose is
-- to be shared — in a message, on a poster, in a post — so it gets a readable
-- address. `/k/summer` rather than `/c/47`.
--
-- 'k' and not 'collection' because the path is typed and read aloud, and it
-- sits beside the existing 'c' and 'p'. The letter is reserved in
-- RESERVED_SLUGS so a standard page cannot claim it.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS storefront_collections (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  slug         VARCHAR(60) NOT NULL,
  title        VARCHAR(120) NOT NULL DEFAULT '',
  -- Shown under the heading. A sentence, not a page — a collection that needs
  -- paragraphs wants a built page above its grid, which is what kind
  -- 'collection' on storefront_pages is for.
  description  VARCHAR(300) NOT NULL DEFAULT '',
  image_id     BIGINT UNSIGNED NULL,
  is_published TINYINT(1) NOT NULL DEFAULT 0,
  sort_order   INT NOT NULL DEFAULT 0,
  /*
   * How the collection is filled.
   *
   * 'manual' reads storefront_collection_products; every other rule resolves
   * against the catalogue at render time and ignores that table. The vocabulary
   * mirrors PRODUCT_SOURCES so the two are learned once.
   */
  rule_kind    VARCHAR(16) NOT NULL DEFAULT 'manual',
  -- What the rule needs: a brand name, or a department id. Unused by 'manual',
  -- 'special' and 'newest', which need nothing.
  rule_value   VARCHAR(120) NOT NULL DEFAULT '',
  -- SEO, the same three fields storefront_pages carries.
  seo_title       VARCHAR(120) NOT NULL DEFAULT '',
  seo_description VARCHAR(300) NOT NULL DEFAULT '',
  updated_at   DATETIME NULL,
  updated_by   VARCHAR(120) NULL,
  PRIMARY KEY (id),
  -- A collection's address is its identity, so two cannot share one.
  UNIQUE KEY uq_collection_slug (slug),
  KEY ix_collection_published (is_published, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────────────────────────
-- What a MANUAL collection holds, in the order somebody chose.
--
-- `sort_order` and not the product's own name: the order IS the decision. A
-- lookbook opens on the piece the shop wants seen first, and sorting it
-- alphabetically would throw that away.
--
-- Rows go when the product does. A collection quietly holding a deleted product
-- would be a grid that renders one tile short with nothing to explain it.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS storefront_collection_products (
  collection_id INT UNSIGNED NOT NULL,
  product_id    INT UNSIGNED NOT NULL,
  sort_order    INT NOT NULL DEFAULT 0,
  PRIMARY KEY (collection_id, product_id),
  KEY ix_collection_products_order (collection_id, sort_order),
  CONSTRAINT fk_collection_products_collection FOREIGN KEY (collection_id)
    REFERENCES storefront_collections (id) ON DELETE CASCADE,
  CONSTRAINT fk_collection_products_product FOREIGN KEY (product_id)
    REFERENCES products (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────────────────────────
-- A collection can have a built page above its grid.
--
-- The same mechanism a department page uses: sections render above the product
-- list, so a lookbook is a picture-beside-words block over a row of the things
-- in it. That combination is why no "lookbook" or "shop the look" section kind
-- is needed — the blocks already shipped, and this gives them somewhere to go.
--
-- `uq_page_department` already covers (kind, department_id); the new kind uses
-- department_id to hold its collection id, which would be wrong. So it gets its
-- own column and its own uniqueness.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE storefront_pages
  ADD COLUMN IF NOT EXISTS collection_id INT UNSIGNED NULL,
  ADD CONSTRAINT fk_page_collection FOREIGN KEY IF NOT EXISTS (collection_id)
    REFERENCES storefront_collections (id) ON DELETE CASCADE;

-- One page per collection, and the kind is part of the key for the same reason
-- uq_page_department includes it.
ALTER TABLE storefront_pages
  ADD UNIQUE KEY IF NOT EXISTS uq_page_collection (kind, collection_id);

-- 'collection' joins the kinds a page may be.
ALTER TABLE storefront_pages
  MODIFY COLUMN kind ENUM('home','standard','department','product','collection')
    NOT NULL DEFAULT 'standard';
