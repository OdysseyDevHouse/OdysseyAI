-- ─────────────────────────────────────────────────────────────────────────
-- Pay links — a customer settles something without standing at the till.
--
-- ── WHAT THIS IS NOT ─────────────────────────────────────────────────────
--
-- It is NOT a second payment integration. 038_payments.sql built the whole
-- machine — a per-store gateway, an intent recording what we expect, and a
-- verified callback that is the only thing allowed to say money arrived. That
-- file said, in as many words, that a new way to be paid should be a new
-- `purpose` and a settlement handler rather than a second integration. This is
-- that sentence being cashed in, twice: once for the ENUM below, once for the
-- table.
--
-- ── THE INVARIANT THAT SHAPED ALL OF IT ──────────────────────────────────
--
-- There is no such thing as an unpaid walk-in invoice.
--
-- finaliseDocument refuses to post anything with money still outstanding, and
-- the only tender that CAN leave a balance is one with posts_to_debtor, which
-- in turn refuses to run without a customer attached. So a finalised invoice
-- that is still owed is, necessarily, an account sale. "Walk in, scan the
-- invoice, pay it" describes a document state this system cannot produce.
--
-- That is worth writing down here because the obvious feature request — a pay
-- link on every invoice, for anyone — reads as a gap in the code when it is
-- actually the invariant holding. The place a non-debtor genuinely owes money
-- over time is a LAY-BY, a JOB CARD, or a deposit against a quote or order.
-- Hence the purposes below, and hence no attempt to relax settlePaidInvoice's
-- customer guard, which is correct exactly as it stands.
--
-- ── A LINK COLLECTS MONEY; IT NEVER ADVANCES A DOCUMENT ──────────────────
--
-- The most tempting version of this feature is "customer pays the quote, and
-- it becomes an invoice by itself". It is not built, on purpose.
--
-- convertToInvoice deliberately produces a DRAFT and raises three warnings for
-- a person to read: the quote has expired, prices have moved since it was
-- offered, there is not enough stock. Converting on payment would take the
-- money and only then discover the goods cannot be supplied — cash held
-- against stock that is not there, and a customer holding a paid invoice for
-- it. Quotes reserve nothing by design, so several open quotes for the last
-- unit are all payable at once, and that is the ordinary case rather than the
-- exotic one.
--
-- Sales orders reach the same answer by a different road. Stock IS reserved
-- there and the commercial decision IS made, but deliverOrder exists to invoice
-- an order in PARTS. A payment does not say which delivery it settles, so
-- invoicing on receipt would raise an invoice for goods that have not shipped.
--
-- So both settle as a DEPOSIT against the document, applied when a person
-- converts or delivers it. The customer commits with money — a better signal
-- of acceptance than a click — and the judgement step survives.
--
-- ── WHY A TABLE AND NOT ANOTHER JWT ──────────────────────────────────────
--
-- The emailed link already carries a signed 24-hour callback token, which is
-- right for an email: it is minted per send, and a dead link in an old inbox is
-- no loss. A PRINTED link is the opposite on both counts.
--
--   It must outlive the paper. An invoice sits on a desk for a month; a lay-by
--   card lives in a wallet until it is paid off. A 24-hour token printed on
--   either is a square that has never once worked by the time it is scanned.
--
--   It must be revocable. Paper cannot be recalled, so when a document is
--   cancelled the only place to stop the link is here. A JWT is valid until it
--   expires and nothing can be done about it.
--
--   It must be SHORT. A signed token is 180+ characters, which on a 58mm
--   thermal slip is a dense square that scans badly in shop lighting with a
--   supermarket phone. A slug gets the whole URL to about 34 characters.
--
-- The JWT does not go away — it still carries the ITN callback, where none of
-- the above applies. This is the entry point a human's phone touches.
-- ─────────────────────────────────────────────────────────────────────────

-- ── 1. The purposes ──────────────────────────────────────────────────────
--
-- Widened ONCE rather than a column change per feature. There are no live
-- sites yet, so this costs nothing today and three separate ALTERs later.
--
--   online_order     a storefront order            → invoicePaidOrder
--   debtor_invoice   an emailed invoice            → settlePaidInvoice
--   customer_account a STATEMENT                   → an allocated receipt
--   layby            a lay-by instalment           → laybys.takePayment
--   job_deposit      a job card deposit            → jobDeposits.takeDeposit
--   document_deposit a quote or sales order        → deposits.takeDeposit
--
-- `customer_account` is the one that is easy to get wrong: its target_id is a
-- CUSTOMER id, not a document id, because a statement is a balance rather than
-- a document. It must not be settled through settlePaidInvoice — that would
-- receipt one arbitrary invoice for the whole balance. It posts an unallocated
-- receipt and lets the ledger allocate oldest-first, which is what a payment
-- against a statement has always meant.
--
-- Quotes and sales orders SHARE `document_deposit`. Both target a
-- sales_documents id and both settle by taking a deposit; the differences
-- between them are upstream of the money, so two purposes would be two names
-- for one handler.
ALTER TABLE payment_intents
  MODIFY COLUMN purpose
    ENUM('online_order','debtor_invoice','customer_account',
         'layby','job_deposit','document_deposit')
    NOT NULL DEFAULT 'online_order';

-- ── 2. The printed link ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pay_links (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- What goes on the paper. Base58-ish and short, because this is read by a
  -- phone camera off a thermal slip and sometimes typed by hand.
  --
  -- UNIQUE, and generated from a CSPRNG rather than a sequence: this value is
  -- the entire address of a payable thing, so a guessable one would let someone
  -- walk a range of slugs and read what other people owe. Cheap to make
  -- unguessable, impossible to fix once printed.
  slug         VARCHAR(24)  NOT NULL,

  -- Mirrors payment_intents.purpose. NOT a foreign key to it, and not derived
  -- from it, because a link is minted when a document is PRINTED and an intent
  -- is created when someone actually decides to pay. One link legitimately
  -- yields many intents — a lay-by paid off in six instalments scans the same
  -- square six times.
  purpose      ENUM('debtor_invoice','customer_account',
                    'layby','job_deposit','document_deposit') NOT NULL,
  target_id    INT UNSIGNED NOT NULL,

  -- NULL means "whatever is outstanding when it is scanned", which is what
  -- almost every link wants: an invoice part-paid by EFT in the meantime must
  -- not ask for the original figure. A number here pins the amount, for the
  -- cases where the paper made a promise — a fixed deposit, say.
  amount_incl  DECIMAL(12,4) NULL,

  -- Paper outlives its usefulness. An open-ended link on a document settled
  -- years ago is a surface with no reason to exist, so every link carries a
  -- horizon; the code sets it long (a lay-by runs months) but never never.
  expires_at   DATETIME     NULL,

  -- Set when the document behind it is cancelled or voided. Checked on every
  -- resolve, so a recalled document cannot be paid from a slip already in
  -- somebody's hand. This is the column the whole table exists for.
  revoked_at   DATETIME     NULL,

  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by   VARCHAR(120) NOT NULL DEFAULT '',

  PRIMARY KEY (id),
  UNIQUE KEY uq_pay_link_slug (slug),
  -- "Does this thing already have a live link?" — asked on every print, so a
  -- reprint reuses its square instead of minting a second one for the same
  -- debt.
  KEY ix_pay_link_target (purpose, target_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
