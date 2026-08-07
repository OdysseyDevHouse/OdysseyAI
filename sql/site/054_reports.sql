-- Saved reports, favourites and schedules — the three things the report hub
-- remembers between visits.
--
-- ── WHY A SPEC IS STORED, NOT A RESULT ───────────────────────────────────
--
-- Both surfaces that compose a report were amnesiac before this:
--
--   The BUILDER (src/lib/reportBuilder) is deterministic and free to run, but
--   its spec lived in React state and died on reload. Spending ten minutes
--   composing a margin-by-department report and losing it to a refresh is the
--   fastest way to make a feature unused.
--
--   AI GENERATION (src/lib/site/askReport.ts) spends a metered Claude call to
--   turn a question into that same spec. Asking the same question next month
--   would pay for it again.
--
-- In both cases the expensive part is composing the SPEC, and the spec is
-- small JSON. So the spec is what is stored; running it is cheap, deterministic
-- and involves no AI. A saved report is re-run on open, never served from a
-- cached result — a report that shows last month's numbers because that is
-- when it was saved is worse than no report.
--
-- ── THE PERIOD TRAP ──────────────────────────────────────────────────────
--
-- A spec carries a period KEY ('lastMonth'), never resolved dates. Storing
-- 2026-07-01..2026-07-31 would freeze the report: "last month's sales" re-run
-- in December would still report on July, and nothing about the output would
-- say so. resolvePeriod() re-resolves the key on every run, including every
-- scheduled send. 'custom' is the one variant that carries literal dates, and
-- it is the only one where freezing is what the user actually asked for.
--
-- This applies with more force to AI-generated specs: Claude has no clock, so
-- it resolves "last month" to explicit dates because the query needs bounds.
-- Those dates are matched back to a named period at save time, and only stored
-- literally when they match nothing named.
--
-- ── SPEC IS TEXT, NOT JSON ───────────────────────────────────────────────
--
-- Nothing here needs the server to index or query inside the document — it is
-- read whole, parsed, and re-validated in TypeScript (validateSpec), which has
-- to happen regardless because a spec can outlive the catalog that produced
-- it. Anything the catalog no longer recognises is dropped on read, so a saved
-- report survives a field being renamed rather than failing to open.
--
-- ── PERMISSIONS ARE NEVER BAKED IN ───────────────────────────────────────
--
-- A saved report is visible to everyone at the site, with created_by kept for
-- provenance only. Every run re-checks the CALLER's own capabilities against
-- the data the spec reads (see sourcesFor / assertCanRead), so a saved report
-- can never become a way around them: a user without products.cost opening a
-- saved margin report gets the report without the cost columns, not someone
-- else's permissions.

