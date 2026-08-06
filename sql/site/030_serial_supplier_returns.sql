-- ─────────────────────────────────────────────────────────────────────────
-- Serials sent back to the supplier.
--
-- `returned` has always meant one specific thing: a customer brought the unit
-- back and it is NOT resellable — faulty, sitting on a shelf awaiting a
-- decision. It is still ours, and it is still in the building.
--
-- A unit sent back to the supplier is a different fact. It has physically left,
-- we have been credited for it, and it will never be sold. Folding that into
-- `returned` would make the two indistinguishable, and the first person to ask
-- "what faulty stock am I holding?" would get an answer padded with units that
-- went back months ago.
--
-- Neither status counts toward stock_on_hand, so reconcileSerials is unaffected
-- by the split — this is about being able to answer the question, not about the
-- arithmetic.
--
-- DDL auto-commits, so this is written to be re-runnable.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE product_serials
  MODIFY COLUMN status
    ENUM('in_stock','sold','returned','written_off','returned_to_supplier')
    NOT NULL DEFAULT 'in_stock';

-- ── Which GRV line a return line sends back ──────────────────────────────
--
-- A supplier return may be partial and there may be several against one GRV,
-- so "how much of this line has already gone back" has to be answerable
-- exactly. Matching on product + description the way credit notes do is not
-- good enough here: the same stock code legitimately appears twice on one
-- delivery at two different landed costs, and the two must be told apart.
--
-- NULL on every purchase_order and grv line, which is why it is nullable
-- rather than defaulted.
ALTER TABLE purchase_document_lines
  ADD COLUMN IF NOT EXISTS source_line_id INT UNSIGNED NULL AFTER document_id;

-- Looked up by "everything that returns line N", which is how the remaining
-- returnable quantity is computed.
ALTER TABLE purchase_document_lines
  ADD INDEX IF NOT EXISTS ix_pline_source (source_line_id);
