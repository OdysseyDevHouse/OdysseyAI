-- The app's brand blue moved, so the storefront's default moves with it.
--
-- ── WHY ──────────────────────────────────────────────────────────────────
--
-- 040_storefront_layout.sql set brand_colour's DEFAULT to the old blue
-- (#2f6fed). That file has already run on every site, and a migration is
-- recorded by NAME — editing it in place changes nothing on a site that has
-- seen it. So the new default needs its own file.
--
-- Two separate things are fixed here, and they are not the same fix.
--
-- The DEFAULT governs shops created from here on. Without this they would be
-- born wearing the retired blue.
--
-- The UPDATE catches shops that already exist and never chose a colour. Their
-- stored value is the literal old hex — a DEFAULT change does not reach a row
-- that has already been written. It is deliberately scoped to rows still
-- holding exactly the old default: a shop that PICKED #2f6fed for itself is
-- indistinguishable from one that was handed it, and of the two mistakes,
-- silently repainting a shop's chosen brand is the worse one. Anyone who
-- deliberately chose the old blue keeps it and can change it themselves.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE online_store_settings
  ALTER COLUMN brand_colour SET DEFAULT '#1890cd';

UPDATE online_store_settings
   SET brand_colour = '#1890cd'
 WHERE brand_colour = '#2f6fed';
