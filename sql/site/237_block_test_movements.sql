-- ─────────────────────────────────────────────────────────────────────────
-- The two movement types a block test writes.
--
-- `stock_movements.movement_type` is an ENUM, so a type the column has never
-- heard of is not a soft failure: MariaDB refuses the INSERT and the whole
-- posting transaction rolls back. The TypeScript union in stockMovements.ts and
-- this enum are one contract in two places, and adding to only one of them
-- makes a feature that typechecks perfectly and cannot write a single row.
--
-- Why its own pair rather than reusing 'adjustment' or 'manufacture_out':
--
--   · Against 'adjustment' — the one table people read to answer "what
--     happened to this product" has to distinguish a carcass being broken down
--     from a stock-take correction. That is the same reason manufacturing and
--     unpacking each took their own pair.
--
--   · Against 'manufacture_*' — the direction is INVERTED. Manufacturing is
--     many inputs to one output; a block test is one input to twenty outputs at
--     twenty different values. A yield report that could not tell them apart
--     would average a hindquarter against a sausage recipe.
--
-- Ordered at the END of the enum deliberately. MariaDB stores an ENUM as its
-- ordinal position, so inserting a value in the middle silently renumbers every
-- row after it — every historic 'unpack_out' would read as something else.
ALTER TABLE stock_movements
  MODIFY COLUMN movement_type ENUM(
    'sale',
    'sale_return',
    'opening',
    'receipt',
    'adjustment',
    'transfer_in',
    'transfer_out',
    'manufacture_in',
    'manufacture_out',
    'unpack_in',
    'unpack_out',
    'block_test_in',
    'block_test_out'
  ) NOT NULL;
