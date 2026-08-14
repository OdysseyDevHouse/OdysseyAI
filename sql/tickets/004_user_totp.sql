-- Two-factor secrets for back-office sign-ins.
--
-- A NEW cp2_ table rather than columns on cp2_users, which v2 owns and this
-- codebase may not ALTER. Deliberately no FK for the same reason. The secret
-- is stored in the enc:v1 envelope (lib/crypto/secrets), so a database read
-- alone cannot mint codes; confirmed_at NULL means provisioned but not yet
-- proven, and enforcement only starts once it is set -- a half-finished
-- enrolment must never lock its owner out.
CREATE TABLE cp2_user_totp (
  user_id        INT UNSIGNED NOT NULL,
  secret_enc     VARCHAR(255) NOT NULL,
  confirmed_at   DATETIME NULL,
  -- The replay guard: a code is single-use, arbitrated by a conditional
  -- UPDATE on this column rather than a racing SELECT.
  last_used_step BIGINT UNSIGNED NOT NULL DEFAULT 0,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
