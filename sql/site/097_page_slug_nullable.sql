-- storefront_pages.slug becomes nullable, reversing the call made in
-- 070_storefront_pages.sql.
--
-- RECONSTRUCTED 2026-08-11. Recorded as applied in ody10000_master on
-- 2026-08-10 with no committed file. The live column is `varchar(60) NULL
-- DEFAULT NULL`, and the one product page on that database carries slug NULL.
--
-- ── WHY THE ORIGINAL REASONING DID NOT SURVIVE CONTACT ───────────────────
--
-- 070 argued that NOT NULL DEFAULT '' was the safer choice, because MySQL
-- permits any number of NULLs in a unique index and nullable slugs would let
-- duplicates through. That is true, and it is the wrong trade here.
--
-- Only `home` and `standard` pages have a URL of their own. A `department` or
-- `product` page is reached through the department or the product, and has no
-- slug to give. Under NOT NULL DEFAULT they all hold the empty string - and
-- uq_page_slug then permits exactly ONE of them in the entire store. The second
-- department layout a shop tried to create failed on a duplicate key with
-- nothing to explain it.
--
-- Nullable is the correct shape: NULL means "this page has no URL", which is a
-- fact about department and product pages rather than an accident. The
-- duplicate-slug protection 070 wanted still holds for every page that HAS a
-- slug, which is the only place it was ever needed.
ALTER TABLE storefront_pages
  MODIFY COLUMN slug VARCHAR(60) NULL DEFAULT NULL;

-- Carry across the rows written before the change. Scoped to the two kinds that
-- have no URL: a home or standard page sitting on an empty slug is broken for a
-- different reason, and quietly turning it into NULL would hide that.
UPDATE storefront_pages
   SET slug = NULL
 WHERE slug = ''
   AND kind IN ('department', 'product');
