-- Contracts — an agreement to bill a customer the same thing every month.
--
-- A security company billing 400 sites for monitoring, a landlord billing rent,
-- an IT firm billing a support retainer. Today each of those is re-keyed as a
-- fresh invoice every month, which is both tedious and unreliable: the month
-- somebody forgets, revenue is simply missing and nothing reports it.
--
-- This is the debtors-side mirror of recurring_expenses (042). Same shape, same
-- reasoning, and it deliberately reuses `nextOccurrence`/`isDue` from the same
-- date arithmetic — a schedule is a schedule regardless of which way the money
-- flows. Read the header of 042_expenses.sql for the argument; it is not
-- repeated here.
--
-- ── WHERE IT DIFFERS FROM A RECURRING EXPENSE ────────────────────────────
--
-- Three things, and each one is why this is its own table rather than a flag on
-- the expense schedule:
--
--   1. It bills PRODUCTS, not categories. A contract line points at products(id)
--      and carries a qty and a VAT-inclusive price, because what it generates is
--      a sales_documents invoice that a customer receives.
--   2. It ESCALATES. A multi-year agreement raises its price on a nominated
--      month each year. Nothing on the payables side does this.
--   3. It can send ITSELF. An expense draft always waits for a person; a
--      contract invoice may post and email unattended — see auto_send.
--
-- ── WHY THE PRICE LIVES ON THE CONTRACT LINE ─────────────────────────────
--
-- unit_price_incl is copied from the product when the line is added and then
-- NEVER re-read. A contract is a price the customer AGREED TO; re-deriving it
-- from today's price list would silently re-price a signed agreement, which is
-- the one thing a contract exists to prevent. The same snapshot rule
-- sales_document_lines states in 015, for the same reason.
--
-- The screen may show that a product's list price has drifted from the
-- contracted one — the way quote conversion warns about moved prices — but
-- drift is a commercial conversation, not an arithmetic correction.

