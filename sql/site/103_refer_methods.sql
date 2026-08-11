-- ─────────────────────────────────────────────────────────────────────────
-- Refer codes: the second method, and the stock that comes with it.
--
-- 020 built one behaviour and never named it. A refer product carries no pile
-- of its own — stockDirectionFor() returns 0 for it — and selling one explodes
-- the link: sell a six-pack, six singles leave the shelf. All stock lives on
-- the single and every pack is a view onto it.
--
-- That behaviour has a name in the trade, and it is SUBTRACT PACK. It is
-- already built and already correct. What is missing is the other method.
--
-- ── THE TWO METHODS ──────────────────────────────────────────────────────
--
--   subtract   receive 10 cases  -> +240 singles
--              sell 1 single     -> -1 single
--              on hand: 240 singles, and the case is a label
--
--   normal     receive 10 cases  -> +10 cases
--              sell 1 single     -> open a case (-1 case, +4 six-packs)
--                                   open a six-pack (-1 six-pack, +6 singles)
--                                   -1 single
--              on hand: 9 cases, 3 six-packs, 5 singles
--
-- Under normal refers every pack size carries its OWN real stock, and the
-- shop physically breaks the outer when the inner runs out. That is a
-- property of the goods rather than of the store — beer gets broken, a sealed
-- carton of stock cubes does not — so the method belongs on the LINK and not
-- on a site setting.
--
-- It defaults to 'subtract', which is the load-bearing part of this
-- migration: every refer link already in the field keeps behaving exactly as
-- it does today, and nothing changes until somebody picks the other method.
--
-- ── THE CHAIN IS 1:1 UPWARD, EACH FACTOR RELATIVE TO ITS TARGET ──────────
--
--   single <- six-pack (factor 6) <- case (factor 4) <- pallet (factor 20)
--
-- The case's factor is 4 — four six-packs — not 24. The 24 falls out of
-- walking the chain, which is what resolveComponents() already does.
--
-- This is why the shape stays 1:1 on PRIMARY KEY (product_id) rather than
-- becoming a star where every pack points straight at the single. With a
-- star, breaking down to fill a single would have to CHOOSE between opening a
-- six-pack and opening a case, and any choice is a guess. With a chain there
-- is exactly one next size up at every level.
--
-- ── BREAKING A PACK IS A TRANSFER BETWEEN PRODUCTS ───────────────────────
--
-- Structurally this is 083 with pack sizes where 083 has recipes: the outer
-- out, the inner in, one transaction, every write through recordMovement().
-- The pair is balanced, so Sum(qty_change) = stock_on_hand still holds at
-- every level and reconcileStock() needs no change.
--
-- DDL auto-commits, so every statement here is re-runnable by hand.
-- ─────────────────────────────────────────────────────────────────────────

-- ── The method ───────────────────────────────────────────────────────────
-- Only meaningful on a row of product_refers, so it lives there rather than
-- on products: a product is only ever the SOURCE of one link, and the method
-- describes what the link does, not what the product is.
--
-- Changing it on a link whose products already hold stock is refused in
-- saveRefer(), not here — switching a case from normal to subtract would
-- strand the ten cases already counted, and a database constraint cannot
-- explain that to somebody in a form.
ALTER TABLE product_refers
  ADD COLUMN IF NOT EXISTS method ENUM('normal','subtract') NOT NULL DEFAULT 'subtract' AFTER factor;

-- Walking UP the chain — "who refers to me?" — is the hot path of the
-- break-down cascade, and it runs per level per sale line. ix_refer_target
-- already covers target_id; this makes the lookup cover the method too, so
-- the cascade never reads a subtract row it is going to discard.
ALTER TABLE product_refers
  ADD KEY IF NOT EXISTS ix_refer_target_method (target_id, method);

-- ── Two new movement types ───────────────────────────────────────────────
-- Rather than reusing the adjustment type, for the same reason 083 refused
-- to: the one table people actually read to answer "what happened to this
-- product" has to distinguish a case being opened from a stock-take
-- correction. A manager looking at why the case count dropped needs to see
-- that the till opened one, not an adjustment that reads identically to a
-- write-off.
--
-- Appended at the END of the list so the ordinal storage of every existing
-- row is untouched.
--
-- MODIFY with the full value list is naturally re-runnable - stating the
-- target shape rather than a delta.
ALTER TABLE stock_movements
  MODIFY movement_type ENUM('sale','sale_return','opening','receipt','adjustment',
                            'transfer_in','transfer_out',
                            'manufacture_in','manufacture_out',
                            'unpack_in','unpack_out') NOT NULL;
