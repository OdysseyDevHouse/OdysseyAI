-- Drops products.order_size.
--
-- Added in 006 and removed before it was ever used, so no data is lost. This is
-- a separate migration rather than an edit to 006: that file has already been
-- applied and recorded in schema_migrations, so changing it would only affect
-- stores that have not migrated yet and leave the two out of step.
--
-- IF EXISTS so a store that never received 006 — or one where this has already
-- run by hand — is not a failure.
ALTER TABLE products
  DROP COLUMN IF EXISTS order_size;
