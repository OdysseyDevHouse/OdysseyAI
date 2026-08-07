-- Storefront display choices.
--
-- Whether to publish stock levels is a judgement only the shop owner can make,
-- and it cuts both ways. "Only 3 left" converts — it tells a shopper to decide
-- now. It also tells a competitor exactly what the shop is holding, and it is
-- only ever as accurate as the last stock take, so a shop with drifting counts
-- would rather say nothing than say a number it cannot stand behind.
--
-- Defaults are chosen so an existing shop's front page does not change the
-- moment this migration runs: stock stays hidden, photographs stay shown.

ALTER TABLE online_store_settings
  ADD COLUMN show_stock TINYINT(1) NOT NULL DEFAULT 0 AFTER reviews_enabled,
  ADD COLUMN show_photos TINYINT(1) NOT NULL DEFAULT 1 AFTER show_stock,
  ADD COLUMN show_brands TINYINT(1) NOT NULL DEFAULT 1 AFTER show_photos;
