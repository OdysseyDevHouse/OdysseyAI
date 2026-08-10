-- Being findable, and knowing whether any of it worked.
--
-- ── TWO THINGS, ONE MIGRATION ────────────────────────────────────────────
--
-- They arrive together because they answer the same question from two ends: a
-- shop that opts into search traffic immediately wants to know whether the
-- traffic bought anything, and a funnel with no way to grow the top of it is a
-- report about the same twelve people.
--
-- ── `allow_indexing` IS NOT HERE — 077 ADDED IT ──────────────────────────
--
-- The opt-in switch this file originally declared already exists: 077 put
-- `allow_indexing` on this same table, wired to the layout's robots field.
-- Declaring it again would be a second switch for one decision, so this
-- migration builds on that column rather than competing with it and adds only
-- what indexing still needs to be worth having — an address to be canonical to,
-- and a way to tell whether any of it worked.

ALTER TABLE online_store_settings
  -- The shop's public address, e.g. "shop.example.co.za".
  --
  -- Needed because the storefront lives behind an opaque signed token
  -- (publicStoreToken.ts) that is deliberately not a readable URL. A canonical
  -- link and a sitemap both have to name ONE address, and only the shop knows
  -- which domain actually points here.
  --
  -- Empty falls back to APP_URL. Indexing still works; the canonical simply
  -- names the platform host rather than the shop's own.
  ADD COLUMN IF NOT EXISTS public_domain VARCHAR(190) NOT NULL DEFAULT '';

-- ── The funnel ───────────────────────────────────────────────────────────
--
-- FIRST-PARTY, deliberately. No third-party pixel, no cookie shared with an
-- advertising network, nothing leaving this database — so there is no consent
-- banner to add and nothing to disclose beyond what the shop already knows
-- about its own orders.
--
-- ── ONE ROW PER EVENT, NOT A SET OF COUNTERS ─────────────────────────────
--
-- Counters answer "how many add-to-carts last month" and nothing else. Rows
-- answer the question a shop actually has — "of the people who saw this
-- product, how many bought it" — because a funnel is a ratio between stages
-- and the stages have to be linkable by session.
--
-- ── IT STORES NO PERSON ──────────────────────────────────────────────────
--
-- `session_key` is a random id minted in the browser and kept for a session. It
-- is not a customer id, not an email, not an IP address and not a fingerprint.
-- Its only job is to join a view to a purchase; two visits by the same person
-- on different days are two different shoppers as far as this table knows, and
-- that is a deliberate limitation rather than an oversight.
CREATE TABLE IF NOT EXISTS storefront_events (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

  --   view            — a product page was looked at
  --   add_to_cart     — something went into a basket
  --   begin_checkout  — the checkout screen was reached
  --   purchase        — an order was placed
  --
  -- Ordered by how far down the funnel they are, which is also the order the
  -- report reads them in.
  kind         ENUM('view','add_to_cart','begin_checkout','purchase') NOT NULL,

  -- Which product, when the event is about one. NULL for begin_checkout and
  -- purchase, which are about a basket rather than an item.
  --
  -- SET NULL rather than CASCADE: a product deleted next year must not erase
  -- last quarter's funnel, or the numbers change retrospectively.
  product_id   INT UNSIGNED NULL,

  -- The random browser session id. See the note above.
  session_key  CHAR(32)     NOT NULL,

  -- What the basket was worth, for purchase events. Lets the report say what
  -- the funnel earned rather than only how many people fell through it.
  value_incl   DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),

  -- The report's query: events of one kind over a date range.
  KEY ix_event_kind_date (kind, created_at),
  -- Joining a session's stages together, which is what makes it a funnel
  -- rather than four unrelated counts.
  KEY ix_event_session (session_key, kind),
  -- "How does this product convert" — the per-product view the product list
  -- will eventually want.
  KEY ix_event_product (product_id, kind, created_at),

  CONSTRAINT fk_event_product
    FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
