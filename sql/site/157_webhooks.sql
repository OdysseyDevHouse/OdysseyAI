-- Outbound webhooks -- events this store pushes to other systems.
--
-- The endpoint secret is stored READABLE, unlike the api_keys hash: it must be
-- recoverable to compute the HMAC signature on every delivery. The site
-- database already holds recoverable provider settings (015, 038) on the same
-- reasoning.
CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  url             VARCHAR(500) NOT NULL,
  secret          VARCHAR(64)  NOT NULL,
  -- Comma-joined event names from the closed list in src/lib/site/webhooks.ts.
  events          VARCHAR(500) NOT NULL,
  is_active       TINYINT(1)   NOT NULL DEFAULT 1,
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_success_at DATETIME     NULL,
  last_failure_at DATETIME     NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per event per subscribed endpoint -- the queue AND the log. The
-- payload is frozen at enqueue time so a redelivery sends exactly what the
-- original would have; status rides pending -> delivered, or dead once the
-- retry ladder is exhausted.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  endpoint_id      INT UNSIGNED NOT NULL,
  event            VARCHAR(60)  NOT NULL,
  payload          MEDIUMTEXT   NOT NULL,
  status           ENUM('pending','delivered','dead') NOT NULL DEFAULT 'pending',
  attempts         TINYINT UNSIGNED NOT NULL DEFAULT 0,
  next_attempt_at  DATETIME     NOT NULL,
  last_status_code SMALLINT     NULL,
  last_error       VARCHAR(300) NULL,
  created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  delivered_at     DATETIME     NULL,
  PRIMARY KEY (id),
  KEY ix_deliveries_due (status, next_attempt_at),
  KEY ix_deliveries_endpoint (endpoint_id, id),
  CONSTRAINT fk_deliveries_endpoint FOREIGN KEY (endpoint_id)
    REFERENCES webhook_endpoints (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
