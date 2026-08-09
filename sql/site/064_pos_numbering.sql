-- Per-till invoice numbering, so a till can keep trading with no database.
--
-- ── THE PROBLEM ──────────────────────────────────────────────────────────
--
-- nextDocumentNumber() allocates by taking the exclusive row lock on
-- document_sequences inside the finalise transaction. That is the most
-- carefully-argued invariant in this schema (see the module comment in
-- src/lib/site/sequences.ts) and it is why two tills can never print the same
-- invoice number. It also means a till with no connection cannot allocate at
-- all — and a shop whose line has dropped still has customers at the counter.
--
-- ── WHAT WAS REJECTED ────────────────────────────────────────────────────
--
-- Handing each till a POCKET of numbers in advance. Any finite pocket runs out,
-- and the runway a real store needs is unbounded — some are offline for hours.
-- Worse, an unused reserved number is indistinguishable from a lost invoice:
-- verifySequence() measures integrity as (last_issued_number - documents with a
-- number), so a block of 50 of which 7 were used reports 43 missing invoices,
-- on every till, every day. That is how a genuinely missing invoice hides.
--
-- ── WHAT THIS DOES ───────────────────────────────────────────────────────
--
-- Gives each till its own sequence. It allocates locally, forever, with nothing
-- reserved and nothing to exhaust. Two tills cannot collide because they never
-- share a counter, and each till's own invoice run is GAPLESS — which is what an
-- accountant actually reads.
--
-- The number carries who issued it:
--
--     INV _ 01 _ 02 _ 000097
--      |    |    |      \_ the till's own counter, zero-padded
--      |    |    \________ till number   (terminals.till_number)
--      |    \_____________ store number  (settings.store_number)
--      \__________________ doc-type prefix (document_sequences.prefix)
--
-- The STORE segment is not decoration. Twenty branches each number their first
-- till 01, so without it every branch issues INV_01_000097 and a group-level
-- report has twenty rows claiming one invoice number. uq_doc_number cannot catch
-- that — each site has its own database and its own copy of that index — so the
-- collision only surfaces when reports are compared, months later, unfixable.
--
-- ── WHAT IS NOT CHANGED ──────────────────────────────────────────────────
--
-- terminal_id = 0 is THE SITE-WIDE SEQUENCE: the row every document has always
-- numbered from, and the row that every non-till document keeps using unchanged
-- (quotes, credit notes, purchase orders, GRVs, journals, contracts, laybys,
-- transfers, expenses, assets — twelve of the thirteen callers). Their numbers
-- keep their present shape exactly, INV000041 with no segments at all.

-- ── 1. A sequence per till ──────────────────────────────────────────────
--
-- Zero rather than NULL for the site-wide row because this column is part of the
-- primary key, and MySQL cannot have a nullable column in one.
--
-- Every existing row takes 0 from the DEFAULT, which is precisely what it
-- already meant, so there is no data migration.
ALTER TABLE document_sequences
  ADD COLUMN terminal_id INT UNSIGNED NOT NULL DEFAULT 0 FIRST,
  DROP PRIMARY KEY,
  ADD PRIMARY KEY (doc_type, terminal_id);

-- ── 2. The till's number, as printed ────────────────────────────────────
--
-- Deliberately NOT terminals.id. That is an AUTO_INCREMENT nobody chose:
-- de-registering and re-adding a till would silently move it from 02 to 05, and
-- then print 05 on every slip from that moment on. The owner picks this.
--
-- NULL-able, and that is load-bearing: MySQL permits many NULLs in a unique
-- index (the same property uq_doc_number and uq_terminal_device already lean
-- on), so every existing terminal can sit at NULL — "not yet numbered" — while
-- two numbered tills still cannot share a number. A NOT NULL DEFAULT '' column
-- could not have this key at all, because the second existing row would
-- violate it immediately.
ALTER TABLE terminals
  ADD COLUMN till_number VARCHAR(4) NULL AFTER code,
  ADD UNIQUE KEY uq_terminal_till_number (till_number);

-- Number the tills that already exist, in registration order: 01, 02, 03.
--
-- A store that wants different numbers changes them in setup before trading;
-- once a till has issued a document its number is frozen, because two tills
-- sharing a number issue colliding invoice numbers.
--
-- ROW_NUMBER() rather than a `SET @n := 0` counter with `UPDATE … ORDER BY`:
-- that pattern relies on the order in which MySQL happens to evaluate the SET
-- clause, is deprecated in 8.0, and silently numbers rows in storage order when
-- the optimiser chooses a different plan — which is a wrong till number printed
-- on real invoices rather than an error anybody would see.
UPDATE terminals t
  JOIN (
    SELECT id, LPAD(ROW_NUMBER() OVER (ORDER BY id), 2, '0') AS n
      FROM terminals
     WHERE till_number IS NULL
  ) ranked ON ranked.id = t.id
   SET t.till_number = ranked.n;

-- One invoice sequence per active till.
--
-- The prefix is just the doc-type prefix. The store and till segments are
-- composed by formatNumber() from the setting and the terminal rather than baked
-- in here, so renumbering a store is a settings change and not a rewrite of
-- every sequence row.
--
-- Padding and reset_period are copied from the site-wide invoice row so a till
-- inherits whatever the store already uses rather than defaulting behind it.
INSERT INTO document_sequences (terminal_id, doc_type, prefix, next_number, padding, reset_period)
SELECT t.id, 'invoice', s.prefix, 1, s.padding, s.reset_period
  FROM terminals t
  CROSS JOIN (
    SELECT prefix, padding, reset_period
      FROM document_sequences
     WHERE doc_type = 'invoice' AND terminal_id = 0
  ) s
 WHERE t.is_active = 1
