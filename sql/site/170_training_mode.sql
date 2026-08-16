-- ─────────────────────────────────────────────────────────────────────────
-- Training mode: a session of pretend trading that leaves nothing behind.
--
-- Somebody new needs to ring up a sale, take a payment, receive stock and get
-- it wrong a few times before they are let near a real customer. Every one of
-- those acts posts: stock moves, a document takes a number, the ledger and the
-- GL mirror it. Training on a live system therefore corrupts the very figures
-- the shop runs on, and the usual answer -- a separate demo database -- is one
-- nobody sets up, because it needs different logins and never has the real
-- products in it.
--
-- So instead the site is put into training for a while and then taken out, and
-- everything done in between is removed.
--
-- ── WHY A WATERMARK AND NOT A FLAG ON EVERY TABLE ────────────────────────
--
-- The obvious design is is_training on sales_documents, stock_movements,
-- journal_lines and the thirty other tables a day of trading touches. It was
-- rejected. That is thirty ALTERs, thirty hook points that must each remember
-- to set it, and -- the fatal part -- a table added next month that nobody
-- remembers to stamp. The purge would then run, report success, and leave rows
-- behind. A cleanup that is silently incomplete is worse than none.
--
-- This table instead records, at the instant training starts, the highest id
-- already present in every table training can write to. Everything above that
-- watermark was created during the session, by definition -- no stamping, and
-- no way for a row to escape by being in a table the writer forgot.
--
-- What makes that sound is the SITE-WIDE switch. While training is on, nothing
-- real is being created anywhere on the site, so "id greater than the mark" and
-- "made during training" are the same set. A per-till training mode would break
-- that equivalence instantly and is why this is not per-till.
--
-- ── WHY THE MANIFEST IS CAPTURED, NOT COMPUTED AT THE END ─────────────────
--
-- Read at exit, MAX(id) tells you where the table is NOW, not where it was.
-- The marks must be taken before the first training row exists or they include
-- it. Capturing at entry also makes the purge inspectable: the row says exactly
-- what will be deleted, before anyone commits to deleting it.
--
-- ── ONE ROW AT A TIME ────────────────────────────────────────────────────
--
-- ended_at NULL means the session is open, and the partial unique index makes
-- a second open session impossible rather than merely unlikely. Ended sessions
-- are KEPT -- the log of who trained, when, and how much was removed is the one
-- part of training mode that is real history and must survive it.
--
-- MariaDB has no partial index, so uniqueness is carried on a generated column
-- that is 1 while open and NULL once closed -- NULLs do not collide in a UNIQUE
-- index, which is exactly the semantics wanted.
--
-- DDL auto-commits, so every step here is re-runnable.
--
-- NOTE: no apostrophes in comments anywhere in this file. The runner sends it
-- as one multipleStatements batch, and MariaDB reads a lone ' inside a `--`
-- comment as opening a string literal, swallowing the SQL that follows.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS training_sessions (
  id            INT UNSIGNED    NOT NULL AUTO_INCREMENT,

  -- The watermark. A JSON object of table name to the highest id that existed
  -- when training started: {"sales_documents": 4193, "stock_movements": 88214}.
  --
  -- JSON and not a child table because it is written once, read once, and never
  -- queried by key. The set of tables in it is a property of the CODE that took
  -- the snapshot, not of the schema -- a session captured before a new table
  -- existed simply has no mark for it, and the purge treats a missing mark as
  -- "this table had nothing to protect", which is the correct reading.
  marks         LONGTEXT        NOT NULL,

  -- What the purge actually removed, same shape: table name to row count.
  -- NULL until the session is closed. This is the receipt, and the reason an
  -- ended session is kept rather than deleted: it is the only evidence that the
  -- shop was put back the way it was found.
  removed       LONGTEXT        NULL,

  -- Who turned it on and off. Plain columns, not FKs, following shifts (016):
  -- the history of a training session must not become undeletable-user pressure
  -- on the users table, and the name is what a reader needs anyway.
  started_by    INT UNSIGNED    NULL,
  started_name  VARCHAR(120)    NULL,
  ended_by      INT UNSIGNED    NULL,
  ended_name    VARCHAR(120)    NULL,

  started_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- NULL while training is running. Set when it is switched off and the purge
  -- has committed -- never before, so a crash mid-purge leaves the session open
  -- and the site still in training, which is the recoverable state. The
  -- alternative ordering loses track of rows that are still there.
  ended_at      DATETIME        NULL,

  -- 1 while ended_at IS NULL, NULL afterwards. See the header: this is how one
  -- open session at a time is enforced without a partial index.
  is_open       TINYINT UNSIGNED AS (IF(ended_at IS NULL, 1, NULL)) VIRTUAL,

  PRIMARY KEY (id),
  UNIQUE KEY uq_training_open (is_open),
  KEY ix_training_started (started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
