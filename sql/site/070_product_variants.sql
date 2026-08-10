-- Product variants: one thing to a shopper, several things to the stockroom.
--
-- ── WHAT THIS IS FOR ─────────────────────────────────────────────────────
--
-- A shirt in three sizes is one product in a catalogue and three products in a
-- stock take. The shopper wants a single tile with a size picker; the buyer
-- wants to know there are two mediums and no larges. Both are right, and the
-- schema has to hold both readings at once.
--
-- ── A VARIANT IS NOT A PRODUCT TYPE ──────────────────────────────────────
--
-- `products.product_type` answers ONE question: how does a sale move stock.
-- That is why it is a single stored value rather than a set of flags — an item
-- cannot both deduct and add quantity on sale (see productTypes.ts).
--
-- "Is this one of several siblings" is a DIFFERENT question, and it is
-- orthogonal to the first. A medium red shirt is a `normal` product that
-- happens to have siblings. Two cuts of meat priced by weight are `calcqty`
-- variants. Bottles in three sizes could be `returnable` variants.
--
-- Making 'variant' a ninth product_type would destroy the column's meaning: a
-- variant would no longer say what it does on sale, and the enum would have to
-- grow variant_normal, variant_returnable, variant_calcqty… So variants live on
-- their own axis, here.
--
-- ── WHY THIS SELF-REFERENCES products RATHER THAN GETTING ITS OWN TABLE ──
--
-- The obvious alternative is a `product_variants` table owning code, price and
-- stock, with `products` demoted to a template. It is cleaner on a whiteboard
-- and considerably worse here:
--
--   27 foreign keys in this schema point at products(id) — sales lines,
--   purchase lines, stock piles, transfers, serials, recipes, loyalty,
--   specials, commission, contracts, laybys, reviews, images, quick keys.
--
-- Moving the sellable facts down a level makes every one of those choose which
-- level it references, and turns sales_document_lines.product_id polymorphic.
-- A mistake there mis-states stock or the GL rather than mis-drawing a screen.
--
-- Self-referencing keeps EVERY EXISTING FOREIGN KEY CORRECT AND UNTOUCHED,
-- because a variant is still an ordinary row in products with its own code,
-- barcode, price and stock. The till, the stockroom and the ledger need to
-- learn nothing. What is new is only that some rows now have a parent.
--
-- The cost of this choice, stated honestly: the parent/child distinction is
-- carried by nullable columns rather than by separate tables, so the database
-- alone cannot stop a parent being sold. That is enforced in one place instead
-- — recordMovement() refuses a movement against a parent, which is the single
-- gate every stock change in the application already passes through.

-- ── The parent/child link ────────────────────────────────────────────────
ALTER TABLE products
  -- NULL for an ordinary standalone product AND for a parent. Set only on a
  -- child. So "is a variant of something" is exactly `parent_id IS NOT NULL`.
  ADD COLUMN parent_id    INT UNSIGNED NULL,

  -- Denormalised on purpose. Every product listing, picker and till search has
  -- to exclude parents, and `has_variants = 0` is an indexable predicate where
  -- `NOT EXISTS (SELECT ...)` is a correlated subquery on the hottest query in
  -- the application.
  --
  -- Maintained by productVariants.ts in the same transaction that adds or
  -- removes a child, never by hand.
  ADD COLUMN has_variants TINYINT(1) NOT NULL DEFAULT 0,

  -- What distinguishes this child from its siblings: 'M', 'Red'. The LABELS
  -- ('Size', 'Colour') live once on the parent in product_variant_axes — held
  -- here they would be repeated on every child and could disagree.
  --
  -- Two axes, not N. A size/colour grid is 20 children; a third axis makes it
  -- hundreds of real stock-bearing rows, which is a warehouse problem rather
  -- than a shop one. A shop needing three is telling us it has two products.
  ADD COLUMN axis_1_value VARCHAR(60) NOT NULL DEFAULT '',
  ADD COLUMN axis_2_value VARCHAR(60) NOT NULL DEFAULT '',

  -- The order the pickers show. Sizes are not alphabetical: S, M, L, XL sorts
  -- to L, M, S, XL, which is nonsense on a shelf edge and worse on a shopfront.
  ADD COLUMN variant_sort INT NOT NULL DEFAULT 0,

  -- Children of one parent, in display order. Also the index that makes
  -- "hide every parent" cheap on the product list.
  ADD KEY ix_product_parent (parent_id, variant_sort),
  ADD KEY ix_product_has_variants (has_variants, is_archived),

  -- RESTRICT, and this is the important one.
  --
  -- CASCADE would delete stock-bearing rows that have sales history hanging off
  -- them the moment someone tidied up a parent. SET NULL would silently strand
  -- the children as standalone products carrying axis values that no longer
  -- refer to anything. Refusing outright is the only option that cannot lose
  -- data: ungroup the children first, deliberately, then delete the parent.
  ADD CONSTRAINT fk_product_parent
    FOREIGN KEY (parent_id) REFERENCES products (id) ON DELETE RESTRICT;

-- ── What the axes are called ─────────────────────────────────────────────
-- One row per axis, on the PARENT. A table rather than two columns on products
-- because a label belongs to the group as a whole, and because this is where a
-- third axis would be added if that decision is ever revisited — without
-- another ALTER on the busiest table in the schema.
CREATE TABLE IF NOT EXISTS product_variant_axes (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- The parent. A child never has a row here.
  product_id INT UNSIGNED NOT NULL,

  -- 1 or 2, matching products.axis_1_value / axis_2_value.
  position   TINYINT UNSIGNED NOT NULL,

  -- 'Size', 'Colour', 'Pack'. The shop's own word.
  label      VARCHAR(60) NOT NULL,

  PRIMARY KEY (id),

  -- One label per position per parent. Without this a group could carry two
  -- competing names for axis 1 and the picker would draw whichever it read
  -- first.
  UNIQUE KEY uq_variant_axis (product_id, position),

  -- CASCADE is right here where it was wrong above: an axis label describes its
  -- parent and has no independent existence. Deleting the parent (which is
  -- already refused while children remain) should take its labels with it.
  CONSTRAINT fk_variant_axis_product
    FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
