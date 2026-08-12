-- ─────────────────────────────────────────────────────────────────────────
-- Job cards: one record for a job, from the phone call to the invoice.
--
-- ── WHY THIS IS NOT A SALES DOCUMENT ─────────────────────────────────────
--
-- 048 argued a quote needed no new table because a quote IS a sales document,
-- and every clause of that reasoning is true of a job card too: it has a
-- customer, lines, prices, VAT and a total. So doc_type = 'job_card' looks like
-- the obvious move, and it is wrong.
--
-- Read what 048 actually claims. It enumerates EXACTLY THREE things a quote has
-- that an invoice does not, and calls those three the whole of its migration.
-- The test it applies is not "does it have lines"; it is "is the difference
-- small enough to be columns". A job card fails that test on four counts, and
-- each one is a structural impossibility rather than a column count:
--
--   ONE JOB, MANY DOCUMENTS. sales_documents gives a row exactly one
--   converted_from_id and one reverses_id. A real job is quoted, revised,
--   varied, deposit-invoiced, progress-invoiced, final-invoiced and part
--   credited. That is n quotes and m invoices, a one-to-many in both
--   directions, and the second quote revision has nowhere to point.
--
--   A STATUS THAT IS NOT status. sales_documents.status is a six-value ENUM
--   meaning where a document sits in its own POSTING life, and finaliseGuards()
--   branches on it. A job status is user-definable, so it is a foreign key into
--   a table. An FK to job_statuses on sales_documents would be NULL on 99.9% of
--   rows and every sales query would have to know why.
--
--   A JOB MUST NEVER POST, AND MUST NEVER BE CAPABLE OF IT. A quote is kept
--   unpostable by a docType check inside the posting engine: a guard, one branch
--   away from being wrong. A job card living outside sales_documents cannot be
--   handed to finaliseDocument() AT ALL, because that function takes an id from
--   a table it is not in. That is a stronger guarantee, for free. It is also
--   the argument 095 makes about reservations: 300 open jobs as draft sales
--   documents would land in the sales list, the debtors ageing, cash-up, and
--   every conversion-rate figure the quote register computes.
--
--   JOB LINES ARE NOT SALES LINES. A job carries lines that must NEVER be
--   billed and lines whose billability nobody has decided yet. A
--   sales_document_lines row deliberately not for sale is a contradiction:
--   documentMath would total it, the VAT split would include it, and
--   subtotal_excl on the header would be a number nobody wants.
--
-- So the split is:
--
--   job_cards        owns the LIFECYCLE     status, priority, owner, address
--   job_card_lines   owns the COMMERCIALS   parts, hours, km, charges, classified
--   sales_documents  owns the PAPER         quotes and invoices, linked below
--
-- sales_documents gains exactly ONE column. That is the whole touch on the
-- busiest table in the database.
--
-- ── A JOB CARD RAISES DOCUMENTS, IT NEVER BECOMES ONE ────────────────────
--
-- Billing a job creates a DRAFT sales_documents row from its billable lines and
-- a person finalises it through finaliseDocument(), which is unchanged. That is
-- deliverOrder() in salesOrders.ts, and its header says why: a second posting
-- engine is how two code paths start to disagree about what a sale is.
--
-- ── WHY service_addresses AND NOT job_sites ──────────────────────────────
--
-- The PRD calls a customer work location a "site". In this codebase siteId is
-- the TENANT, universally: siteQuery(siteId, ...), scripts/site-migrate.mjs,
-- sql/site/, src/lib/site/, cp2_sites. Every one of 137 domain modules takes it
-- first, and the defining rule of this schema is that there is NO site_id
-- column because sites are separate databases.
--
-- A customer location called a site produces job_sites.site_id, and then a
-- future migration author adds a site_id column because the word told them to.
-- That is the same reasoning stockLocations.ts uses to keep LOCATION and STORE
-- apart, and that comment is why nobody has re-broken it in 118 migrations.
-- location is taken by stock_locations; branch is taken by stores. So:
-- service_addresses. The UI may still say Site where a business uses that word.
--
-- DDL auto-commits, so every step here is re-runnable.
--
-- NOTE: no apostrophes in comments anywhere in this file. The runner sends it as
-- one multipleStatements batch, and MariaDB reads a lone ' inside a `--` comment
-- as opening a string literal, swallowing the SQL that follows.
-- ─────────────────────────────────────────────────────────────────────────

