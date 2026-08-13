-- ============================================================================
-- 135 — Per-customer pricing: a structure override and a standing discount
--
-- WHY
--
-- customer_groups has carried price_structure_id since 012, and NOTHING ever
-- resolved it into a price — the till used the site default, the storefront
-- used the store settings, and the group's setting was a label. This
-- migration adds the customer-level half, and the code that ships with it
-- wires the WHOLE resolution: customer → group → site default, in every
-- pricing path.
--
-- price_structure_id: SET NULL like group_id — deleting a structure returns
-- its accounts to group/site resolution, it must not delete customers.
--
-- discount_pct: the account's standing discount, applied as the DEFAULT line
-- discount wherever the customer is attached. NULL means none, distinct from
-- an explicit 0 ("no discount, and somebody decided that"). DECIMAL(6,3)
-- matches sales_document_lines.discount_pct — the column it flows into, so
-- the two can never disagree on precision.
--
-- The applied discount is CAPPED at the product's max_discount_pct at
-- application time: checkPricing refuses a line above the ceiling for actors
-- without sales.discount_override, and an uncapped account discount would
-- brick a cashier's till from a back-office setting.
-- ============================================================================

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS price_structure_id INT UNSIGNED NULL AFTER group_id,
  ADD COLUMN IF NOT EXISTS discount_pct DECIMAL(6,3) NULL AFTER credit_limit;

ALTER TABLE customers
  ADD FOREIGN KEY IF NOT EXISTS fk_customer_price_structure (price_structure_id)
    REFERENCES price_structures (id) ON DELETE SET NULL;
