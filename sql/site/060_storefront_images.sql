-- Pictures the shop owner puts on the front page.
--
-- ── WHY NOT product_images ──────────────────────────────────────────────
--
-- That table hangs off a product by a CASCADE foreign key, and every read
-- through it is scoped to a product id. A banner belongs to the SHOP, not to
-- anything in the catalogue. Filing it there would mean either inventing a
-- fake product to own it, or making product_id nullable — which quietly
-- removes the constraint that makes the product gallery safe to query.
--
-- ── THE SAME TWO-HALVES DECISION AS 044 ─────────────────────────────────
--
-- Bytes on disk, metadata here. See the header of 044_product_images.sql for
-- why the files are not in a BLOB column; lib/uploads.ts owns the file and
-- lib/site/storefrontImages.ts owns these rows, exactly as it does there.
--
-- ── NOT REFERENCED BY A FOREIGN KEY ─────────────────────────────────────
--
-- A banner section names an image by id, but that reference lives inside the
-- home_layout JSON, which no constraint can reach. So the rows here are
-- deliberately independent: deleting an image leaves a section pointing at an
-- id that resolves to nothing, and the shop renders that section as a plain
-- coloured band rather than a broken picture. The builder says so in words.
--
-- The alternative — refusing to delete an image while some draft still
-- mentions it — would make an owner hunt through twenty sections to find out
-- why they cannot tidy up.

CREATE TABLE IF NOT EXISTS storefront_images (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- The generated opaque name on disk. UNIQUE for the same reason as
  -- product_images: it is the key the serving route resolves.
  stored_name  VARCHAR(190) NOT NULL,
  -- What the owner called it, so the picker shows something recognisable.
  -- Never a path.
  filename     VARCHAR(255) NOT NULL,

  -- From the VERIFIED magic bytes at upload, never the browser's claim.
  mime_type    VARCHAR(40)  NOT NULL,
  size_bytes   BIGINT UNSIGNED NOT NULL DEFAULT 0,

  -- Said instead of seeing it. A banner with no alt text is a blank to a
  -- shopper using a screen reader.
  alt_text     VARCHAR(190) NOT NULL DEFAULT '',

  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_sfimg_stored (stored_name),
  -- The picker lists these newest-first.
  KEY ix_sfimg_created (created_at, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
