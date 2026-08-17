-- ============================================================================
-- 012_reporting_replicas.sql — the read-only copy of a local shop's data
-- ============================================================================
--
-- A site with a LOCAL backend keeps its trading data on the shop's own machine.
-- That is the point, and it is also the problem: head-office reporting has
-- nothing to read, and support cannot see a customer's figures without asking
-- somebody to read them down the telephone.
--
-- So each local site streams its binary log to a replica on our side. This
-- table is where those replicas are recorded.
--
-- ── WHY NOT A ROW IN cp2_site_databases ─────────────────────────────────────
--
-- That table already supports several databases per site through its `purpose`
-- column, and adding purpose = 'reporting' would have been three lines. It was
-- rejected deliberately.
--
-- Everything that reads cp2_site_databases does so to WRITE as well as read:
-- sitePool() is the connection the till posts sales through, the migration
-- runner applies schema with, and every server action mutates. A replica must
-- never be written to — it is a copy, and a write to it would either be lost
-- at the next replication event or, worse, silently diverge the two.
--
-- Keeping it in a separate table means there is no path by which an existing
-- caller can reach a replica by accident. A future `siteQuery(id, sql)` cannot
-- resolve to one, because sitePool() does not look here. The separation is the
-- safety property, and one shared table with a flag would have relied on every
-- caller remembering to check the flag.
--
-- ── WHAT IS NOT REPLICATED ──────────────────────────────────────────────────
--
-- Credentials and device-bound state: offline_signin, user_offline_verifiers,
-- users.pin_hash, api_keys, webhook_endpoints.secret, tender_integrations,
-- payment_gateways, licence_lease, document_sequences and the offline_*_claims
-- ledgers. Filtered at the REPLICA with replicate-ignore-table rather than at
-- the shop, because the shop's own binary log must stay complete — it is also
-- what a point-in-time restore replays.

CREATE TABLE IF NOT EXISTS cp2_reporting_replicas (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  site_id INT NOT NULL,

  -- ── Where the replica lives, on OUR infrastructure ───────────────────────
  --
  -- Deliberately the same shape as cp2_site_databases so support reads it the
  -- same way, without the two ever being reachable by the same code.
  server_host VARCHAR(190) NOT NULL,
  server_port INT UNSIGNED NOT NULL DEFAULT 3306,
  database_name VARCHAR(190) NOT NULL,

  -- The account the APP reads reports with. SELECT only — a replica that the
  -- app could write to is a replica that can silently disagree with the shop.
  db_username VARCHAR(190) NULL,
  db_password_enc TEXT NULL,

  -- ── The shop end of the link ─────────────────────────────────────────────
  --
  -- Which machine is the master. A site could in principle run two local
  -- machines; each would need its own replica, so this is not unique on site.
  device_serial VARCHAR(190) NULL,

  -- ── Health, which is the whole operational story ─────────────────────────
  --
  -- Replication either keeps up or it does not, and the difference between
  -- "two seconds behind" and "stopped on Tuesday" is the difference between a
  -- usable report and a misleading one. Recorded rather than computed on
  -- demand so a stalled replica is visible without connecting to it.
  status VARCHAR(32) NOT NULL DEFAULT 'pending',

  -- Seconds behind the shop, from the replica's own view of the log. NULL when
  -- replication is not running at all, which is a DIFFERENT state from zero.
  seconds_behind INT NULL,

  -- The last time the tunnel carried anything. A shop that is closed overnight
  -- is legitimately silent, so this is context for a human rather than a
  -- threshold for an alert.
  last_contact_at DATETIME NULL,

  -- The last error replication reported, verbatim. Kept because the useful
  -- ones are specific ("Could not find first log file name in binary log
  -- index file") and a summarised version would lose exactly the detail that
  -- identifies the remedy.
  last_error TEXT NULL,

  -- Where the replica has read up to. Enough to restart it without a fresh
  -- dump, which for a shop on ADSL is the difference between minutes and a
  -- day.
  binlog_file VARCHAR(190) NULL,
  binlog_position BIGINT UNSIGNED NULL,

  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_cp2_reporting_replicas_site_device (site_id, device_serial),
  KEY ix_cp2_reporting_replicas_site (site_id),
  -- Finding the stalled ones is the query support runs most.
  KEY ix_cp2_reporting_replicas_status (status, seconds_behind)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
