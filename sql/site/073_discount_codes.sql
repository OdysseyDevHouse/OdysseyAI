-- Discount codes: SAVE10 at checkout, and the ledger proving who spent it.
--
-- ── WHY THIS IS NOT A SPECIAL ────────────────────────────────────────────
--
-- Specials (056) answer "this product is cheaper right now" — they change a
-- shelf price for everybody who looks at it, and the storefront already quotes
-- the reduced figure. A discount code answers a different question: "this
-- SHOPPER may pay less, if they know the word." Nobody sees it on a tile, it
-- applies to a basket rather than to a product, and it can be exhausted.
--
-- Folding it into `specials` would mean a specials row that must not appear in
-- the specials row on the shop front, has a redemption count, and belongs to
-- one customer — three exceptions to what a special is.
--
-- ── A REDEMPTION IS A ROW, NOT A COLUMN ──────────────────────────────────
--
-- Same reasoning as loyalty: `uses_count` on the code alone would say a code
-- was used forty times and nothing else. `discount_code_uses` is what answers
-- "did that campaign bring in new customers or discount the regulars", what
-- enforces a per-customer limit, and what a dispute is settled from.
--
-- The counter stays as well, deliberately — it is what the concurrency guard
-- locks and compares, and counting rows under a lock on every checkout is the
-- expensive way to ask a question the counter already answers.

