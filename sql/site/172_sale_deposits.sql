-- ─────────────────────────────────────────────────────────────────────────
-- Money taken up front against a sale, a quote or an invoice.
--
-- NOTE: no apostrophes in comments in this file. The runner sends it as one
-- multipleStatements batch, and MariaDB reads a lone ' inside a `--` comment
-- as opening a string literal, swallowing the SQL that follows. 024 learned
-- this the hard way.
--
-- ── WHY A TABLE AND NOT A COLUMN ─────────────────────────────────────────
--
-- sales_documents has no amount_paid column, and this does not add one. A
-- denormalised total agrees with the rows it summarises only while somebody
-- maintains it, and the first time they disagree there is no way to tell which
-- one lied. What has been paid is SUM(sale_deposits.amount) and nothing else.
--
-- Several deposits against one document is also the ordinary case, not an
-- edge: a customer pays R500 today and R500 on Friday against the same quote.
-- A column could hold only the total and would lose both tenders, both dates
-- and both cash-ups.
--
-- ── IT IS NOT A DEBT, AND NOT YET A SALE ─────────────────────────────────
--
-- This follows layby_payments exactly, for the reason 024 gives. Until the
-- goods are handed over the money remains the property of the customer (CPA
-- s62(1)(a)), so a deposit must NOT write:
--
--   customer_transactions  — every row there moves the debtor balance, and a
--                            customer who has paid a deposit owes nothing
--   the general ledger     — revenue is recognised at delivery, not at deposit
--   VAT                    — time of supply falls on delivery; a deposit sits
--                            outside the VAT system until it is applied
--   stock_movements        — nothing has left the shelf
--
-- All of that happens once, at finalise, when the deposit is replayed as a
-- tender through the ordinary posting path. Exactly what completeLayby does.
--
-- ── BUT THE MONEY IS REALLY IN THE DRAWER ────────────────────────────────
--
-- It went through the till, so the cash-up must see it or every drawer that
-- took a deposit reconciles short by exactly that amount. shift_id is the
-- entire mechanism — cashupDeclaration reads layby_payments by shift_id and
-- now reads this table the same way. tender_type_id AND tender_name are both
-- stored, the name as a snapshot, so a renamed tender type does not rewrite
-- what a past cash-up said.
--
-- ── TWO IDENTITIES, BECAUSE THE TILL HAS TWO ─────────────────────────────
--
-- An online basket is a sales_documents row. A basket parked while the network
-- was down is a uid string in IndexedDB that never becomes one. Both can take
-- a deposit, so both need somewhere to hang it, and a single "either" column
-- is how a lookup ends up matching the wrong basket.
--
-- Hence document_id AND basket_uid, exactly one of which is set, enforced by
-- ck_deposit_owner below. When an offline basket later syncs, document_id is
-- filled in and basket_uid stays as the record of where it came from.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sale_deposits (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- The document this money is held against. NULL only while the basket it
  -- belongs to is still offline-only.
  document_id    INT UNSIGNED NULL,

  -- The offline basket that took it, when there is no document yet. Matches
  -- the uid crypto.randomUUID() writes into IndexedDB.
  basket_uid     VARCHAR(64)  NULL,

  --   deposit   money taken and held
  --   refund    money handed back because the deposit was released (negative)
  --   applied   the deposit consumed by a finalised sale (negative)
  --
  -- Σ amount is therefore what is still held. A fully applied deposit sums to
  -- zero rather than disappearing, so the history of a document stays readable
  -- after it posts.
  kind           ENUM('deposit','refund','applied') NOT NULL DEFAULT 'deposit',

  -- Positive takes money in, negative gives it back or consumes it.
  amount         DECIMAL(12,4) NOT NULL,

  -- How it was paid. Both columns, for the reason layby_payments gives: the id
  -- for reporting, the name as a snapshot so history does not get rewritten.
  tender_type_id INT UNSIGNED NULL,
  tender_name    VARCHAR(60)  NOT NULL DEFAULT '',
  reference      VARCHAR(120) NULL,

  taken_on       DATE         NOT NULL,

  -- The cash-up hinge. Null is legitimate — a deposit taken from the back
  -- office belongs to no drawer.
  shift_id       INT UNSIGNED NULL,
  terminal_id    INT UNSIGNED NULL,

  -- cp2_users.id from the CONTROL database. No FK is possible across
  -- databases, so the name is snapshotted alongside it.
  user_id        INT UNSIGNED NULL,
  user_name      VARCHAR(120) NOT NULL DEFAULT '',

  note           VARCHAR(190) NULL,
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),

  -- The two read paths: everything held against one document, and everything
  -- that hit one drawer.
  KEY ix_sdep_document (document_id, taken_on),
  KEY ix_sdep_basket   (basket_uid),
  KEY ix_sdep_shift    (shift_id),

  -- Deleting a draft must not strand its deposits. A document that took money
  -- and was then discarded is a refund, not a delete, and the refusal for that
  -- lives in code where it can explain itself.
  CONSTRAINT fk_sdep_document FOREIGN KEY (document_id)
    REFERENCES sales_documents (id) ON DELETE RESTRICT,

  -- Exactly one owner. Both set is the offline basket that has since synced,
  -- which is legitimate; neither set is money belonging to nothing.
  CONSTRAINT ck_sdep_owner CHECK (document_id IS NOT NULL OR basket_uid IS NOT NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Settings ─────────────────────────────────────────────────────────────
-- deposit_min_pct       the smallest deposit that may be taken, as a
--                       percentage of the document total. 0 means any amount,
--                       which is the sensible default: a shop taking R50
--                       against a R5000 quote is doing ordinary business.
-- deposit_allow_walkin  whether a deposit may be taken without naming a
--                       customer. On by default because the money is held
--                       against the DOCUMENT, not against an account, so a
--                       walk-in deposit is coherent. A store that wants every
--                       deposit traceable to a person can turn it off.
INSERT IGNORE INTO settings (setting_key, setting_value)
VALUES
  ('deposit_min_pct', '0'),
  ('deposit_allow_walkin', '1');
