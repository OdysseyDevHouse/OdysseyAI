-- ─────────────────────────────────────────────────────────────────────────
-- A page with no URL stores NULL, not the empty string.
--
-- ── THE BUG THIS FIXES ───────────────────────────────────────────────────
--
-- `uq_page_slug` is UNIQUE on `slug`, and 070 made the column NOT NULL DEFAULT
-- '' so that two standard pages could never both claim /page/delivery. Sound
-- for pages that HAVE a URL. But 'department' and 'product' rows have none, and
-- they were storing '' — which the unique key reads as a URL like any other.
--
-- So the second department page a shop tried to create failed with
-- "Duplicate entry '' for key 'uq_page_slug'". A shop could have exactly ONE
-- department page in total, which is the opposite of the per-department
-- customisation the kind exists for. It went unnoticed because the shops that
-- had a department page only ever had one.
--
-- ── WHY NULL IS RIGHT RATHER THAN A WORKAROUND ───────────────────────────
--
-- MySQL permits any number of NULLs in a unique index. 070 called that out and
-- avoided NULL precisely because it wanted '' constrained — but that reasoning
-- applies to rows that are addressed by a slug. A department page is addressed
-- by its department id; a product page is not addressed at all. For those, "no
-- URL" is genuinely the absence of a value, and the repeated-NULL behaviour is
-- what makes many of them legal while two /page/delivery rows stay illegal.
--
-- It is the same mechanism `uq_page_department` already leans on for standard
-- pages, so the table now uses one idea consistently instead of two.
--
-- Existing rows are converted in place. Nothing reads '' as meaningful: the
-- lookups filter on kind first (publishedPageBySlug is kind='standard'), and
-- safeSlug('') is falsy either way.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE storefront_pages
  MODIFY COLUMN slug VARCHAR(60) NULL DEFAULT NULL;

UPDATE storefront_pages
   SET slug = NULL
 WHERE slug = '' AND kind IN ('department', 'product');
