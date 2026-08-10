-- ─────────────────────────────────────────────────────────────────────────
-- The front page's old home, finally emptied.
--
-- 040 put `home_layout` and `home_layout_draft` on the settings row. 070 copied
-- them into `storefront_pages` and stopped reading them, but deliberately did
-- NOT drop them:
--
--   "A migration file is recorded by NAME once applied, so editing this file
--    afterwards does nothing on any site that already ran it — which means a
--    mistaken DROP is unrecoverable on exactly the sites that already have
--    data. Keeping the columns costs two unread TEXT fields and buys a way
--    back. A later migration drops them once this path has run in anger."
--
-- This is that later migration. The new path has since carried four more
-- migrations' worth of work — pages, subscribers, version history, scheduled
-- publishing, presentation and product pages — and nothing has read the old
-- columns in any of it. `grep home_layout src/` finds two comments and no code.
--
-- ── WHY DROPPING IS NOW THE SAFER OPTION ─────────────────────────────────
--
-- Leaving them is not free forever. They are two TEXT columns holding a stale
-- copy of a page, on the row every storefront request reads; and a stale copy
-- of live data is a trap for the next person, who will reasonably assume a
-- column named `home_layout` is where the home layout lives. That is a worse
-- failure than the one keeping them protected against, and the protection has
-- served its purpose.
--
-- IF NOT EXISTS on both, so a site provisioned after 070 — which never had
-- them, because 040 ran against a schema that no longer creates them — is not
-- an error.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE online_store_settings
  DROP COLUMN IF EXISTS home_layout,
  DROP COLUMN IF EXISTS home_layout_draft;