-- ── 1. Statuses ──────────────────────────────────────────────────────────
-- The workflow, owned by the business. Copied from online_order_statuses (034),
-- whose header makes the argument: how many steps there are and what each is
-- called is a property of the BUSINESS, so renaming must stay free while
-- MEANING stays findable.
--
-- Meaning is carried by `role`, not by name. A workshop calling In Progress
-- "On the bench" must be able to, and setStatus/assignOwner must still find it.
-- The PRD names New, Assigned, In Progress and On Hold as undeletable: those
-- are ROLES, and is_system is what refuses the delete.
--
-- Open versus Closed is DERIVED from the role and never stored. See
-- isClosed() in src/lib/jobStatusModel.ts. A stored column can disagree with
-- the role it duplicates, and a configurable flag would let somebody mark
-- In Progress as closed and silently empty every open-jobs figure in the app.
CREATE TABLE IF NOT EXISTS job_statuses (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- Generated from the name once, then frozen. Jobs reference the id, so a
  -- rename relabels every job sitting in the status instead of stranding it.
  code        VARCHAR(40)  NOT NULL,
  name        VARCHAR(60)  NOT NULL,

  -- A Badge tone, not a hex, so a status stays legible in both themes. The PRD
  -- also requires that status is never communicated by colour alone, which is
  -- why every render pairs the tone with the name.
  tone        ENUM('neutral','brand','success','warning','danger') NOT NULL DEFAULT 'neutral',

  -- Position in the pipeline, and the column order on a board.
  sort_order  INT          NOT NULL DEFAULT 0,

  -- '' for an ordinary step a business invented. The six below are what the
  -- code looks for. Each role is held by at most one status at a time.
  role        ENUM('','new','assigned','in_progress','on_hold','completed','cancelled')
              NOT NULL DEFAULT '',

  -- A system status cannot be deleted. The four the PRD names undeletable are
  -- seeded with this set, plus the two the lifecycle cannot work without.
  is_system   TINYINT(1)   NOT NULL DEFAULT 0,

  -- Off retires a status: gone from the pickers, but jobs already in it keep
  -- their label. Deleting one that jobs sit in is refused by the FK on
  -- job_cards.status_id below.
  is_active   TINYINT(1)   NOT NULL DEFAULT 1,

  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_jstatus_code (code),
  KEY ix_jstatus_sort (sort_order),
  KEY ix_jstatus_role (role)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A workable default pipeline. A business renames and reorders these; the roles
-- are what the code actually looks for. ON DUPLICATE KEY UPDATE code = code so a
-- re-run leaves a business own renames and reordering alone.
INSERT INTO job_statuses (code, name, tone, sort_order, role, is_system) VALUES
  ('new',         'New',           'brand',   10, 'new',         1),
  ('assigned',    'Assigned',      'brand',   20, 'assigned',    1),
  ('scheduled',   'Scheduled',     'neutral', 30, '',            0),
  ('in_progress', 'In Progress',   'warning', 40, 'in_progress', 1),
  ('on_hold',     'On Hold',       'neutral', 50, 'on_hold',     1),
  ('parts',       'Awaiting Parts','warning', 60, '',            0),
  ('completed',   'Work Completed','success', 70, 'completed',   1),
  ('cancelled',   'Cancelled',     'danger',  80, 'cancelled',   1)
ON DUPLICATE KEY UPDATE code = code;

-- ── 2. Boards ────────────────────────────────────────────────────────────
-- A board is a SAVED VIEW over statuses, and it holds no jobs.
--
-- The PRD answers this directly in its own Q&A: a job appears on more than one
-- board depending on whether its status is visible on that board. So there is
-- no job_cards.board_id, and that absence is the feature. A board FK would make
-- a job belong to exactly one board, contradicting the requirement, and would
-- let a user file a job wrongly: a job on the bench sitting on the Sales board.
--
-- Two boards naming the same status show the same job, from one row, because
-- nothing about board membership was stored.
--
-- The consequence worth naming: a job in a status that NO board lists is
-- invisible on every board. That is a real trap, so the board setup screen
-- reports it rather than the system quietly hiding work. Reports, never repairs.
CREATE TABLE IF NOT EXISTS job_boards (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name        VARCHAR(60)  NOT NULL,
  -- Used in a URL, so frozen once created for the same reason a status code is.
  slug        VARCHAR(60)  NOT NULL,
  -- How this board draws itself. Both read the same query; kanban groups into
  -- columns, grid groups into sections of a table.
  layout      ENUM('kanban','grid') NOT NULL DEFAULT 'kanban',
  sort_order  INT          NOT NULL DEFAULT 0,
  is_active   TINYINT(1)   NOT NULL DEFAULT 1,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_jboard_slug (slug),
  KEY ix_jboard_sort (sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Which statuses are a board columns, and in what order. A plain join table
-- with no job in it: this is the whole of board membership.
CREATE TABLE IF NOT EXISTS job_board_statuses (
  board_id     INT UNSIGNED NOT NULL,
  status_id    INT UNSIGNED NOT NULL,
  -- Column order on THIS board, which may differ from the pipeline order: a
  -- workshop board may want Awaiting Parts first because that is what it chases.
  column_order INT          NOT NULL DEFAULT 0,
  PRIMARY KEY (board_id, status_id),
  KEY ix_jbs_status (status_id),
  CONSTRAINT fk_jbs_board  FOREIGN KEY (board_id)  REFERENCES job_boards (id)   ON DELETE CASCADE,
  -- CASCADE: removing a status from the system removes it from the boards that
  -- listed it. Unlike a job, a board row carries no history worth keeping.
  CONSTRAINT fk_jbs_status FOREIGN KEY (status_id) REFERENCES job_statuses (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One board carrying every seeded status, so the board screen is not empty the
-- first time it is opened. INSERT IGNORE on both so a re-run does not disturb a
-- business own boards.
INSERT IGNORE INTO job_boards (id, name, slug, layout, sort_order)
VALUES (1, 'Jobs', 'jobs', 'kanban', 10);

INSERT IGNORE INTO job_board_statuses (board_id, status_id, column_order)
SELECT 1, s.id, s.sort_order FROM job_statuses s;

-- ── 3. Service addresses ─────────────────────────────────────────────────
-- Where the work happens, which is not where the invoice goes.
--
-- customers carries ONE address (012) and every document snapshots it. That is
-- the BILLING address: a managing agent in Sandton, a head office, a PO box.
-- The work is at a block of flats in Parow. A business with one address never
-- opens this screen, and is_default means a job naming no address still has one.
CREATE TABLE IF NOT EXISTS service_addresses (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- CASCADE: an address has no meaning without its customer, and deleting a
  -- customer with jobs is already refused by fk_jcard_customer below.
  customer_id     INT UNSIGNED NOT NULL,

  -- Which stock location services it. This is the branch hook, and it is
  -- deliberately the existing concept rather than a new one: 003_drop_stores
  -- settled that a STORE is a separate database and a LOCATION is a room here.
  location_id     INT UNSIGNED NULL,

  code            VARCHAR(32)  NULL,     -- the business own reference for the place
  name            VARCHAR(160) NOT NULL, -- "Unit 4, Parow Industria"

  address_line1   VARCHAR(160) NULL,
  address_line2   VARCHAR(160) NULL,
  city            VARCHAR(120) NULL,
  postal_code     VARCHAR(20)  NULL,

  -- 7 decimal places is roughly 1cm, which is far finer than any phone reports.
  -- DECIMAL and not a spatial type because nothing in this schema uses spatial
  -- indexes, and a plain pair is what a map link needs.
  latitude        DECIMAL(10,7) NULL,
  longitude       DECIMAL(10,7) NULL,

  -- Reuse the customer contact rather than re-inventing a person here. SET NULL
  -- so retiring a contact does not block deleting them.
  contact_id      INT UNSIGNED NULL,

  -- "Gate code 4471, dog on the property, park in visitor bay 3." The single
  -- most useful field on this table to somebody standing outside at 7am.
  access_notes    VARCHAR(1000) NULL,
  note            VARCHAR(400)  NULL,

  -- Exactly one per customer, enforced in code rather than by a constraint: a
  -- partial unique index is not available here, and a customer with no default
  -- is a legitimate state while the first address is being captured.
  is_default      TINYINT(1)   NOT NULL DEFAULT 0,
  is_active       TINYINT(1)   NOT NULL DEFAULT 1,

  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY ix_saddr_customer (customer_id, is_active),
  KEY ix_saddr_location (location_id),
  CONSTRAINT fk_saddr_customer FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE CASCADE,
  CONSTRAINT fk_saddr_location FOREIGN KEY (location_id) REFERENCES stock_locations (id) ON DELETE SET NULL,
  CONSTRAINT fk_saddr_contact  FOREIGN KEY (contact_id)  REFERENCES customer_contacts (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 4. The job card ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS job_cards (
  id                 INT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- Issued at CREATE, and this is the one place the module departs from the
  -- rule that a number is issued at post.
  --
  -- An invoice number waits for finalise because a draft that is abandoned must
  -- not burn a number. A job number cannot wait: it is read out to a customer
  -- on the phone within a minute of the job existing, and there is no later
  -- moment that works. So the number is allocated up front and an abandoned job
  -- leaves a permanent gap in the JC run, which verifySequence reports as
  -- missing. That is the accepted cost, and it CANNOT be changed once the first
  -- number has been issued.
  document_number    VARCHAR(32)  NULL,

  -- NULL for a walk-in, matching sales_documents. Somebody arriving at a counter
  -- with a broken kettle is a real job, and forcing an account row for them
  -- would make the debtors book a dumping ground. The snapshots below carry
  -- whatever they gave us. A job with no customer cannot be invoiced, and
  -- validateJobCard refuses that rather than the database.
  customer_id        INT UNSIGNED NULL,
  customer_code      VARCHAR(32)  NULL,   -- snapshot: renaming must not rewrite history
  customer_name      VARCHAR(160) NULL,
  customer_phone     VARCHAR(40)  NULL,
  customer_email     VARCHAR(190) NULL,

  -- Where the work happens, and which pile the parts come out of.
  service_address_id INT UNSIGNED NULL,
  location_id        INT UNSIGNED NULL,

  -- The RECORD state, which is not the workflow status below and must not be
  -- confused with it.
  --
  --   open       the job exists and is being worked, whatever stage it is at
  --   closed     finished. Set when the workflow status role becomes completed.
  --   cancelled  called off. Set when the role becomes cancelled.
  --
  -- Two columns for what looks like one fact, and the reason is verifySequence:
  -- it counts a document run as issued/live/voided and hard-codes
  -- `status = 'cancelled'` against whatever table OWN_TABLE_TYPES names. A job
  -- card allocates numbers, so it must answer that question in the same
  -- vocabulary every other numbered document uses. Deriving it from a join to
  -- job_statuses.role would work for the app and would break that one query,
  -- which is read by the numbering setup screen.
  --
  -- It is kept in step by setStatus(): the role decides this, never the user
  -- directly, so the two cannot drift apart.
  status             ENUM('open','closed','cancelled') NOT NULL DEFAULT 'open',

  -- FK into the configurable table, RESTRICT: a status holding jobs cannot be
  -- deleted out from under them, and the database says so rather than trusting
  -- every code path to remember. is_active = 0 is how a status is retired.
  status_id          INT UNSIGNED NOT NULL,

  -- An ENUM and not a table, unlike statuses. A priority has no workflow
  -- attached, no notifications of its own and no per-business vocabulary worth
  -- protecting: everybody calls the top one urgent. Four values, ordered by
  -- the ENUM itself so ORDER BY priority DESC sorts correctly.
  priority           ENUM('low','normal','high','urgent') NOT NULL DEFAULT 'normal',

  -- The one person answerable for the job. The PRD requires a single primary
  -- owner even when several people are assigned, precisely so completion and
  -- shared edits have somebody responsible. Multiple assignees arrive with
  -- appointments in a later phase; this column is the lead.
  --
  -- cp2_users.id from the CONTROL database, so no FK is possible. The name is
  -- snapshotted for the same reason as the customer.
  owner_user_id      INT UNSIGNED NULL,
  owner_name         VARCHAR(120) NOT NULL DEFAULT '',

  -- The PRD minimum for creating a job is a headline, a description and a
  -- customer. title is the headline as free text: predefined job headlines that
  -- pull in tasks, checklists and standard parts are a later phase, and a
  -- headline table now would be an empty lookup nobody can fill yet.
  title              VARCHAR(190) NOT NULL,
  description        TEXT         NULL,

  reported_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  due_at             DATETIME     NULL,
  started_at         DATETIME     NULL,
  closed_at          DATETIME     NULL,
  close_reason       VARCHAR(190) NULL,

  -- Which quote the customer actually accepted, out of however many revisions
  -- were sent. The baseline every quoted-versus-actual figure measures against.
  accepted_quote_id  INT UNSIGNED NULL,

  -- Kept for reporting, per the PRD. The values a later phase fills are already
  -- named so the enum does not need widening when the portal and public form
  -- arrive.
  source             ENUM('manual','phone','email','walk_in','internal','quote','portal','public_form')
                     NOT NULL DEFAULT 'manual',

  reference          VARCHAR(60)  NULL,   -- the customer own order number
  internal_note      VARCHAR(400) NULL,   -- never shown to a customer

  -- cancelled, never void. 026 called this void, 029 renamed it, and the lesson
  -- is worth taking first time: void is what happens to a posted document that
  -- is reversed, and a job card never posts.
  cancelled_at       DATETIME     NULL,
  cancel_reason      VARCHAR(190) NULL,

  user_id            INT UNSIGNED NULL,
  user_name          VARCHAR(120) NOT NULL DEFAULT '',

  created_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  -- The backstop, matching uq_doc_number: even if every argument in
  -- sequences.ts turned out to be wrong, the database refuses a duplicate.
  UNIQUE KEY uq_jcard_number (document_number),
  KEY ix_jcard_status (status_id, priority, id),
  -- "What is still open", which is the query the list screen and every
  -- dashboard tile opens with.
  KEY ix_jcard_state (status, priority, id),
  KEY ix_jcard_customer (customer_id, reported_at),
  KEY ix_jcard_owner (owner_user_id, status),
  KEY ix_jcard_reported (reported_at, id),
  KEY ix_jcard_due (due_at),
  KEY ix_jcard_address (service_address_id),
  -- RESTRICT on both, matching sales_documents: a customer or a status with job
  -- history is not deletable.
  CONSTRAINT fk_jcard_customer FOREIGN KEY (customer_id)  REFERENCES customers (id)    ON DELETE RESTRICT,
  CONSTRAINT fk_jcard_status   FOREIGN KEY (status_id)    REFERENCES job_statuses (id) ON DELETE RESTRICT,
  -- SET NULL: an address may be retired while the job it served is history.
  CONSTRAINT fk_jcard_address  FOREIGN KEY (service_address_id) REFERENCES service_addresses (id) ON DELETE SET NULL,
  CONSTRAINT fk_jcard_location FOREIGN KEY (location_id)  REFERENCES stock_locations (id) ON DELETE SET NULL,
  CONSTRAINT fk_jcard_quote    FOREIGN KEY (accepted_quote_id) REFERENCES sales_documents (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 5. What the job cost, and who pays for it ────────────────────────────
-- The hardest requirement in the PRD, and the reason job lines are not sales
-- lines.
--
-- ── WHY ONE ENUM AND NOT SIX FLAGS ───────────────────────────────────────
--
-- Six booleans give 64 combinations of which about seven are legal, and nothing
-- stops a row being both written off and invoiced. Six tables give six copies
-- of the parts picker. One column, and the illegal states cannot be spelled.
--
-- ── WHY invoiced IS NOT ONE OF THE VALUES ────────────────────────────────
--
-- A line is a variation AND invoiced. Folding invoiced into the same enum
-- destroys the fact that made it billable, so "what did we charge as
-- variations" becomes unanswerable the moment the invoice goes out.
--
-- Worse, a stored invoiced flag DRIFTS. When an invoice is voided or credited,
-- salesReversal.ts does not know to unset it, and nothing reconciles the two.
-- So billing_state answers SHOULD this be charged, and invoiced_doc_id answers
-- HAS it been. The invoicing worklist is one indexed predicate:
--
--   billing_state IN ('quoted','variation','additional') AND invoiced_qty < qty
--
-- ── HOW PROFITABILITY AVOIDS DOUBLE COUNTING ─────────────────────────────
--
-- The feared double count is a quoted part that was also consumed. It cannot
-- happen: a part is ONE row whose billing_state changes. Never two rows. What
-- was quoted and what it cost are the same line read through two columns.
--
--   cost    = Sigma qty * unit_cost_excl  over ALL lines, including internal
--             and written_off
--   revenue = read off the INVOICE, for lines carrying an invoiced_doc_id
--
-- Revenue is deliberately NOT the sum of unit_price_incl. That figure is an
-- INTENTION; the invoice, after documentMath has applied discounts and split
-- the VAT, is what the customer owes. A profitability report built on
-- intentions and a sales report built on invoices would disagree, and the sales
-- report is right.
--
-- What falls out for free: internal and written_off lines carry cost and no
-- revenue, so they are in the cost sum and out of the revenue sum with no
-- special case anywhere. That is the whole requirement.
CREATE TABLE IF NOT EXISTS job_card_lines (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  job_card_id     INT UNSIGNED NOT NULL,
  line_number     SMALLINT UNSIGNED NOT NULL DEFAULT 1,

  --   part    something off the shelf, or bought in for the job
  --   labour  time, priced by the hour. qty is hours.
  --   travel  distance. qty is kilometres.
  --   charge  a fixed fee: callout, disposal, subcontractor invoice
  line_kind       ENUM('part','labour','travel','charge') NOT NULL DEFAULT 'part',

  --   quoted       on the accepted quote. The baseline.
  --   variation    extra work the customer approved. Billable, and not quoted.
  --   additional   extra work done and billable, with no separate approval.
  --   internal     our cost, never billable. Rework, goodwill, warranty.
  --   pending      the cost is real and nobody has decided who pays.
  --   written_off  was billable, and a decision was taken not to charge it.
  --
  -- pending is the default because a technician recording what they used should
  -- not have to make a commercial decision to do it. The PRD is explicit that a
  -- technician may record usage without seeing or setting any money, and an
  -- authorised user classifies it later.
  billing_state   ENUM('quoted','variation','additional','internal','pending','written_off')
                  NOT NULL DEFAULT 'pending',

  -- NULL for a free-text charge, matching sales_document_lines: a subcontractor
  -- invoice is a real cost with no product behind it.
  product_id      INT UNSIGNED NULL,
  product_code    VARCHAR(40)  NULL,     -- snapshot, like every document line
  description     VARCHAR(190) NOT NULL,

  -- Hours on a labour line, kilometres on a travel line, units on a part.
  qty             DECIMAL(12,3) NOT NULL DEFAULT 0.000,

  -- What it cost US. Snapshotted at capture so next year rate increase does not
  -- restate last year profitability.
  unit_cost_excl  DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  -- What we WOULD charge. VAT-inclusive, matching the money convention in 015.
  -- An intention, not revenue: see the header above.
  unit_price_incl DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  -- Snapshotted so a rate change does not restate an old job.
  vat_rate_pct    DECIMAL(6,3)  NOT NULL DEFAULT 0.000,
  discount_pct    DECIMAL(6,3)  NOT NULL DEFAULT 0.000,

  -- Deliberately NO line_total columns. documentMath owns money arithmetic and
  -- runs once, on the invoice. Totals here would be a second place a rounding
  -- rule is applied, and one of them would not be updated: the exact cost 048
  -- names for a parallel quote table.

  -- The quoted line a variation supersedes, so "what changed against the quote"
  -- is walkable in both directions.
  source_line_id  INT UNSIGNED NULL,

  -- HAS it been billed, as opposed to should it be. Partial invoicing is normal
  -- on a long job, which is why this is a quantity and not a flag.
  invoiced_doc_id INT UNSIGNED NULL,
  invoiced_qty    DECIMAL(12,3) NOT NULL DEFAULT 0.000,

  -- Filled by later phases, declared now because they cannot be backfilled.
  -- movement_id is the stock_movements row that issued a part (phase 7),
  -- time_entry_id the staff_time_entries row behind a labour line (phase 5),
  -- travel_id the job_card_travel row behind a travel line (phase 6).
  movement_id     BIGINT UNSIGNED NULL,
  time_entry_id   INT UNSIGNED NULL,
  travel_id       INT UNSIGNED NULL,

  -- Why this line left pending. A write-off with no reason is the thing an owner
  -- queries first, so the reason is captured with the decision rather than
  -- reconstructed from the activity log.
  decided_by_user_id INT UNSIGNED NULL,
  decided_at         DATETIME     NULL,
  decided_reason     VARCHAR(190) NULL,

  note            VARCHAR(190) NULL,

  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY ix_jcl_job (job_card_id, line_number),
  -- The costing tab, and the invoicing worklist.
  KEY ix_jcl_state (job_card_id, billing_state),
  KEY ix_jcl_invoiced (invoiced_doc_id),
  KEY ix_jcl_product (product_id),
  -- Deliberately NO unique key on (job_card_id, product_id), unlike
  -- stock_adjustment_lines. Two cable ties fitted on Monday and three more on
  -- Thursday are two legitimate lines, and one of them may be billable while
  -- the other is warranty. Uniqueness there would force a single row and lose
  -- the classification.
  CONSTRAINT fk_jcl_job      FOREIGN KEY (job_card_id) REFERENCES job_cards (id) ON DELETE CASCADE,
  -- RESTRICT, matching stock_movements and stock_adjustment_lines: a product
  -- used on a job has history, and deleteProduct already archives on reference.
  CONSTRAINT fk_jcl_product  FOREIGN KEY (product_id)  REFERENCES products (id)  ON DELETE RESTRICT,
  CONSTRAINT fk_jcl_source   FOREIGN KEY (source_line_id)  REFERENCES job_card_lines (id) ON DELETE SET NULL,
  -- SET NULL, not RESTRICT: discarding a draft invoice must not be blocked by
  -- the job lines it was raised from. They simply become uninvoiced again, and
  -- releaseLines resets invoiced_qty in the same transaction.
  CONSTRAINT fk_jcl_invoice  FOREIGN KEY (invoiced_doc_id) REFERENCES sales_documents (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 6. The one column on sales_documents ─────────────────────────────────
-- Which job produced this quote or invoice. NULL on everything the till rings
-- up, which is almost all of them.
--
-- This is what makes "show me every document this job produced" one indexed
-- read, and it is the whole of the coupling: a job card is not a doc_type, and
-- nothing here widens the doc_type enum.
-- Note the MariaDB form: `ADD FOREIGN KEY IF NOT EXISTS <name> (cols)`. It does
-- NOT accept `ADD CONSTRAINT IF NOT EXISTS <name> FOREIGN KEY` — the guard
-- belongs to the FOREIGN KEY clause, not to CONSTRAINT. Same note as 025 and
-- 027, which found this the hard way.
ALTER TABLE sales_documents
  ADD COLUMN IF NOT EXISTS job_card_id INT UNSIGNED NULL AFTER converted_from_id,
  ADD KEY IF NOT EXISTS ix_sdoc_job (job_card_id, doc_type),
  -- SET NULL: deleting a job card is not something the app offers, but if it
  -- ever does, a finalised invoice must survive it. An invoice is a tax
  -- document and outlives the operational record that raised it.
  ADD FOREIGN KEY IF NOT EXISTS fk_sdoc_job (job_card_id) REFERENCES job_cards (id) ON DELETE SET NULL;

-- Which job line this invoice line came from.
--
-- Without it, giving quantities back when a draft is discarded has to match
-- lines by DESCRIPTION, and two lines reading "Replace capacitor" would both be
-- reset by one of them. The result is a line that claims to have been billed
-- with nothing to show for it, and it never appears on the worklist again.
--
-- This is the same both-directions link stock_adjustment_lines.movement_id and
-- stock_take_lines.movement_id already carry, for the same reason: an id is the
-- only thing that identifies a row.
--
-- SET NULL rather than CASCADE: an invoice line is part of a tax document and
-- must survive the operational record it was raised from.
ALTER TABLE sales_document_lines
  ADD COLUMN IF NOT EXISTS job_card_line_id INT UNSIGNED NULL AFTER product_id,
  ADD KEY IF NOT EXISTS ix_sdline_job_line (job_card_line_id),
  ADD FOREIGN KEY IF NOT EXISTS fk_sdline_job_line (job_card_line_id)
    REFERENCES job_card_lines (id) ON DELETE SET NULL;

-- ── 7. The one column on staff_time_entries ──────────────────────────────
-- Which job this stretch of time was worked on.
--
-- 054 wrote a long header arguing itself out of reusing shifts, and every one
-- of those arguments runs the OTHER way here: staff_time_entries is already
-- per-person rather than per-terminal, already covers people who never touch a
-- till, already carries the correction audit trail a labour dispute needs, and
-- already feeds timesheets.ts and staff_pay_periods. A separate
-- job_time_entries table would put a technician Tuesday in two places and make
-- the payroll total a UNION, which is the exact failure 054 exists to prevent.
--
-- Nullable, because the overwhelming majority of clock-ins are not against a
-- job and every existing row stays correct with no backfill.
--
-- The column ships now and is written in phase 5. It costs nothing today and
-- cannot be added meaningfully later: the same argument 015 makes for
-- terminal_id.
--
-- The dividend was unplanned for. uq_open_entry (open_user_id) is a generated
-- column holding the user id while an entry is open and NULLing on close, so
-- the DATABASE already refuses a second concurrent entry for one person. The
-- PRD asks for exactly that rule and it is already enforced.
ALTER TABLE staff_time_entries
  ADD COLUMN IF NOT EXISTS job_card_id INT UNSIGNED NULL AFTER shift_id,
  ADD KEY IF NOT EXISTS ix_time_job (job_card_id, started_at),
  ADD FOREIGN KEY IF NOT EXISTS fk_time_job (job_card_id) REFERENCES job_cards (id) ON DELETE SET NULL;

-- ── 8. Numbering ─────────────────────────────────────────────────────────
-- INSERT IGNORE so a site that already has the row keeps its own prefix and
-- next number rather than being reset to 1 on a re-run.
--
-- OWN_TABLE_TYPES in src/lib/site/sequences.ts must also name job_card against
-- job_cards. Without that entry the type defaults to sales_documents, finds
-- none of its numbers there, and verifySequence reports every JC ever issued as
-- missing. Both previous module plans predicted this omission and both builds
-- made it.
INSERT IGNORE INTO document_sequences (doc_type, prefix, next_number, padding, reset_period)
VALUES ('job_card', 'JC', 1, 6, 'none');

-- ── 9. Settings ──────────────────────────────────────────────────────────
-- Single scalars a business changes and nothing joins to, which is exactly what
-- the settings table is for per its own header.
--
-- The two product ids matter more than they look: labour and travel are billed
-- through ordinary product rows of product_type = 'service', which already
-- exists and carries no stock. That is what lets a labour line reach the invoice
-- through the same path as a part, with no special case in documentMath.
INSERT INTO settings (setting_key, setting_value)
VALUES ('job_default_priority', 'normal')
ON DUPLICATE KEY UPDATE setting_key = setting_key;

INSERT INTO settings (setting_key, setting_value)
VALUES ('job_labour_product_id', '')
ON DUPLICATE KEY UPDATE setting_key = setting_key;

INSERT INTO settings (setting_key, setting_value)
VALUES ('job_travel_product_id', '')
ON DUPLICATE KEY UPDATE setting_key = setting_key;

-- Blank rather than a guessed number: a rate somebody has not set must read as
-- unset, not as R0.00 per kilometre quietly billing nothing.
INSERT INTO settings (setting_key, setting_value)
VALUES ('job_travel_rate_per_km', '')
ON DUPLICATE KEY UPDATE setting_key = setting_key;
