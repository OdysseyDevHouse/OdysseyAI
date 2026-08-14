-- API keys -- what lets an outside program read this store over /api/v1.
--
-- Hash-only storage, the password-reset doctrine: the raw key is shown once at
-- creation and never again, and the row keeps only its SHA-256. The prefix is
-- the lookup handle -- the first characters of the raw key, unique per site --
-- so verification is one indexed read plus one constant-time compare.
--
-- Scopes are a comma-joined list validated in code against a closed set; the
-- vocabulary lives in src/lib/site/apiKeys.ts, not here, so adding a scope is
-- a code change rather than a migration.
CREATE TABLE IF NOT EXISTS api_keys (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name         VARCHAR(80)  NOT NULL,
  key_prefix   VARCHAR(16)  NOT NULL,
  token_hash   CHAR(64)     NOT NULL,
  scopes       VARCHAR(255) NOT NULL,
  created_by   VARCHAR(120) NOT NULL DEFAULT '',
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at DATETIME     NULL,
  revoked_at   DATETIME     NULL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_api_keys_prefix (key_prefix)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
