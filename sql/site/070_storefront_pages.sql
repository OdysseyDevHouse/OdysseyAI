-- ─────────────────────────────────────────────────────────────────────────
-- The storefront's pages — more than one of them.
--
-- ── WHAT THIS REPLACES ───────────────────────────────────────────────────
--
-- 040 put the front page on the settings row: `home_layout` for what shoppers
-- see and `home_layout_draft` for what the owner is rearranging. That was
-- exactly right for ONE page and cannot express two. A shop taking payments
-- currently has nowhere at all to publish a refund policy.
--
-- ── THE LAYOUT STAYS A DOCUMENT; THE SET OF PAGES BECOMES A TABLE ────────
--
-- 040's argument for JSON holds unchanged and is worth restating: a page is an
-- ORDERED list of heterogeneous sections, nothing queries INSIDE it, and it is
-- read whole, rendered whole and written whole. That is what a document column
-- is for, and modelling it relationally would mean a migration per section kind.
--
-- The set of PAGES is the opposite. It gets ordered for the nav, filtered by
-- `show_in_nav`, looked up by slug on every public request, and joined to a
-- department. That is a table, and pretending otherwise would mean parsing a
-- JSON array of pages to answer "which page is /page/delivery".
--
-- So: one row per page, each carrying its own published layout and its own
-- draft. Draft and publish become per-page, which is the point — an owner
-- rewriting the About page must not be blocked from publishing a fixed price
-- on the front page.
--
-- ── THE OLD COLUMNS ARE LEFT IN PLACE ────────────────────────────────────
--
-- `home_layout` and `home_layout_draft` are COPIED here and then stopped being
-- read. They are deliberately not dropped in this migration.
--
-- A migration file is recorded by NAME once applied, so editing this file
-- afterwards does nothing on any site that already ran it — which means a
-- mistaken DROP is unrecoverable on exactly the sites that already have data.
-- Keeping the columns costs two unread TEXT fields and buys a way back. A
-- later migration drops them once this path has run in anger.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE storefront_pages (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- ── WHAT KIND OF PAGE THIS IS ──────────────────────────────────────────
  --
  -- Three kinds, one table, for the same reason quick keys are one table: they
  -- differ in what they are ATTACHED to, not in what they are. All three hold
  -- an ordered list of sections and all three have a draft.
  --
  --   home       — exactly one, and it cannot be deleted or renamed. What 040
  --                built. Enforced by uq_page_home below.
  --   standard   — About, Delivery, Returns, FAQ. Reached at /page/<slug>.
  --   department — an OPTIONAL layout shown above one department's products.
  --                Absent means that department renders exactly as it does
  --                today, which is what every existing site gets.
  kind          ENUM('home','standard','department') NOT NULL DEFAULT 'standard',

  -- ── THE SLUG ───────────────────────────────────────────────────────────
  --
  -- The URL, and therefore the thing a shop puts on a poster. Unique across
  -- the site: two pages answering to /page/delivery is not a conflict anyone
  -- could debug from the outside.
  --
  -- Set for 'home' ('home', reserved) and 'standard'. Empty for 'department',
  -- which is addressed by its department id — see the note on that column.
  -- Empty string rather than NULL so the unique key below actually constrains
  -- it: MySQL permits any number of NULLs in a unique index, so nullable slugs
  -- would silently allow duplicates for exactly the rows we care about.
  slug          VARCHAR(60)  NOT NULL DEFAULT '',

  -- What the page is called: the heading, and the nav label when it is shown.
  title         VARCHAR(120) NOT NULL DEFAULT '',

  -- ── THE DEPARTMENT THIS DECORATES ──────────────────────────────────────
  --
  -- Only for kind='department'. A real FK, and ON DELETE CASCADE deliberately:
  -- a layout for a department that no longer exists is unreachable by any
  -- route, so keeping it would be keeping a row nobody can ever see or delete
  -- from the UI. This is the opposite call to fk_dept_parent's RESTRICT in
  -- 001, and for the opposite reason — that protects products, this is
  -- decoration.
  department_id INT UNSIGNED NULL,

  -- ── THE PAGE ITSELF ────────────────────────────────────────────────────
  --
  -- Same two-column split as 040, and for the same reason: editing must never
  -- move the public shop. NULL layout means "never published", which the
  -- reader turns into the starter page for home and into nothing for the
  -- others — distinct from an empty array, which means the owner deliberately
  -- removed every section.
  layout        TEXT NULL,
  layout_draft  TEXT NULL,

  -- ── WHETHER ANYBODY CAN REACH IT ───────────────────────────────────────
  --
  -- Separate from having a published layout, because they are different
  -- questions. A page can be fully written and deliberately not live yet —
  -- a Christmas returns policy, say — and unpublishing must not throw the
  -- layout away. The public route 404s on is_published = 0, identically to a
  -- slug that never existed, so an unpublished page cannot be probed for.
  is_published  TINYINT(1)   NOT NULL DEFAULT 0,

  -- Whether it appears in the shop's own navigation, and where. A page can be
  -- published but off the nav — a policy linked only from the footer or from
  -- checkout is the normal case, not an edge one.
  show_in_nav   TINYINT(1)   NOT NULL DEFAULT 0,
  nav_order     INT          NOT NULL DEFAULT 0,

  -- ── WHAT A SHARED LINK LOOKS LIKE ──────────────────────────────────────
  --
  -- Columns now, UI later — they belong to the page, and adding them in the
  -- same breath as the table costs nothing while a second ALTER later costs
  -- another migration on every site.
  --
  -- Empty means "fall back to the shop's own name and blurb", which is what
  -- layout.tsx already does for the whole storefront today. The image is an id
  -- into storefront_images, exactly as a banner's is — never a path, because a
  -- stored path is a URL nobody validates.
  seo_title       VARCHAR(120) NOT NULL DEFAULT '',
  seo_description VARCHAR(300) NOT NULL DEFAULT '',
  -- BIGINT, matching storefront_images.id in 060 — an FK between mismatched
  -- integer widths is rejected outright, and the error MySQL gives for it
  -- ("errno 150") says nothing about which column is wrong.
  seo_image_id    BIGINT UNSIGNED NULL,

  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),

  -- One page per URL. See the slug column on why this is NOT NULL DEFAULT ''.
  UNIQUE KEY uq_page_slug (slug),

  -- ── EXACTLY ONE HOME PAGE, AND ONE LAYOUT PER DEPARTMENT ───────────────
  --
  -- Both enforced by the database rather than by the code that inserts, because
  -- "there is one front page" is an invariant the reader depends on: getLayout
  -- for the home page does a lookup expecting a single row, and a second one
  -- would make which page a shopper lands on a matter of insertion order.
  --
  -- kind is in the key so 'standard' rows — which have NULL department_id and
  -- are not 'home' — are unconstrained by it. MySQL permits repeated NULLs in
  -- a unique index, which is usually a nuisance and is exactly what is wanted
  -- here: many standard pages, at most one department page each.
  UNIQUE KEY uq_page_department (kind, department_id),

  KEY ix_page_nav (show_in_nav, nav_order),

  CONSTRAINT fk_page_department FOREIGN KEY (department_id)
    REFERENCES departments (id) ON DELETE CASCADE,

  -- SET NULL, not CASCADE: deleting a picture from the library must not delete
  -- the page that shared it. This matches how a banner treats a deleted image
  -- — see the header of lib/site/storefrontImages.ts, "a deleted image is not
  -- an error" — and the reader falls back to the shop's own details.
  CONSTRAINT fk_page_seo_image FOREIGN KEY (seo_image_id)
    REFERENCES storefront_images (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────────────────────────────────────────────────────────────────
-- Carry the existing front page across.
--
-- Every site already has exactly one online_store_settings row (id = 1), so
-- this makes exactly one 'home' page carrying whatever that shop has already
-- published and whatever draft it had open at the moment of the migration.
--
-- A shop that never touched the builder has NULL in both columns and gets a
-- home row with NULL layout — which the reader turns into the starter page,
-- exactly as `getLayout` does today. The behaviour is unchanged either way,
-- which is the point: this migration must be invisible to every existing shop.
--
-- is_published = 1 because the front page is reachable whether or not it has
-- ever been built; the shop's own open/closed flag is what gates it, and that
-- has not moved.
-- ─────────────────────────────────────────────────────────────────────────
INSERT INTO storefront_pages (kind, slug, title, layout, layout_draft, is_published, show_in_nav, nav_order)
SELECT 'home', 'home', 'Front page', home_layout, home_layout_draft, 1, 0, 0
  FROM online_store_settings
 WHERE id = 1;
