-- Self-service password reset for customer logins.
--
-- The raw token goes only into the email; the table holds its SHA-256, so a
-- database read cannot impersonate the link holder. Single-use, one hour.
CREATE TABLE IF NOT EXISTS customer_password_resets (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  login_id    INT UNSIGNED NOT NULL,
  token_hash  CHAR(64)     NOT NULL,
  expires_at  DATETIME     NOT NULL,
  used_at     DATETIME     NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_reset_token (token_hash),
  KEY ix_reset_login (login_id),
  CONSTRAINT fk_reset_login FOREIGN KEY (login_id)
    REFERENCES customer_logins (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
