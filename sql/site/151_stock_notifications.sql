-- Notify-me-when-back requests from the storefront.
--
-- One live request per address per product; a re-request after notification
-- resets notified_at through the upsert in code rather than a second row.
CREATE TABLE IF NOT EXISTS stock_notifications (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  product_id  INT UNSIGNED NOT NULL,
  email       VARCHAR(190) NOT NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  notified_at DATETIME     NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_stocknotify (product_id, email),
  KEY ix_stocknotify_pending (notified_at, product_id),
  CONSTRAINT fk_stocknotify_product FOREIGN KEY (product_id)
    REFERENCES products (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
