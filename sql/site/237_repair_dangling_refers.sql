-- A refer product with no link under it is unsellable — repair the ones on file.
--
-- ── WHAT WAS BROKEN ───────────────────────────────────────────────────────
--
-- resolveComponents() refuses a product typed `refer` that has no row in
-- product_refers: "This refer product has no linked product set up yet." That
-- refusal is right — selling such a product would take stock off a pile it
-- does not have — but the state should never have existed to be refused.
--
-- It is worse than one dead product. Every pack size on the ladder resolves
-- THROUGH the rung below it, so a mistyped base makes the six-pack and the
-- case unsellable too, and the till names the pack the cashier scanned rather
-- than the base that is actually wrong. A three-rung ladder went down because
-- of one column on a product nobody had touched that day.
--
-- ── WHERE IT CAME FROM ────────────────────────────────────────────────────
--
-- The two paths that BUILD a ladder — createReferRange and addReferRung — both
-- write the link in the same transaction as the type, and both already demote
-- a base that has nothing under it. The gap was the product edit form, where
-- Type is an ordinary dropdown: choosing "Refer" saved the type with no link
-- to go with it. products.ts now resolves that case back to `normal` on save,
-- so this migration is a one-off repair rather than a recurring sweep.
--
-- ── WHY `normal` IS THE RIGHT LANDING ─────────────────────────────────────
--
-- `normal` is what the bottom of a chain always is: a stocked product holding
-- its own pile, which is exactly what the packs above it draw on. It is also
-- what both build paths already choose for a dangling base, so this repair
-- agrees with the code rather than inventing a third answer.
--
-- Nothing else is touched. The links, factors and methods of correctly built
-- ladders are untouched, and no product changes type unless it BOTH claims to
-- be a refer AND has nothing to refer to.

UPDATE products p
   LEFT JOIN product_refers f ON f.product_id = p.id
   SET p.product_type = 'normal'
 WHERE p.product_type = 'refer'
   AND f.product_id IS NULL;
