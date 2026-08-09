-- ============================================================================
-- Pictures on a department: one for the till, one for the shop.
--
-- ── WHY TWO COLUMNS AND NOT ONE ─────────────────────────────────────────
--
-- They are different pictures for different jobs, and a shop that used one for
-- both would get one of them wrong. The till icon is looked at for a fraction
-- of a second by someone who already knows what the department is — it wants a
-- clear symbol at 40px, cropped square, readable across a counter. The shop
-- picture is a shop window: a photograph of the actual produce, wide, and
-- chosen to make somebody click it.
--
-- Sharing a column would force the owner to pick which of those two to be bad
-- at. Two columns costs two nullable BIGINTs.
--
-- ── WHY THEY POINT AT storefront_images ─────────────────────────────────
--
-- That table already owns "a picture this shop uploaded": the magic-byte
-- verification on the way in, the serving routes with their sandbox CSP, the
-- picker UI, and the library cap. A second uploads table would duplicate every
-- one of those, and the second copy is the one that would miss a check.
--
-- It also means the two features share a library, so a department picture can
-- be reused as a banner and vice versa — which is what an owner expects of
-- something called "your pictures".
--
-- ── WHY NO FOREIGN KEY ──────────────────────────────────────────────────
--
-- The same reasoning as 061_storefront_logo.sql: a picture may be deleted
-- while a department still names it, and that is not an error — every reader
-- resolves a missing id to null and falls back to the department's colour and
-- initial. A FK with ON DELETE SET NULL would work, but storefront_images is
-- already written to on the assumption that nothing references it, and the
-- readers must handle a dangling id regardless (the row can vanish between the
-- read and the render). One rule, enforced in one place, rather than two that
-- can disagree.
-- ============================================================================

ALTER TABLE departments
  ADD COLUMN pos_image_id    BIGINT UNSIGNED NULL DEFAULT NULL,
  ADD COLUMN online_image_id BIGINT UNSIGNED NULL DEFAULT NULL;

-- ── Showing them on the shop ────────────────────────────────────────────
-- Off by default, and deliberately so: a shop that upgrades into this feature
-- has no department pictures yet, and switching it on for them would turn
-- every tile into a colour-and-letter placeholder overnight. The owner turns
-- it on once the pictures are in.
ALTER TABLE online_store_settings
  ADD COLUMN show_department_images TINYINT(1) NOT NULL DEFAULT 0;
