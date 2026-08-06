-- ─────────────────────────────────────────────────────────────────────────
-- Product photographs.
--
-- ── WHY A TABLE AND NOT products.image_path ──────────────────────────────
--
-- That column exists (001_products.sql) and stays: it is the ONE picture the
-- till shows on a button, where a second image would have nowhere to go.
--
-- A storefront is different. A shopper wants to see the front of the box, the
-- back with the ingredients, and the thing out of its packaging — and the
-- order they appear in is a merchandising decision, not an accident of upload
-- time. One column cannot hold that, and a comma-separated list in one column
-- cannot be reordered, counted or safely deleted from.
--
-- So: many rows per product, explicitly ordered, with one marked primary.
--
-- ── ONE PRIMARY, ENFORCED WHERE IT CAN BE ────────────────────────────────
--
-- `is_primary` decides which image represents the product in a grid, a search
-- result and the till button. A product with two primaries would render
-- differently depending on row order, which is the kind of bug that is
-- invisible until a customer mentions it.
--
-- MySQL cannot express "at most one true per product" as a constraint, so the
-- application owns it: setPrimaryImage clears the others in the same
-- transaction. The index below at least makes finding the primary a lookup
-- rather than a scan.
--
-- ── THE BYTES ARE ON DISK ────────────────────────────────────────────────
--
-- Same decision as party_documents, for the same reasons — see the header of
-- 031. This table holds metadata; lib/uploads.ts owns the file.
--
-- The difference is that these are served INLINE on a public page, so
-- storeImageUpload verifies the actual bytes are a real image before writing
-- one, and the serving route sends the type derived from those bytes. An
-- extension check alone would let an HTML file with a .png name execute on our
-- own origin.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS product_images (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  product_id   INT UNSIGNED NOT NULL,

  -- The generated opaque name on disk. UNIQUE because it is the key the
  -- serving routes resolve, and because two uploads of front.jpg must not
  -- collide.
  stored_name  VARCHAR(190) NOT NULL,
  -- What the user called it. Shown while managing images; never a path.
  filename     VARCHAR(255) NOT NULL,

  -- Derived from the VERIFIED magic bytes at upload, not from the browser's
  -- claim. This is what the serving route sends as Content-Type, so it must
  -- never be attacker-influenced.
  mime_type    VARCHAR(40)  NOT NULL,
  size_bytes   BIGINT UNSIGNED NOT NULL DEFAULT 0,

  -- Shown to a screen reader and when the image fails to load. A product photo
  -- with no alt text is invisible to a shopper using one.
  alt_text     VARCHAR(190) NOT NULL DEFAULT '',

  -- The merchandising order. Lower first.
  sort_order   INT          NOT NULL DEFAULT 0,
  -- The one that represents the product. See the note above.
  is_primary   TINYINT(1)   NOT NULL DEFAULT 0,

  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_pimg_stored (stored_name),
  -- The gallery: one product's images, in order.
  KEY ix_pimg_product (product_id, sort_order, id),
  -- "The picture for this product", which every product grid asks per row.
  KEY ix_pimg_primary (product_id, is_primary),
  -- CASCADE: a product that is genuinely deleted takes its images with it.
  -- (Products are normally archived, which leaves them intact.) The FILES are
  -- removed by deleteProduct in application code — a foreign key cannot unlink
  -- anything from disk.
  CONSTRAINT fk_pimg_product FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
