-- One AI call, charged once — however many times the debit is sent.
--
-- ── THE PROBLEM THIS SOLVES ────────────────────────────────────────────────
--
-- A desktop install charges its AI calls over HTTPS now (POST /ai/credits/
-- consume) rather than by writing the ledger directly. A POST that times out
-- does not say whether the write landed: the request may have died on the way
-- there, or the answer may have died on the way back having already committed.
-- The client cannot tell those apart, so it must be free to retry — and a
-- retry with no guard charges the shop twice for one document scan.
--
-- ── WHY A SEPARATE TABLE AND NOT A COLUMN ON THE LEDGER ────────────────────
--
-- The obvious move is a nullable `idempotency_key` on cp2_ai_credit_ledger with
-- a UNIQUE index. It does not work, and it fails SILENTLY, which is worse than
-- not working.
--
-- A UNIQUE index does not constrain NULL in MariaDB. Topup, manual and
-- adjustment rows have no idempotency key, so the column would have to be
-- nullable — and every one of those rows would satisfy the index no matter how
-- many of them there were. The guard would look present in the schema, pass
-- every test written against usage rows, and protect nothing the day somebody
-- added a second entry type.
--
-- 021 made exactly this argument for cp2_ai_topup_pending.pf_payment_id, and
-- resolved it the same way: put the key where it is NOT NULL. This table is
-- that place for usage.
--
-- ── HOW THE GUARD ACTUALLY WORKS ───────────────────────────────────────────
--
-- The consume endpoint INSERTs here and writes the ledger debit in ONE
-- transaction. The UNIQUE key means the second arrival of the same call cannot
-- insert, so it cannot debit either — InnoDB refuses at the moment of write
-- rather than application code checking first and racing itself. Two
-- deliveries that both read "have I charged this?" can both read no; a unique
-- index cannot both-yes.
--
-- The second arrival is a NO-OP, not an error. The caller asked for this call
-- to be charged, and it has been — so the endpoint answers with what the first
-- attempt charged, read back through ledger_id, and the client sees a normal
-- success. A retry that reports failure would send the caller round again.
--
-- ── WHY ledger_id IS NOT NULL ──────────────────────────────────────────────
--
-- It is what makes the replay answerable. Without it a duplicate could only be
-- told "already charged" with no figure, and the client's ConsumeResult
-- promises costMicros and a balance. Being NOT NULL also states the invariant
-- the transaction upholds: a row here without its debit would be a charge
-- recorded against nothing, and the FK's CASCADE keeps the pair together if a
-- ledger row is ever removed.
--
-- Apply by hand, ONCE, to the control database (odyssey_tickets) — this is
-- not a per-site migration and site-migrate.mjs will never see it. sql/tickets/
-- has no runner, so verify afterwards with:
--
--   node --env-file=.env scripts/check-pending-migrations.mjs
--
-- which asserts the UNIQUE key as well as the table, because a table with the
-- column and no unique key guards nothing while looking correct.

CREATE TABLE IF NOT EXISTS cp2_ai_usage_keys (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- The client's own id for one metered call. A UUIDv4 today (meter.ts mints it
  -- with randomUUID before the call runs), but sized and typed as an opaque
  -- string rather than CHAR(36): the guard is the uniqueness, not the format,
  -- and a caller that adopts a different scheme should not need an ALTER.
  idempotency_key VARCHAR(64) NOT NULL,

  -- Which wallet was charged. Not part of the unique key — a key must be
  -- globally unique or a caller could replay one account's charge against
  -- another. Kept for tracing and so a stale row can be cleaned per account.
  account_id      INT UNSIGNED NOT NULL,

  -- The debit this key produced. Read back verbatim on a replay, which is what
  -- lets the second attempt answer with the FIRST attempt's figures rather than
  -- recomputing them — a recomputation from resent usage could disagree.
  ledger_id       BIGINT UNSIGNED NOT NULL,

  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),

  -- THE GUARD. Global, not per-account: see account_id above.
  UNIQUE KEY uq_auk_key (idempotency_key),
  KEY ix_auk_account (account_id, created_at),

  CONSTRAINT fk_auk_account FOREIGN KEY (account_id)
    REFERENCES cp2_billing_accounts (id) ON DELETE CASCADE,
  CONSTRAINT fk_auk_ledger FOREIGN KEY (ledger_id)
    REFERENCES cp2_ai_credit_ledger (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