-- ── Contracts ────────────────────────────────────────────────────────────
CREATE TABLE contracts (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- Issued at creation, not at first bill: a contract is referred to by number
  -- in conversation and on the customer's own paperwork long before it has
  -- generated anything. Comes from document_sequences like every other number.
  contract_number VARCHAR(32)  NULL,
  name            VARCHAR(120) NOT NULL,   -- 'Monitoring — Northcliff branch'

  -- RESTRICT, like sales_documents: a customer with a live contract is not
  -- deletable, and the database says so rather than trusting every code path.
  customer_id     INT UNSIGNED NOT NULL,

  -- ── The schedule ──────────────────────────────────────────────────────
  frequency       ENUM('monthly','quarterly','annually') NOT NULL DEFAULT 'monthly',
  -- 1-31. A 31 in a short month falls back to the last day, handled in code
  -- because MySQL has no clean way to express it. Same clamp as 042.
  billing_day     TINYINT UNSIGNED NOT NULL DEFAULT 1,

  starts_on       DATE         NOT NULL,
  -- NULL means it runs until cancelled. A fixed-term agreement sets it so the
  -- contract stops on its own rather than billing for ever — the commonest
  -- billing complaint there is.
  ends_on         DATE         NULL,

  -- The last period actually generated. THE idempotence key: generating twice
  -- in a month must not produce two invoices. Stamped BEFORE the next period is
  -- considered, so a failure part-way never re-bills what already went out.
  last_generated_for DATE      NULL,

  -- ── Escalation ────────────────────────────────────────────────────────
  --
  -- A fixed MONTH each year, not the contract's anniversary: a book of 400
  -- contracts signed on 400 different dates should escalate together, in the
  -- month the business decided, so the increase is one announcement and one
  -- reconciliation rather than a trickle all year.
  --
  -- Compounding, because that is what an escalation clause means — 8% on last
  -- year's price, not 8% of the original for ever.
  escalation_pct     DECIMAL(6,3) NOT NULL DEFAULT 0.000,
  -- 1-12. NULL (with pct 0) means the price never moves.
  escalation_month   TINYINT UNSIGNED NULL,
  -- Which escalation has already been applied. Separate from
  -- last_generated_for because the two run on different cadences: a quarterly
  -- contract still escalates once a year, and folding them together would
  -- either skip a raise or apply it three times.
  last_escalated_for DATE       NULL,

  -- ── Sending ───────────────────────────────────────────────────────────
  --
  -- OFF by default, deliberately. A new contract's first invoice is the one
  -- most likely to be wrong — wrong price, wrong VAT, wrong customer — and an
  -- auto-posted invoice reaching a customer is undone with a credit note, not
  -- an edit. So a contract earns automation after somebody has watched it
  -- produce a correct invoice once.
  --
  -- ON: the tick posts the invoice to the customer's account and emails it.
  -- OFF: the tick leaves a DRAFT for somebody to review and release.
  auto_send       TINYINT(1)   NOT NULL DEFAULT 0,
  -- Whether the emailed invoice carries a "pay online" link. Needs a configured
  -- payment gateway (038); the send falls back to a plain attachment when there
  -- is none, rather than emitting a link that cannot work.
  offer_payment_link TINYINT(1) NOT NULL DEFAULT 1,

  -- Days from invoice date to due date, written onto the generated invoice.
  payment_terms_days SMALLINT UNSIGNED NOT NULL DEFAULT 30,

  is_active       TINYINT(1)   NOT NULL DEFAULT 1,
  reference       VARCHAR(60)  NULL,       -- the customer's own contract ref
  notes           VARCHAR(400) NULL,       -- prints on the invoice
  internal_note   VARCHAR(400) NULL,       -- never printed

  -- cp2_users.id from the CONTROL database — no FK is possible across
  -- databases. Name snapshotted for the same reason as everywhere else.
  user_id         INT UNSIGNED NULL,
  user_name       VARCHAR(120) NOT NULL DEFAULT '',

  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_contract_number (contract_number),
  KEY ix_contract_customer (customer_id, is_active),
  -- The tick's own query: active contracts, soonest start first.
  KEY ix_contract_active (is_active, starts_on),
  CONSTRAINT fk_contract_customer FOREIGN KEY (customer_id)
    REFERENCES customers (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Contract lines ───────────────────────────────────────────────────────
--
-- What gets billed. Copied onto each generated invoice as sales_document_lines,
-- so the shape mirrors that table where it can.
CREATE TABLE contract_lines (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  contract_id     INT UNSIGNED NOT NULL,
  line_number     SMALLINT UNSIGNED NOT NULL DEFAULT 1,

  -- SET NULL, matching sales_document_lines: products are archived rather than
  -- deleted once history exists, but if one ever is, the line keeps its
  -- snapshot and the contract stays billable.
  product_id      INT UNSIGNED NULL,
  product_code    VARCHAR(40)  NULL,       -- snapshot
  description     VARCHAR(190) NOT NULL,   -- snapshot; editable per contract

  qty             DECIMAL(12,3) NOT NULL DEFAULT 1.000,

  -- VAT-INCLUSIVE, per THE MONEY RULE (001, 015). This is the agreed price and
  -- the escalated one — see the header on why it is never re-read from the
  -- product file.
  unit_price_incl DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  -- What the price was when the contract was signed, before any escalation.
  -- Kept so the contract screen can show "R1 000.00 → R1 166.40 over 2 years"
  -- and so a mis-applied escalation is provable rather than merely suspected.
  base_price_incl DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  vat_rate_pct    DECIMAL(6,3)  NOT NULL DEFAULT 0.000,
  department_id   INT UNSIGNED NULL,

  PRIMARY KEY (id),
  KEY ix_cline_parent (contract_id, line_number),
  CONSTRAINT fk_cline_parent FOREIGN KEY (contract_id)
    REFERENCES contracts (id) ON DELETE CASCADE,
  CONSTRAINT fk_cline_product FOREIGN KEY (product_id)
    REFERENCES products (id) ON DELETE SET NULL,
  CONSTRAINT fk_cline_dept FOREIGN KEY (department_id)
    REFERENCES departments (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── What each run produced ───────────────────────────────────────────────
--
-- One row per contract per billed period. Two jobs, and the second is the
-- important one:
--
--   1. It is the audit trail — "what did we bill this contract in March, and
--      did the customer ever receive it".
--   2. It is the CLAIM. `uq_contract_period` means a second tick for the same
--      period cannot insert, so two overlapping cron runs cannot double-bill
--      even if both read last_generated_for before either wrote it. The stamp
--      on contracts is the fast path; this unique key is the guarantee.
--
-- Emailing is tracked separately from generation because they fail
-- independently: an invoice that posted correctly but bounced on send is a
-- resend, not a re-bill, and conflating the two is how a customer gets billed
-- twice for one month.
CREATE TABLE contract_invoices (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  contract_id     INT UNSIGNED NOT NULL,
  -- The period this covers — the billing date, not the date it ran. A catch-up
  -- generating three missed months writes three rows dated in the past.
  for_date        DATE         NOT NULL,

  -- NULL only in the window between claiming the period and creating the
  -- document. A row that stays NULL means the run died mid-way and this period
  -- needs looking at — which is worth being able to find.
  document_id     INT UNSIGNED NULL,

  --   draft  — created, awaiting review (auto_send off, or the post failed)
  --   posted — finalised to the customer's account
  --   failed — could not be created; `error` says why
  status          ENUM('draft','posted','failed') NOT NULL DEFAULT 'draft',

  --   pending — not attempted yet (a draft has not been released)
  --   sent    — the customer received it
  --   failed  — the send was attempted and refused; `error` says why
  --   skipped — no email address, or email is not configured
  email_status    ENUM('pending','sent','failed','skipped') NOT NULL DEFAULT 'pending',
  emailed_to      VARCHAR(190) NULL,       -- snapshot of where it actually went
  emailed_at      DATETIME     NULL,
  email_attempts  SMALLINT UNSIGNED NOT NULL DEFAULT 0,

  error           VARCHAR(400) NULL,
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  -- The double-bill guarantee. See the note above.
  UNIQUE KEY uq_contract_period (contract_id, for_date),
  KEY ix_cinv_document (document_id),
  -- "What still needs sending" and "what failed", the two screens that matter.
  KEY ix_cinv_email (email_status, created_at),
  CONSTRAINT fk_cinv_contract FOREIGN KEY (contract_id)
    REFERENCES contracts (id) ON DELETE CASCADE,
  -- SET NULL rather than CASCADE: voiding and deleting a document must not
  -- erase the evidence that this period was billed, or the next tick bills it
  -- again.
  CONSTRAINT fk_cinv_document FOREIGN KEY (document_id)
    REFERENCES sales_documents (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The contract number's own sequence. CON000001, alongside INV/QUO/CRN.
INSERT INTO document_sequences (doc_type, prefix, next_number, padding)
VALUES ('contract', 'CON', 1, 6)
ON DUPLICATE KEY UPDATE doc_type = doc_type;

-- ── Paying an invoice online ─────────────────────────────────────────────
--
-- payment_intents (038) was built for storefront orders and its `purpose` says
-- so. A contract invoice emailed with a "pay now" link settles through exactly
-- the same machinery — signed callback token, ITN verification, replay guard —
-- so the enum grows by one value rather than the flow being rebuilt.
--
-- `target_id` then means a sales_documents.id rather than an order id, which is
-- why the callback branches on purpose before deciding what to settle. It is
-- not a FK either way: the column already points at two different tables by
-- design, and 038 made the same call.
ALTER TABLE payment_intents
  MODIFY COLUMN purpose ENUM('online_order','debtor_invoice')
    NOT NULL DEFAULT 'online_order';
