-- ============================================================================
-- 139 — Purchase documents get an audit trail
--
-- WHY
--
-- document_audit (015) records what happened to a SALES document — finalised,
-- voided, reprinted, edited — with who and when. Purchase documents had no
-- equivalent: a GRV could be received and voided, an order issued and
-- cancelled, and the only trace was the status column's final value. An
-- auditor asking "who voided this receipt, and why" had activity_log at best.
--
-- A separate table rather than a doc_source column on document_audit, for one
-- structural reason: document_audit.document_id carries a real FK to
-- sales_documents with ON DELETE CASCADE. A shared table would force dropping
-- that constraint, losing referential integrity for both sides, and put a
-- conditional join into every reader. The sales and purchasing document tables
-- were deliberately never merged ("the two sides of the trade face opposite
-- ways" — sequences.ts); their audit trails follow the same split.
--
-- Actions: 'finalised' (goods received), 'void' (receipt voided same-day),
-- 'issued' (PO sent to the supplier), 'cancelled' (order cancelled),
-- 'edited' / 'reprinted' reserved for parity with the sales side.
-- Draft saves are not audited — drafts are not tax documents (the sales rule).
-- ============================================================================

CREATE TABLE IF NOT EXISTS purchase_document_audit (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  document_id INT UNSIGNED NOT NULL,
  action      VARCHAR(40)  NOT NULL,
  detail      VARCHAR(400) NULL,
  before_json JSON         NULL,
  after_json  JSON         NULL,
  user_id     INT UNSIGNED NULL,
  user_name   VARCHAR(120) NOT NULL DEFAULT '',
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_pdocaudit_document (document_id, created_at),
  CONSTRAINT fk_pdocaudit_document FOREIGN KEY (document_id)
    REFERENCES purchase_documents (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
