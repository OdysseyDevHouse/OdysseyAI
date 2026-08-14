-- Who signed in to the back office, and who tried.
--
-- A NEW cp2_ table, within the additive contract: v2 owns cp2_users and this
-- never touches it -- user_id is a plain column, no FK, so a v2 user purge
-- cannot fail on rows it does not know about. Failures for unknown emails
-- still record, which is the half of a sign-in log that catches guessing.
CREATE TABLE cp2_signin_log (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    INT UNSIGNED NULL,
  email      VARCHAR(190) NOT NULL,
  -- success | failed | locked | totp_failed
  event      VARCHAR(20)  NOT NULL,
  ip         VARCHAR(45)  NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_signin_user (user_id, created_at),
  KEY ix_signin_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
