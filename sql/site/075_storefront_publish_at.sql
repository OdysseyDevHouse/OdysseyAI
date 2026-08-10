-- ─────────────────────────────────────────────────────────────────────────
-- Publish a page at a moment nobody has to be awake for.
--
-- ── WHY THIS IS NOT THE SECTION SCHEDULE ─────────────────────────────────
--
-- 040 gave every SECTION a showFrom/showUntil window, and that answers a
-- different question: "which parts of a live page are in season". The page is
-- already published; the dates decide what shows on it.
--
-- This is the other half. A Black Friday front page is not a section going in
-- and out of season — it is a whole arrangement that must replace the current
-- one at midnight and not a moment before. Doing that with section windows
-- means dating every section individually, twice, and getting all of them
-- right; doing it by hand means somebody being at a computer at midnight.
--
-- ── ONE COLUMN, NOT A QUEUE TABLE ────────────────────────────────────────
--
-- A page has at most one pending publish, because there is only one draft to
-- publish and setting a second time replaces the first. A queue table would
-- model several — which the draft column cannot represent — and would need its
-- own cleanup for the rows the first firing made meaningless.
--
-- NULL means "no publish is scheduled", which is every page today.
-- ─────────────────────────────────────────────────────────────────────────

-- Local wall-clock text, 'YYYY-MM-DDTHH:mm' — NOT a DATETIME.
--
-- The same decision 057 made for specials, for the same reason: a shop that
-- says "go live at midnight" means midnight on ITS OWN clock. Stored as text
-- and compared as text, so no timezone conversion sits between what the owner
-- typed and when it fires. VARCHAR(16) is exactly the format's width.
ALTER TABLE storefront_pages
  ADD COLUMN publish_at VARCHAR(16) NOT NULL DEFAULT '';

-- The one query the tick runs: every page due, across the site. Indexed
-- because it is asked every few minutes and is almost always empty — the
-- cheapest possible answer to "is there anything to do" matters more here than
-- for a query somebody waits on.
CREATE INDEX ix_page_publish_at ON storefront_pages (publish_at);