CREATE TABLE IF NOT EXISTS discount_codes (
  id                  INT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- What the shopper types. Stored UPPERCASE and compared uppercase, because
  -- nobody types a promo code the way it was printed.
  code                VARCHAR(40)  NOT NULL,

  -- The shop's own note about the campaign. Never shown to a shopper.
  description         VARCHAR(190) NOT NULL DEFAULT '',

  --   percent        — a share of the goods total
  --   amount         — a flat sum off
  --   free_delivery  — the delivery fee is waived, goods untouched
  kind                ENUM('percent','amount','free_delivery') NOT NULL DEFAULT 'percent',

  -- Percent for 'percent' (0–100), money for 'amount', ignored for
  -- 'free_delivery'. One column rather than two nullable ones: the kind says
  -- how to read it, and two columns would allow a row that sets neither.
  value               DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  -- 0 means no minimum.
  min_order_incl      DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  -- NULL at either end means open-ended. Both are wall-clock in the shop's own
  -- timezone, matching how specials already read (057).
  starts_at           DATETIME     NULL,
  ends_at             DATETIME     NULL,

  -- NULL means unlimited. The counter below is compared against it under a
  -- row lock, which is what stops a last-use code being spent twice.
  max_uses            INT UNSIGNED NULL,
  uses_count          INT UNSIGNED NOT NULL DEFAULT 0,

  -- NULL means unlimited per shopper. Enforced by counting `discount_code_uses`
  -- for that customer or email, because a per-customer limit cannot be a
  -- single counter.
  max_uses_per_customer INT UNSIGNED NULL,

  -- "New customers only". Checked against whether this contact has ever had an
  -- online order accepted, not against whether they have an account — a guest
  -- who ordered last week is not a new customer.
  first_order_only    TINYINT(1)   NOT NULL DEFAULT 0,

  -- Restricts the discount to goods in one department (and its children).
  -- NULL applies it to the whole basket.
  department_id       INT UNSIGNED NULL,

  -- Whether this may reduce a product that is ALREADY on special.
  --
  -- Default OFF, and that is the safe direction: a 20% code on top of a 30%
  -- special is a 44% discount nobody signed off, and the shop finds out at
  -- month end. A shop that wants stacking has to say so.
  combines_with_specials TINYINT(1) NOT NULL DEFAULT 0,

  -- Retires a code without deleting it, so the uses below stay readable.
  is_active           TINYINT(1)   NOT NULL DEFAULT 1,

  created_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  updated_by          VARCHAR(120) NOT NULL DEFAULT '',

  PRIMARY KEY (id),
  -- One code, one meaning. Two rows spelling SAVE10 would make the discount
  -- depend on which the query read first.
  UNIQUE KEY uq_discount_code (code),
  KEY ix_discount_active (is_active, starts_at, ends_at),
  -- RESTRICT would strand a code pointing at a department that no longer
  -- exists; SET NULL turns it into a whole-basket code, which is the safe
  -- reading — it can still be withdrawn by hand.
  CONSTRAINT fk_discount_department
    FOREIGN KEY (department_id) REFERENCES departments (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── The ledger ───────────────────────────────────────────────────────────
-- One row per redemption. Written in the SAME transaction as the order, so a
-- code cannot be counted without an order to show for it.
CREATE TABLE IF NOT EXISTS discount_code_uses (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  code_id         INT UNSIGNED NOT NULL,

  -- The order it was spent on. CASCADE: an order deleted in testing takes its
  -- redemption with it, and a use with no order is not evidence of anything.
  order_id        INT UNSIGNED NOT NULL,

  -- Who spent it. Both are recorded: `customer_id` for a signed-in shopper,
  -- and the email for everyone else — a per-customer limit has to work for
  -- guests, who are most of them.
  customer_id     INT UNSIGNED NULL,
  contact_email   VARCHAR(190) NOT NULL DEFAULT '',

  -- What it actually took off, in money. Not recomputable later: the code's
  -- percentage may change, and this is what the shop gave away that day.
  amount_incl     DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  used_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  -- The per-customer limit's query, both ways round.
  KEY ix_use_by_customer (code_id, customer_id),
  KEY ix_use_by_email (code_id, contact_email),
  -- One redemption per order. Belt and braces alongside the single
  -- discount_code_id column on the order itself.
  UNIQUE KEY uq_use_per_order (order_id),
  CONSTRAINT fk_use_code
    FOREIGN KEY (code_id) REFERENCES discount_codes (id) ON DELETE CASCADE,
  CONSTRAINT fk_use_order
    FOREIGN KEY (order_id) REFERENCES online_orders (id) ON DELETE CASCADE,
  CONSTRAINT fk_use_customer
    FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── What the order remembers ─────────────────────────────────────────────
-- The order stores the discount as MONEY, not as a reference to be re-read.
-- Same reasoning as `total_incl` and the order lines: this is a record of what
-- was agreed, and editing the code afterwards must not restate a placed order.
ALTER TABLE online_orders
  -- SET NULL rather than RESTRICT: deleting a spent code is allowed, and the
  -- order keeps the amount it was actually given.
  ADD COLUMN IF NOT EXISTS discount_code_id    INT UNSIGNED NULL,
  -- What the shopper typed, kept even if the code row is later deleted, so a
  -- staff member reading the order can still see WHY it was cheaper.
  ADD COLUMN IF NOT EXISTS discount_code       VARCHAR(40)  NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS discount_incl       DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  ADD KEY IF NOT EXISTS ix_online_order_discount (discount_code_id);

-- Separate statement: MariaDB has no IF NOT EXISTS for a named constraint, so
-- this is the one clause that cannot be made re-runnable inline. Dropped first
-- so re-applying after a partial failure is safe.
ALTER TABLE online_orders DROP FOREIGN KEY IF EXISTS fk_online_order_discount;
ALTER TABLE online_orders
  ADD CONSTRAINT fk_online_order_discount
    FOREIGN KEY (discount_code_id) REFERENCES discount_codes (id) ON DELETE SET NULL;

-- ── Attribution on the sale ──────────────────────────────────────────────
-- Alongside `special_id` (056) rather than reusing it: a line may be reduced by
-- a special AND carry a code, and one column cannot record both. Without this
-- "what did that campaign cost us" is unanswerable from the sales data.
ALTER TABLE sales_document_lines
  ADD COLUMN IF NOT EXISTS discount_code_id INT UNSIGNED NULL AFTER special_id,
  ADD KEY IF NOT EXISTS ix_sales_lines_discount_code (discount_code_id);

ALTER TABLE sales_document_lines DROP FOREIGN KEY IF EXISTS fk_sales_line_discount_code;
ALTER TABLE sales_document_lines
  ADD CONSTRAINT fk_sales_line_discount_code
    FOREIGN KEY (discount_code_id) REFERENCES discount_codes (id) ON DELETE SET NULL;
