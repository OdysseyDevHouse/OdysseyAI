ALTER TABLE storefront_pages
  MODIFY COLUMN slug VARCHAR(60) NULL DEFAULT NULL;

UPDATE storefront_pages
   SET slug = NULL
 WHERE slug = ''
   AND kind IN ('department', 'product');

