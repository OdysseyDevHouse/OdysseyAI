-- Replaces the free-text `dimensions` column with three numeric ones.
--
-- 008 added a single VARCHAR on the grounds that these figures are only ever
-- read by a person. That holds right up until something needs to CALCULATE with
-- them — volumetric shipping rates, courier integrations, shelf-space planning —
-- at which point free text has to be parsed, and "60cm" / "600 x 500" / "700mm
-- high" are all things people reasonably type.
--
-- Millimetres throughout, with no unit column: a single fixed unit is what
-- makes the figures comparable across products without conversion, and the UI
-- labels the fields so nobody has to guess. DECIMAL(10,2) carries fractions of
-- a millimetre and sizes far beyond anything that fits in a store.
--
-- Dropped rather than migrated: 008 shipped in the same session and no product
-- has a value in it, so there is nothing to preserve.
ALTER TABLE products
  DROP COLUMN IF EXISTS dimensions,
  ADD COLUMN length_mm DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER pack_description,
  ADD COLUMN width_mm  DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER length_mm,
  ADD COLUMN height_mm DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER width_mm;