ON DUPLICATE KEY UPDATE doc_type = doc_type;

-- ── 3. Which numbering scheme this store uses ───────────────────────────
--
-- 'terminal' — per-till sequences. Unlimited offline runway, gapless per till,
--              no single company-wide invoice run.
-- 'site'     — one shared sequence, exactly as before this migration. A till
--              then cannot number offline at all; a store that wants one
--              continuous run and accepts that chooses this.
--
-- store_number is settable while sales_documents is empty and read-only forever
-- after. A store trading as 01 that should have been 07 cannot be corrected
-- afterwards: the numbers are on customers' invoices.
INSERT INTO settings (setting_key, setting_value) VALUES
  ('store_number', '01'),
  ('sales_number_scope', 'terminal')
ON DUPLICATE KEY UPDATE setting_key = setting_key;

-- ── 4. Offline sales ────────────────────────────────────────────────────
--
-- All NULL for every online sale, so nothing existing changes. Both unique keys
-- rely on many-NULLs-permitted, the same property documented at
-- 015_sales_core.sql:174 for document_number itself.
ALTER TABLE sales_documents
  -- The client-generated idempotency key (UUIDv4). Here as well as on
  -- offline_sync_claims so a document can always name the queue entry that
  -- created it, even after the claims table is pruned.
  ADD COLUMN offline_sale_uid  CHAR(36)     NULL AFTER document_number,
  -- When the money actually changed hands, from the till's own clock.
  -- document_date still governs the VAT period; this is the audit answer to
  -- "when", and on a sale that sat in an outbox overnight it is hours before
  -- created_at.
  ADD COLUMN offline_taken_at  DATETIME     NULL AFTER offline_sale_uid,
  ADD COLUMN offline_synced_at DATETIME     NULL AFTER offline_taken_at,
  -- Why a manager should look at this sale. NULL for the overwhelming majority.
  -- An offline sale is CLASSIFIED, never refused: it is already tendered,
  -- receipted and in the drawer, so a server that rejects it does not undo the
  -- sale, it loses the revenue and the VAT.
  ADD COLUMN offline_exception VARCHAR(400) NULL AFTER offline_synced_at,
  ADD UNIQUE KEY uq_offline_uid (offline_sale_uid),
  ADD KEY ix_offline_unsynced (offline_synced_at, offline_taken_at);

-- ── 5. Sync idempotency ─────────────────────────────────────────────────
--
-- Claims a client-generated sale uid BEFORE the sale is finalised, so a retry
-- returns the number already allocated instead of posting the sale twice.
--
-- The PRIMARY KEY is the whole mechanism: one INSERT … ON DUPLICATE either wins
-- the claim or discovers the sale is already ours, with no read-then-write race.
-- A till WILL send the same batch twice — "the request timed out" and "the
-- request succeeded and the response was lost" are indistinguishable to it.
--
-- Its own table rather than a column on sales_documents because the claim has to
-- exist BEFORE the document does, and a claim that failed mid-finalise must be
-- visible afterwards so the next attempt knows to retry rather than assume.
CREATE TABLE offline_sync_claims (
  sale_uid        CHAR(36)     NOT NULL,
  terminal_id     INT UNSIGNED NULL,
  -- 'claimed' the instant the uid is taken; 'posted' once finaliseDocument has
  -- committed; 'rejected' when the sale cannot post at all (a locked VAT period,
  -- a malformed payload) and a human has to look at it. A row stuck at
  -- 'claimed' means a crash between the claim and the commit — retryable,
  -- because nothing was written.
  status          ENUM('claimed','posted','rejected') NOT NULL DEFAULT 'claimed',
  document_id     INT UNSIGNED NULL,
  document_number VARCHAR(32)  NULL,
  operator_name   VARCHAR(120) NOT NULL DEFAULT '',
  error           VARCHAR(400) NULL,
  attempts        SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  claimed_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  posted_at       DATETIME NULL,
  PRIMARY KEY (sale_uid),
  KEY ix_claims_status (status, claimed_at),
  -- SET NULL, not CASCADE: if a document is ever removed the claim must survive
  -- as the record that this uid was used, or a retry re-posts the sale.
  CONSTRAINT fk_claim_doc FOREIGN KEY (document_id)
    REFERENCES sales_documents (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 6. Offline sales cancelled before they ever synced ──────────────────
--
-- Nothing to void — the document does not exist — but it must not vanish
-- silently either: a till that can make a sale disappear without a trace is a
-- till somebody can steal from. Every line and every tender is kept, so a
-- pattern of large cancelled sales by one operator is visible.
--
-- document_number is recorded because the number is BURNT, not reused. If the
-- slip had printed, reusing that number would put two different sales under one
-- invoice number, and offline there is no unique index to catch it. This row is
-- then the explanation for the one gap a till's otherwise gapless run can have.
CREATE TABLE offline_cancelled_sales (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  sale_uid        CHAR(36)     NOT NULL,
  document_number VARCHAR(32)  NULL,
  terminal_id     INT UNSIGNED NULL,
  terminal_code   VARCHAR(24)  NULL,
  user_id         INT UNSIGNED NULL,
  user_name       VARCHAR(120) NOT NULL DEFAULT '',
  total_incl      DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  reason          VARCHAR(190) NULL,
  taken_at        DATETIME     NULL,
  cancelled_at    DATETIME     NULL,
  payload         JSON         NULL,
  synced_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_cancelled_uid (sale_uid),
  KEY ix_cancelled_user (user_id, cancelled_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