CREATE TABLE saved_reports (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  -- 'builder' — a CustomReportSpec composed in the builder.
  -- 'ask'     — the same shape, but generated from a question. Kept distinct
  --             so the hub can show where it came from and the viewer can
  --             offer "ask a follow-up" only where that makes sense.
  kind          ENUM('builder','ask') NOT NULL DEFAULT 'builder',
  name          VARCHAR(120) NOT NULL,
  -- One line under the name on the hub. For an AI report this is seeded with
  -- the original question, which is the most useful thing it could say.
  description   VARCHAR(255) NOT NULL DEFAULT '',
  -- The CustomReportSpec as JSON. See the header for why this is TEXT.
  spec          TEXT         NOT NULL,
  -- The question that produced an 'ask' report, kept so it can be re-asked or
  -- refined. Empty for a builder report.
  question      VARCHAR(500) NOT NULL DEFAULT '',
  created_by    INT UNSIGNED NULL,
  created_by_name VARCHAR(120) NOT NULL DEFAULT '',
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  -- The hub lists most-recently-changed first.
  KEY idx_updated (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Favourites are PER USER, unlike saved reports which are per site.
--
-- "My reports" means the four this person runs every morning, not the forty
-- the business has accumulated. A shared favourites list would be a second,
-- worse copy of the catalogue.
--
-- report_id is a VARCHAR because it holds either a built-in report's string id
-- ('sales-by-product') or a saved report's numeric id prefixed with 'saved:'.
-- One column, because a favourites list is read whole and never joined — and
-- two nullable id columns with a CHECK would be a more elaborate way to say
-- the same thing.
CREATE TABLE report_favorites (
  user_id    INT UNSIGNED NOT NULL,
  report_id  VARCHAR(64)  NOT NULL,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, report_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Scheduled reports — "email me the cash-up at 18:00 every day".
--
-- A rule is a REPORT + a WHEN + a WHO. Running one needs nothing else: the
-- report id resolves through the registry (or a saved report's spec), the
-- period re-resolves through resolvePeriod(), and recipients resolve fresh out
-- of `users`. Nothing about the report's DATA is stored here — only the intent.
--
-- ── WHAT RUNS IT ─────────────────────────────────────────────────────────
--
-- A single web deployment, so /api/reports/schedules/tick is driven by one
-- external cron caller and there is no cross-machine race to arbitrate. The
-- run ledger below is kept anyway, because it is not primarily a mutex: it is
-- what makes a failed send retryable, gives the setup screen a history to
-- show, and tells "never ran" apart from "ran and failed". Its UNIQUE key
-- additionally makes a double-tick harmless, which costs nothing to keep and
-- means a second instance later is a deployment change rather than a rewrite.
CREATE TABLE report_schedules (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name          VARCHAR(120) NOT NULL,
  is_active     TINYINT(1)   NOT NULL DEFAULT 1,

  -- WHAT TO RUN. Exactly one is meaningful, chosen by report_kind:
  --   'builtin' -> report_key holds a registry id ('sales-by-product')
  --   'saved'   -> saved_report_id points at saved_reports.id
  -- Stored as a REFERENCE, never a copy of the spec: editing a saved report
  -- must change what the schedule sends, or the rule silently keeps mailing a
  -- definition nobody can see any more.
  report_kind     ENUM('builtin','saved') NOT NULL DEFAULT 'builtin',
  report_key      VARCHAR(64)  NOT NULL DEFAULT '',
  saved_report_id INT UNSIGNED NULL,

  -- WHEN THE REPORT IS ABOUT — a period key, re-resolved on every run.
  -- Defaults to yesterday because that is the only period that is complete at
  -- the time a morning send goes out.
  period_key    VARCHAR(20)  NOT NULL DEFAULT 'yesterday',
  period_from   VARCHAR(10)  NOT NULL DEFAULT '',
  period_to     VARCHAR(10)  NOT NULL DEFAULT '',

  -- WHEN IT SENDS, in the store's own wall clock.
  --   daily   — every day at send_time
  --   weekly  — on the days flagged in days_of_week, at send_time
  --   monthly — on day_of_month, clamped to the month's last day (31 fires on
  --             the 28th/29th in February)
  -- days_of_week is a 7-character Mon..Sun mask ('1111100' = weekdays).
  -- No "every N minutes": every real request is "daily at X" or "every
  -- Monday", and an interval invites "every 5 minutes", which floods a mailbox.
  frequency     ENUM('daily','weekly','monthly') NOT NULL DEFAULT 'daily',
  send_time     VARCHAR(5)   NOT NULL DEFAULT '07:00',
  days_of_week  VARCHAR(7)   NOT NULL DEFAULT '1111111',
  day_of_month  TINYINT UNSIGNED NOT NULL DEFAULT 1,

  -- WHO GETS IT. Two independent lists, unioned and de-duplicated at send:
  --   recipient_user_ids — resolved to their CURRENT email on every send.
  --     Storing the USER and not the address is the point: someone who changes
  --     their email keeps receiving, and a suspended account stops without
  --     anyone remembering which schedules they were on.
  --   recipient_emails — hand-typed addresses, stored verbatim. The
  --     bookkeeper/accountant case, where the recipient is deliberately not a
  --     system user.
  -- Comma-separated rather than a child table: a short list, always read whole
  -- with its parent, never joined and never searched.
  recipient_user_ids VARCHAR(500)  NOT NULL DEFAULT '',
  recipient_emails   VARCHAR(2000) NOT NULL DEFAULT '',

  -- WHAT TO ATTACH. A 20,000-row report makes a miserable PDF, so each is
  -- switchable. CSV is always safe; the HTML body carries the first rows so
  -- the mail is useful on a phone without opening anything.
  attach_csv    TINYINT(1)   NOT NULL DEFAULT 1,
  include_html  TINYINT(1)   NOT NULL DEFAULT 1,
  message       VARCHAR(500) NOT NULL DEFAULT '',

  -- OWNERSHIP. The user whose capabilities this rule runs under, re-checked on
  -- EVERY send. A schedule must never become a way to email data past the
  -- checks every interactive path enforces, and there is no session at 07:00 to
  -- check against. A rule whose owner has lost access is skipped and
  -- deactivated rather than run.
  owner_user_id INT UNSIGNED NULL,
  created_by    INT UNSIGNED NULL,
  created_by_name VARCHAR(120) NOT NULL DEFAULT '',
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  -- OBSERVABILITY ONLY — never the idempotency mechanism. The ledger decides
  -- whether a send happens; these exist so the setup screen can say "last sent
  -- 07:00, delivered to 3 people" without a join.
  last_run_at     DATETIME    NULL,
  last_run_status VARCHAR(20) NOT NULL DEFAULT '',
  last_run_error  VARCHAR(500) NOT NULL DEFAULT '',

  PRIMARY KEY (id),
  KEY idx_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per (rule, scheduled instant).
--
-- due_at is the SCHEDULED instant (07:00:00), never "now" — otherwise two
-- ticks a minute apart compute different keys and both send. lastDueAt() zeroes
-- seconds and walks backwards from the wall clock rather than forwards from any
-- stored state, so the value is identical no matter when the tick fires.
--
-- status: 'claimed' -> 'sent' | 'failed' | 'skipped'.
--   skipped — deliberately not sent, and WHY is in error_text: no recipients
--             resolved, the owner lost access, or the report no longer exists.
--             A skipped row still burns the claim, so the occurrence is not
--             retried forever.
--   claimed — in flight, or a process that died mid-send. A row stuck here past
--             the reclaim window is taken over.
CREATE TABLE report_schedule_runs (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  schedule_id INT UNSIGNED NOT NULL,
  due_at      DATETIME     NOT NULL,
  claimed_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status      ENUM('claimed','sent','failed','skipped') NOT NULL DEFAULT 'claimed',
  finished_at DATETIME     NULL,
  recipients  VARCHAR(500) NOT NULL DEFAULT '',
  row_count   INT UNSIGNED NOT NULL DEFAULT 0,
  attempts    SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  error_text  VARCHAR(500) NOT NULL DEFAULT '',
  PRIMARY KEY (id),
  UNIQUE KEY uq_schedule_due (schedule_id, due_at),
  KEY idx_status (status, due_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
