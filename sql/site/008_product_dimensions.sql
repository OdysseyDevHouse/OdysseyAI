-- Product dimensions, as free text.
--
-- One VARCHAR rather than separate length/width/height numerics: this field is
-- written and read by people ("600mm long, 500 wide, 700 high") and is not used
-- in any calculation. Storing it as typed keeps entry natural and avoids
-- forcing a unit the user did not mean.
--
-- Worth knowing if that ever changes: free text cannot be sorted, compared or
-- multiplied, so shelf planning, volumetric shipping rates or a courier
-- integration would need three numeric columns and a parse of whatever has
-- accumulated here by then.
ALTER TABLE products
  ADD COLUMN dimensions VARCHAR(190) NOT NULL DEFAULT '' AFTER pack_description;
