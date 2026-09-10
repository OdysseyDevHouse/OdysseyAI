-- The same repair as 237, because the hole it was written for was never closed.
--
-- ── WHY THIS RUNS A SECOND TIME ───────────────────────────────────────────
--
-- 237 healed every dangling refer on file and its note said the edit form had
-- been fixed so no more could be made. It had not been. updateProduct worked
-- out the corrected type into `savedType` and then passed
-- `toProductType(input.productType)` to the UPDATE — the guard computed the
-- right answer and threw it away, so saving a product whose Type dropdown said
-- "Refer" wrote `refer` back every time.
--
-- That made it worse than a gap: the two paths that build a ladder demote a
-- base with nothing under it, and the very next save of that product from the
-- form put the type straight back. A range built through the wizard could be
-- broken by opening the base afterwards and pressing Save.
--
-- The unlink path left the same wreckage from the other end. Removing a rung
-- deleted its link and re-pointed everything above it at the rung below, but
-- left the product typed `refer` with nothing to refer to.
--
-- Both are closed now (products.ts uses savedType; removeReferRung demotes the
-- rung it took out, and createProduct applies the rule the edit path already
-- claimed to). This clears what they made in the meantime.
--
-- Landing on `normal` for the same reason 237 gave: it is what the bottom of a
-- chain always is, and what both build paths already choose for a dangling
-- base. Nothing else is touched — no product changes type unless it BOTH
-- claims to be a refer AND has nothing to refer to.

UPDATE products p
   LEFT JOIN product_refers f ON f.product_id = p.id
   SET p.product_type = 'normal'
 WHERE p.product_type = 'refer'
   AND f.product_id IS NULL;
