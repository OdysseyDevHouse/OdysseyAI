-- ─────────────────────────────────────────────────────────────────────────
-- What the storefront LOOKS like, and what is on its front page.
--
-- ── THE DRAFT IS THE POINT ───────────────────────────────────────────────
--
-- Two layout columns, not one. `home_layout` is what shoppers see;
-- `home_layout_draft` is what the owner is busy rearranging. Editing writes
-- only to the draft, and Publish copies it across.
--
-- Without that separation, every keystroke in the builder is live on the
-- public shop: an owner tidying up over a lunch break would have shoppers
-- watching the furniture slide about, and a half-finished page would be the
-- one someone lands on from a WhatsApp link.
--
-- ── WHY THE LAYOUT IS JSON ───────────────────────────────────────────────
--
-- A page is an ORDERED list of heterogeneous sections — a banner, then some
-- categories, then two product rows with different rules. Modelling that
-- relationally means a table per kind plus a join table for order, and every
-- new kind becomes a migration. Nothing queries INSIDE the layout; it is read
-- whole, rendered whole, and written whole. That is exactly what a document
-- column is for.
--
-- The cost is that the database cannot validate it, so the application must:
-- see `normaliseSections` in lib/site/storefrontLayout.ts, which is applied on
-- WRITE as well as on read. A draft arrives from a browser and is untrusted.
--
-- ── THEME IS COLUMNS, NOT JSON ───────────────────────────────────────────
--
-- The opposite call, for the opposite reason: these are a fixed, small set of
-- scalars with defaults, and a store's brand colour is exactly the kind of
-- thing someone will want to report on or bulk-update later.
-- ─────────────────────────────────────────────────────────────────────────

-- The shop's own colour. Everything else on the storefront stays on the app's
-- design tokens: a store picks its accent, not a whole stylesheet, so a
-- badly-chosen palette can never make the shop unreadable.
ALTER TABLE online_store_settings
  ADD COLUMN brand_colour VARCHAR(9) NOT NULL DEFAULT '#2f6fed';

-- 'grid' | 'list'. How products are laid out in a listing.
ALTER TABLE online_store_settings
  ADD COLUMN product_layout VARCHAR(10) NOT NULL DEFAULT 'grid';

-- The line at the top of the front page. Empty renders no hero at all, which
-- is the right default for a shop that has not written one.
ALTER TABLE online_store_settings
  ADD COLUMN hero_headline VARCHAR(120) NOT NULL DEFAULT '';

ALTER TABLE online_store_settings
  ADD COLUMN hero_subtext VARCHAR(300) NOT NULL DEFAULT '';

-- The footer's own words: opening hours, a line about the shop.
ALTER TABLE online_store_settings
  ADD COLUMN footer_about VARCHAR(600) NOT NULL DEFAULT '';

ALTER TABLE online_store_settings
  ADD COLUMN footer_hours VARCHAR(400) NOT NULL DEFAULT '';

-- Where customers already follow the shop. Rendered as links when set.
ALTER TABLE online_store_settings
  ADD COLUMN social_facebook VARCHAR(200) NOT NULL DEFAULT '';

ALTER TABLE online_store_settings
  ADD COLUMN social_instagram VARCHAR(200) NOT NULL DEFAULT '';

ALTER TABLE online_store_settings
  ADD COLUMN social_whatsapp VARCHAR(30) NOT NULL DEFAULT '';

-- The published front page. NULL means "no layout has ever been published",
-- which the reader turns into the starter page — distinct from an empty array,
-- which means an owner has deliberately removed every section.
ALTER TABLE online_store_settings
  ADD COLUMN home_layout TEXT NULL;

-- Work in progress. NULL means there is nothing unpublished.
ALTER TABLE online_store_settings
  ADD COLUMN home_layout_draft TEXT NULL;
