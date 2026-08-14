-- In-app notifications -- targeted, stateful events for the bell in the top bar.
--
-- One row per EVENT, not per recipient: a shop has tens of users (041), and who
-- may see a row is a capability question answered at read time from the same
-- CapabilitySet every request already resolves. Fanning out per user would go
-- stale the day a role changes. Read state is per person in its own table.
--
-- Not the audit trail. activity_log records what people did; this records what
-- somebody should HEAR about, and it can be dismissed. A future email digest
-- reads this same table, resolving audience against roles at send time.
CREATE TABLE IF NOT EXISTS notifications (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  -- Machine-readable kind: online_order_placed, sale_voided, grv_received,
  -- low_stock. New producers add values in code, not here.
  event      VARCHAR(40)  NOT NULL,
  -- Who may see it: a capability key from the role_permissions vocabulary, or
  -- NULL for every back-office user. Owners see everything regardless.
  audience   VARCHAR(60)  NULL,
  -- Narrows a row to one person and wins over audience. No v1 producer sets
  -- it; it exists so a direct-to-person producer needs no migration.
  user_id    INT UNSIGNED NULL,
  title      VARCHAR(160) NOT NULL,
  body       VARCHAR(400) NULL,
  -- Where clicking it lands, an app-relative path.
  href       VARCHAR(190) NULL,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_notifications_created (created_at, id),
  CONSTRAINT fk_notifications_user FOREIGN KEY (user_id)
    REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Who has seen what. A missing row means unread; mark-all-read inserts rows
-- rather than updating the event, so one reader never clears another.
CREATE TABLE IF NOT EXISTS notification_reads (
  notification_id INT UNSIGNED NOT NULL,
  user_id         INT UNSIGNED NOT NULL,
  read_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (notification_id, user_id),
  CONSTRAINT fk_notifreads_event FOREIGN KEY (notification_id)
    REFERENCES notifications (id) ON DELETE CASCADE,
  CONSTRAINT fk_notifreads_user FOREIGN KEY (user_id)
    REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
