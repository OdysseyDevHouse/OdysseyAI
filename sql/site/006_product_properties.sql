-- Product properties: how a product behaves at the till, on the scale, and in
-- the stockroom.
--
-- These live on `products` rather than in a side table because every one of
-- them is a fact about the product itself, read on the same row the till
-- already loads. A join per sale to discover "is this a scale item" would be
-- paid on every transaction for no benefit.
--
-- Every column is NOT NULL with a default, so existing products acquire
-- ordinary behaviour rather than NULLs the UI would have to special-case.
-- `visible_in_pos` defaults to 1: a product on file is sold unless someone says
-- otherwise, and defaulting to 0 would hide the entire existing catalogue.
ALTER TABLE products
  -- ── Properties ────────────────────────────────────────────────────────
  ADD COLUMN visible_in_pos      TINYINT(1)    NOT NULL DEFAULT 1,
  ADD COLUMN change_description  TINYINT(1)    NOT NULL DEFAULT 0,
  ADD COLUMN ask_price_at_sale   TINYINT(1)    NOT NULL DEFAULT 0,
  ADD COLUMN allow_fractions     TINYINT(1)    NOT NULL DEFAULT 0,
  ADD COLUMN charge_pct_subtotal TINYINT(1)    NOT NULL DEFAULT 0,
  ADD COLUMN non_gp_product      TINYINT(1)    NOT NULL DEFAULT 0,
  -- A percentage ceiling, not an amount: 0 means no discount is allowed.
  ADD COLUMN max_discount_pct    DECIMAL(6,3)  NOT NULL DEFAULT 0.000,
  -- What a variable barcode encodes for this product. 'none' when it has none.
  ADD COLUMN variable_type       VARCHAR(16)   NOT NULL DEFAULT 'none',
  -- Which figure survives a cost change: 'selling' holds the shelf price and
  -- lets margin move; 'markup' holds margin and moves the shelf price.
  ADD COLUMN price_calc          VARCHAR(16)   NOT NULL DEFAULT 'selling',

  -- ── Weight and size ───────────────────────────────────────────────────
  -- DECIMAL(12,4) matches the money columns: a pack weight divided down to a
  -- unit weight needs the same room to avoid rounding drift.
  ADD COLUMN pack_weight         DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  ADD COLUMN weight_description  VARCHAR(24)   NOT NULL DEFAULT 'Kg',
  ADD COLUMN pack_size           DECIMAL(12,3) NOT NULL DEFAULT 0.000,
  ADD COLUMN pack_description    VARCHAR(24)   NOT NULL DEFAULT 'None',
  ADD COLUMN order_size          DECIMAL(12,3) NOT NULL DEFAULT 0.000,
  ADD COLUMN prep_time_minutes   INT           NOT NULL DEFAULT 0,

  -- ── Scale properties ──────────────────────────────────────────────────
  ADD COLUMN scale_item          TINYINT(1)    NOT NULL DEFAULT 0,
  ADD COLUMN label_scale_item    TINYINT(1)    NOT NULL DEFAULT 0,
  ADD COLUMN fixed_price_scale   TINYINT(1)    NOT NULL DEFAULT 0,
  ADD COLUMN expires_in_days     INT           NOT NULL DEFAULT 0;
