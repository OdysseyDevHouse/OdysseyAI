-- ─────────────────────────────────────────────────────────────────────────
-- The things a shop is judged on before anybody reads a word of it: how its
-- link looks when shared, the strip above the masthead, and its typeface.
--
-- All three belong to the SHOP rather than to a page, which is why they land
-- on the settings row beside the brand colour rather than on storefront_pages.
-- 040 made that call for the theme and the reasoning is unchanged: a fixed,
-- small set of scalars with defaults, and one shop means one look.
-- ─────────────────────────────────────────────────────────────────────────

-- ── WHAT A SHARED LINK LOOKS LIKE ────────────────────────────────────────
--
-- 070 gave every PAGE its own seo_title / seo_description / seo_image_id. This
-- is the fallback beneath them: what a link shows when a page has said nothing,
-- and what the front page itself uses.
--
-- The image is the gap that actually hurts. layout.tsx sets an OpenGraph block
-- today with no image at all, so a storefront link pasted into WhatsApp — which
-- is how most of these are shared — shows a bare grey card. Every other field
-- here has a sensible fallback already; this one has nothing to fall back to.
ALTER TABLE online_store_settings
  ADD COLUMN share_image_id BIGINT UNSIGNED NULL;

-- BIGINT to match storefront_images.id in 060, and SET NULL for the same
-- reason a page's does: deleting a picture must not delete the shop's
-- settings row. A missing share image falls back to no image, exactly as
-- today.
ALTER TABLE online_store_settings
  ADD CONSTRAINT fk_settings_share_image FOREIGN KEY (share_image_id)
    REFERENCES storefront_images (id) ON DELETE SET NULL;

-- ── WHETHER SEARCH ENGINES MAY INDEX THE SHOP ────────────────────────────
--
-- Default 0, which is what every shop does TODAY: layout.tsx hard-codes
-- `robots: { index: false, follow: false }` with a note calling it an opt-in
-- for later. This is that opt-in, and it defaults off so the migration changes
-- nothing for anybody.
--
-- Worth being a choice rather than simply switched on. A storefront URL carries
-- a signed token; indexing it publishes that token into a search engine, which
-- is fine for a shop that wants foot traffic and not fine for one using the
-- link as a semi-private ordering channel for account customers. Only the shop
-- knows which it is.
ALTER TABLE online_store_settings
  ADD COLUMN allow_indexing TINYINT(1) NOT NULL DEFAULT 0;

-- ── THE STRIP ABOVE THE MASTHEAD ─────────────────────────────────────────
--
-- "Free delivery over R500". Chrome rather than a section, deliberately: it
-- belongs on every page of the shop, and a section lives on one page. Putting
-- it in the layout would mean adding it to each page and remembering to remove
-- it from each when the offer ends.
--
-- Empty text hides it entirely, so this is off for every existing shop.
ALTER TABLE online_store_settings
  ADD COLUMN announce_text VARCHAR(200) NOT NULL DEFAULT '';

-- Optional — the whole strip becomes a link when set. Validated by
-- safeLinkTarget before storage, exactly as a banner's is: this lands in an
-- href on a page that takes payments.
ALTER TABLE online_store_settings
  ADD COLUMN announce_link VARCHAR(300) NOT NULL DEFAULT '';

-- When it runs. Plain 'YYYY-MM-DD' text compared as text, the same shape and
-- the same reasoning as a section's showFrom/showUntil — see storefrontModel.
-- Both ends inclusive; both empty means always.
--
-- Dates matter more here than for a section: an announcement is almost always
-- an offer, and an offer with an end date is the normal case. A strip still
-- promising free delivery a week after the promotion ended is worse than no
-- strip at all.
ALTER TABLE online_store_settings
  ADD COLUMN announce_from VARCHAR(10) NOT NULL DEFAULT '',
  ADD COLUMN announce_until VARCHAR(10) NOT NULL DEFAULT '';

-- ── THE SHOP'S TYPEFACE ──────────────────────────────────────────────────
--
-- A KEY into a curated list, never a font name and never a URL. The renderer
-- maps it to a font loaded by next/font at build time, which self-hosts the
-- files — so no shopper's browser ever makes a request to a third party, and a
-- value written here can never become a network call to somewhere unexpected.
--
-- Storing the name would invite exactly that, and would also let a shop pick
-- something with no bold weight or no Latin subset. The list is short on
-- purpose: every entry has been checked to read well at body size.
--
-- 'system' is the default and is what every shop has today — the OS's own UI
-- font, which loads instantly because it is already there.
ALTER TABLE online_store_settings
  ADD COLUMN font_key VARCHAR(24) NOT NULL DEFAULT 'system';
