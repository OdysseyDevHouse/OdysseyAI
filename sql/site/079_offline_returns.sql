-- Returns taken while the till could not reach the server.
--
-- A shop trading offline could sell but not refund. §5.1 of the POS plan blocked
-- credit notes offline and §8.3(b) told the cashier "this sale is already on the
-- books" — which together mean a customer standing at the counter with a faulty
-- kettle during an ADSL outage gets sent away. That is the hole this closes.
--
-- ── WHAT IS AND IS NOT SUPPORTED, AND WHY ──────────────────────────────────
--
-- ONLY a return WITHOUT A RECEIPT — createCreditNote's `invoice_id IS NULL` case,
-- which already existed and is already a first-class path.
--
-- A RECEIPTED return is deliberately not possible offline, because of a guard the
-- till structurally cannot run: creditedQtyByLine() sums every credit note ever
-- raised against an invoice — across every till and the back office — to refuse
-- crediting more than was sold. A till knows only about its own sales. Two tills,
-- or a return against a sale from last week, and an offline receipted return would
-- credit one invoice twice with nothing able to notice. A credit note is money
-- leaving the drawer, so that is not a risk worth taking for convenience.
--
-- The consequence is honest rather than hidden: the document says "return without
-- a receipt", and the exceptions screen shows a manager it was taken blind.

-- ── 1. The credit-note sequence goes per-till, exactly as invoices did ──────
--
-- 064 re-keyed document_sequences to (doc_type, terminal_id) with terminal_id = 0
-- meaning the site-wide row, so the SCHEMA already supports this — what is missing
-- is a row per till for 'credit_sale'. Without one, a till offline cannot number a
-- credit note at all, and nextDocumentNumber() throws rather than silently falling
-- back to the shared sequence (which would drop a till's credit note into the
-- middle of the back office's run).
--
-- Prefix from the site-wide row, so a shop that renamed CRN keeps its name rather
-- than having one hardcoded here.
INSERT INTO document_sequences (terminal_id, doc_type, prefix, next_number, padding)
SELECT t.id,
       'credit_sale',
       COALESCE((SELECT s.prefix FROM document_sequences s
                  WHERE s.doc_type = 'credit_sale' AND s.terminal_id = 0), 'CRN'),
       1,
       COALESCE((SELECT s.padding FROM document_sequences s
                  WHERE s.doc_type = 'credit_sale' AND s.terminal_id = 0), 6)
  FROM terminals t
 WHERE t.is_active = 1
   AND t.till_number IS NOT NULL
ON DUPLICATE KEY UPDATE doc_type = doc_type;

-- ── 2. Claiming a return uid ───────────────────────────────────────────────
--
-- The same mechanism as offline_sync_claims, and a SEPARATE table rather than a
-- doc_type column on that one. Two reasons, both practical: the FK points at a
-- different kind of document and would have to be nullable-and-ambiguous to serve
-- both, and a uid namespace shared between sales and returns means a client bug
-- that reuses a uid across the two silently resolves as "already posted" and
-- swallows a refund.
CREATE TABLE offline_return_claims (
  return_uid      CHAR(36)     NOT NULL,
  terminal_id     INT UNSIGNED NULL,
  -- Same three states, same meanings as offline_sync_claims. 'claimed' with a
  -- document_id set is the crash window between the credit note committing and the
  -- claim being updated — recoverable, and the reason document_id is here at all.
  status          ENUM('claimed','posted','rejected') NOT NULL DEFAULT 'claimed',
  document_id     INT UNSIGNED NULL,
  document_number VARCHAR(32)  NULL,
  operator_name   VARCHAR(120) NOT NULL DEFAULT '',
  error           VARCHAR(400) NULL,
  attempts        SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  claimed_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  posted_at       DATETIME NULL,
  PRIMARY KEY (return_uid),
  KEY ix_return_claims_status (status, claimed_at),
  -- SET NULL not CASCADE, for the same reason as the sales claim: if the document
  -- is ever removed, the claim must survive as the record that this uid was used,
  -- or a retry refunds the customer a second time.
  CONSTRAINT fk_return_claim_doc FOREIGN KEY (document_id)
    REFERENCES sales_documents (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 3. Marking the document as having been taken offline ───────────────────
--
-- The same three columns sales_documents already carries for offline SALES (064),
-- reused rather than duplicated: a credit note is a row in the same table, so
-- `offline_sale_uid` holds a return's uid just as well as a sale's and every screen
-- that already reads "was this taken offline" keeps working with no change.
--
-- What it cannot express is WHICH kind of uid it holds, and that is fine — the
-- doc_type beside it already says. Adding offline_return_uid would mean every
-- reader learning to check two columns for one fact.
--
-- Note what reusing the column buys: uq_offline_uid is a plain UNIQUE on
-- offline_sale_uid, so it spans sales AND returns. A client bug that issued one uid
-- for both is refused by the database at the second insert rather than posting two
-- documents. The two claim tables cannot see each other; this index can.
--
-- offline_exception carries the same thing it carries for a sale: the blind-return
-- note, an operator who did not hold sales.credit_note, or a figure the server
-- recomputed differently.

-- Nothing to add. Recorded here so the next person does not go looking for a
-- separate set of offline_return_* columns and conclude they were forgotten.
