-- The shop's logo.
--
-- ── WHY IT IS A THEME COLUMN AND NOT A SECTION ──────────────────────────
--
-- The masthead is on every page of the shop, not just the front one. A logo
-- filed in home_layout would be a home-page block, so it would disappear the
-- moment a shopper opened a product — which is precisely when a shop most
-- wants its name on the screen.
--
-- ── WHY NO FOREIGN KEY TO storefront_images ─────────────────────────────
--
-- Deliberately none, matching the banner sections in 060. An owner tidying up
-- their picture library must not be blocked by a constraint, and must not have
-- to hunt for which screen is still using a photograph. Deleting the picture a
-- logo points at leaves an id that resolves to nothing, and the masthead falls
-- back to the shop's name in text — the same thing every shop without a logo
-- already shows.
--
-- NULL is the default and means exactly that: show the name. Every existing
-- shop therefore looks identical the moment this runs.

ALTER TABLE online_store_settings
  ADD COLUMN logo_image_id BIGINT UNSIGNED NULL DEFAULT NULL AFTER product_layout;
