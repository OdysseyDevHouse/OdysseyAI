-- Append-only record of what PEOPLE did.
--
-- This is NOT the ledger. When the sub-ledger arrives, customer_transactions
-- will record what MONEY did — an invoice raised, a payment received — and the
-- two answer different questions. "What is this account's balance made of?" is
-- the ledger. "Who put this account on hold, and when?" is here. A screen that
-- shows one where the other belongs is the mistake this split exists to
-- prevent, which is why the customer screen has separate Transactions and
-- Activity tabs.
--
-- Rows are never updated or deleted. An audit trail that can be edited is not
-- one, and the cost of keeping every row is trivial next to being unable to
-- answer "who changed this".

CREATE TABLE activity_log (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- What was acted on. Deliberately loose text + id rather than a foreign key
  -- per entity type: a log line must survive the record it describes being
  -- deleted, and it must be writable for any table without a schema change.
  entity      VARCHAR(40)  NOT NULL,           -- 'customer' | 'supplier' | 'product' | …
  entity_id   INT UNSIGNED NULL,               -- NULL for something not yet saved

  -- What happened. Free text rather than an ENUM for the same reason: a new
  -- action is data, not a migration.
  action      VARCHAR(40)  NOT NULL,           -- 'create' | 'update' | 'status' | 'note' | …

  -- One line for a person to read, already rendered. Storing the sentence
  -- rather than reconstructing it from before/after means an old entry still
  -- reads correctly after the code that wrote it has changed.
  detail      VARCHAR(400) NULL,

  -- The changed fields, as {"field": {"from": …, "to": …}}. Optional and only
  -- for edits. JSON so the shape can vary per entity — nothing queries inside
  -- it; it is rendered on the account's Activity tab.
  changes     JSON         NULL,

  -- cp2_users.id from the CONTROL database. No foreign key is possible: that
  -- table lives in a different database, potentially on a different server.
  user_id     INT UNSIGNED NULL,
  -- Snapshot of the name at the time. cp2_users.full_name can change and there
  -- is no FK to protect the reference, so without this a rename would silently
  -- rewrite history.
  user_name   VARCHAR(120) NOT NULL DEFAULT '',

  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  -- The account's Activity tab: one entity's history, newest first.
  KEY ix_activity_entity (entity, entity_id, created_at),
  -- "What did this user do today", for the exception reports a manager runs.
  KEY ix_activity_user (user_id, created_at),
  KEY ix_activity_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
