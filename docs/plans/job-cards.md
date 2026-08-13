# Job cards — one record for a job, from the phone call to the invoice

> **Phases 1–6 are built.** Migrations `104_job_cards.sql`,
> `105_quote_acceptance.sql`, `106_job_appointments.sql`, `107_job_travel.sql`,
> `108_travel_return_leg.sql` — phases 2 and 5 needed none at all, which is the
> clearest evidence the reuse decisions were right.
> `npm run test:job-cards` covers all six (222 checks). Phases 7–9 below are
> named, sized and sequenced; the notes record what was decided and why.

## Where this starts

The slot was pre-cut, and unusually for this repo it was pre-cut with an
apology. `src/lib/nav.ts` carried no entry, only a gravestone:

> *Job Cards was an empty section rendering "Not built yet" — a promise the menu
> could not keep, costing a permanent row. It comes back when it has a route.*

That set the bar for phase 1: not a schema and not a settings screen, but **a
route that runs a job end to end and bills it**. The comment is now replaced by
a real section.

The source is a 79-page PRD (`Odyssey AI Job Card Project v1.pdf`). It is not a
module — it is three or four products wearing one nav entry: a work-order
system, a scheduling product, a workflow-automation platform, and an offline
mobile client. Measured against this codebase it is roughly **2–4× the largest
existing module** (`online-store`, ~12,700 lines of screens). So this document
is a programme, and the most valuable thing in it is the record of what was
deliberately **not** built.

## What already exists, and was reused

Phase 1 writes almost no new arithmetic.

| Need | Already in the repo |
|---|---|
| Customer, lines, prices, VAT, totals | `sales_documents` + `sales_document_lines` — `015_sales_core.sql:161` |
| The only posting engine | `finaliseDocument()` — `salesPosting.ts` |
| A non-posting doc type, done right | `048_quotes.sql` — zero new tables |
| Raising a linked draft instead of a second engine | `deliverOrder()` — `salesOrders.ts:240` |
| Line money arithmetic | `lineTotals()` — `documentMath.ts:70` |
| Configurable statuses with findable meaning | `orderStatusModel.ts` + `online_order_statuses` (`034`) |
| Customer type-ahead | `searchCustomersForTill()` — `tillCustomers.ts` |
| One open timer per person, enforced by the database | `uq_open_entry` — `054_staff_time.sql:88` |
| Attachments with no new table | `party_documents` + `attachmentTargets.ts` |
| Who did what | `activity_log` + `activityLog.ts` |
| Numbering, transaction-scoped | `nextDocumentNumber()` — `sequences.ts:145` |
| Permission keys, single source | `CAPABILITY_GROUPS` — `permissions.ts:36` |
| Labour and callout charges | `product_type = 'service'` — `productTypes.ts` |

**The two modules imitated throughout are quotes and sales orders**, because
between them they demonstrate the two moves this needed: add columns rather than
a parallel table, and raise a linked draft rather than write a second posting
engine.

---

## The seven decisions that shape everything else

### 1. A job card is its own table; its quotes and invoices stay `sales_documents` rows

`048_quotes.sql` argues a quote needed no new table because *"a quote IS a sales
document"*, and every clause is true of a job card too. But read what it
actually claims: it enumerates **exactly three** things a quote has that an
invoice does not and calls those *"the whole of this migration"*. The test is
not "does it have lines"; it is **"is the difference small enough to be
columns"**. A job card fails on four counts, each structural:

- **One job, many documents.** `sales_documents` gives one `converted_from_id`.
  A real job has *n* quotes and *m* invoices — the second quote revision has
  nowhere to point.
- **A status that is not `status`.** That column is a six-value ENUM meaning
  where a document sits in its *posting* life, branched on by `finaliseGuards()`.
  A job status is an FK into a configurable table.
- **A job must never post, and must never be *capable* of it.** Living outside
  `sales_documents` means `finaliseDocument()` cannot be handed one — a stronger
  guarantee than a guard, for free. 300 open jobs as draft sales documents would
  land in the sales list, the debtors ageing and every conversion-rate figure.
- **Job lines are not sales lines.** A job carries lines that must never be
  billed and lines whose billability is undecided. A `sales_document_lines` row
  deliberately not for sale is a contradiction — `documentMath` would total it.

```
job_cards            owns the LIFECYCLE     status, priority, owner, address
job_card_lines       owns the COMMERCIALS   parts, hours, km, charges, classified
sales_documents      owns the PAPER         quotes and invoices, linked by job_card_id
```

`sales_documents` gained exactly **one** column. `sales_document_lines` gained
one more (`job_card_line_id`) so a discarded draft returns its quantity to the
right line rather than matching on description.

### 2. Lines are classified by billing state; `invoiced` is a fact, not a state

```sql
billing_state ENUM('quoted','variation','additional','internal','pending','written_off')
```

**`invoiced` is deliberately not in that list.** A line is `variation` *and*
invoiced; folding the two destroys the fact that made it billable. Worse, a
stored flag **drifts** — when an invoice is voided or credited, `salesReversal.ts`
does not know to unset it. So `billing_state` answers *should this be charged*
and `invoiced_doc_id` / `invoiced_qty` answer *has it been*.

Revenue is read **off the invoice**, never off the line's intended price. A job
line's `unit_price_incl` is an intention; the invoice, after `documentMath` has
applied discounts and split the VAT, is what the customer owes. Cost sums
**every** line including `internal` and `written_off`, so those land in cost and
out of revenue with no special case. Proved by `(J2)` in the test suite: a job
that gave away a R4,200 warranty part reports a R3,010 loss, and revenue matches
the invoice to the cent.

### 3. A job card raises documents; it never becomes one

`invoiceJob()` creates a **draft** and stops. A person finalises it through the
one posting engine. This is `deliverOrder()` in structure and justification.
`finaliseGuards()` was not touched — there is no `job_card` doc_type to guard.

### 4. Statuses are rows with roles; boards are saved views over them

`job_statuses` copies `online_order_statuses`, with `role` carrying the meaning
so a workshop renaming "In Progress" to "On the bench" stays free to. The PRD's
four undeletable statuses are **roles**, and `is_system` refuses the delete.

Open/Closed is **derived from the role**, never stored and never configurable —
a configurable flag would let somebody mark In Progress as closed and silently
empty every open-jobs figure in the app. There is one concession: a `status`
ENUM column on `job_cards`, because `verifySequence` hard-codes
`status = 'cancelled'` against whatever table `OWN_TABLE_TYPES` names, and a job
card allocates numbers. `setStatus()` derives it from the role and is the only
writer, so the two cannot drift — proved by `(J5)`.

Board membership is derived from status: **no `job_cards.board_id`**, per the
PRD's own answer that a job appears on more than one board.

### 5. `service_addresses`, never `site`

`siteId` is the tenant in all 137 domain modules and the schema's rule is *no
`site_id` column*. A customer location called a "site" produces
`job_sites.site_id` and a permanent class of bug. UI copy may still say "Site".

### 6. Time reuses `staff_time_entries`; travel gets four figures

`054`'s header argues itself out of reusing `shifts`, and every argument runs the
other way here. The column ships now (nullable, no backfill) and is written in
phase 5. The dividend was unplanned-for: `uq_open_entry` **already** enforces one
active timer per technician at database level, which is what the PRD asks for.

### 7. Assets are customer-owned; `fixed_assets` is not them

`046_fixed_assets.sql` is a depreciation register — things the business owns and
must write down. A customer's air conditioner is neither. Phase 7+.

---

## What phase 1 shipped

**Migration** `sql/site/104_job_cards.sql` — `job_statuses` (8 seeded, 6 system),
`job_boards` + `job_board_statuses` (one board seeded with every status),
`service_addresses`, `job_cards`, `job_card_lines`, the two `sales_documents`
columns, `staff_time_entries.job_card_id`, the `JC` sequence, four settings.
Applied to site 1 and verified idempotent on re-run.

**Data layer** — `src/lib/jobStatusModel.ts` (pure, browser-safe: the form runs
the same validator without dragging mysql2 into the bundle),
`src/lib/site/{jobCards,jobStatuses,jobInvoicing,serviceAddresses}.ts`.

**Registrations** — `CAPABILITY_GROUPS` gained a `jobs` group of ten keys
(`view`/`view_own`/`edit`/`assign`/`close`/`invoice`/`bill_decide`/`cost`/`setup`);
`ActivityEntity` gained `job_card`; `ATTACHMENT_TARGETS` gained `job_card`;
`OWN_TABLE_TYPES` gained `job_card: 'job_cards'` (the omission both prior plans
predicted and both prior builds made); `DOC_LABELS`; `SETTING_DEFAULTS`;
`nav.ts` NAV + `LEAF_LABELS`; `icons.tsx` gained `Wrench`; the smoke crawl gained
a `/jobs/[id]` id source preferring a job with lines.

**Screens** — `/jobs` (list, tiles, filters, URL-held state), `/jobs/new`,
`/jobs/[id]` (one scrolling page), `/jobs/[id]/edit`, `actions.ts`.

**Deliberately ugly, and why** — one scrolling detail page rather than eight
tabs (tabs answer a page that is too long; nobody had seen this page with real
data). A date field rather than a calendar (no calendar component exists in the
kit). No board, no dashboards, no notifications, no SLA arithmetic.

### Verified

`npm run test:job-cards` — 78 checks, all passing, proving seven invariants:
a job never posts · cost counts everything and revenue comes off the invoice ·
`invoiced_qty` never exceeds `qty` across part invoices · only billable states
reach an invoice · the record state always agrees with the status role · a
required role always has a holder and a system status cannot be deleted or
switched off · discarding a draft returns exactly what it took.

`tsc --noEmit` clean · `next build` green (all four routes) ·
`check-ui-kit.mjs` clean on every screen · `test:navigation` passes (the
remaining `/sales` finding is pre-existing) · smoke crawl 4/4 ·
`posting`/`invoicing`/`quotes`/`sales-orders`/`void`/`sequences`/`attachments`
all pass with no regressions.

---

## What phase 2 shipped

**No migration.** Everything the board needed already existed — `job_boards` and
`job_board_statuses` were seeded by 104, and board membership is derived. That a
whole phase landed without touching the schema is the clearest evidence decision
4 was right.

**Data layer** — `src/lib/site/jobBoards.ts`: `listJobBoards`, `getJobBoard`,
`defaultJobBoard`, `boardColumns`, `saveJobBoard`, `deleteJobBoard`,
`statusesOffEveryBoard`, pure `validateJobBoard`.

`boardColumns` is two reads for the whole board, not one per column: a
`ROW_NUMBER() OVER (PARTITION BY status_id)` caps each column independently, so
one busy column cannot starve the others of cards, and a separate count query
supplies the `+ N more not shown` line. Silent truncation reads as "that is all
of them".

**Screens** — `/jobs/board` (redirects to the first board so the URL always names
which one is on screen), `/jobs/board/[slug]` (the kanban),
`/setup/job-workflow` (stages + boards, with both warnings).

**The detail page split into four tabs** — Overview / Costs / Files / History,
held in the URL. The PRD's other four proposals are not tabs: Customer is a link,
Assets belong to the customer, a Visit is a screen of its own, and Time folded
into Costs because labour time *is* a cost line. The warnings stay **above** the
tab bar — a cancelled job or an undecided cost is true of the whole record, and
hiding it behind a tab means somebody works a job for ten minutes before finding
out.

**Files came almost free.** `AttachmentsPanel` + the `job_card` entry in
`ATTACHMENT_TARGETS` from phase 1 gave the upload path, the download route and the
permission derivation with no new code.

### Two decisions worth recording

**`pointerWithin`, not `closestCorners`.** `closestCorners` always answers with
something — it ranks every droppable by distance and returns the nearest, however
far away the pointer is. That is right for reordering a list and wrong for a
kanban card, because picking a card up and putting it back down is how everybody
cancels a drag. With `closestCorners` the release still resolves to the nearest
column, so a job silently changes status with an audit entry saying somebody meant
it. The Builder made this same call for the same reason (`Builder.tsx:167`); a
status change is less recoverable than a page section, so the strictness belongs
here more.

**The drag is not a lighter path than the dropdown.** `moveCardAction` calls the
same `setStatus()` the status field calls, so the same refusals apply — proved by
driving it: dragging JC000010 (one pending line) onto Work Completed refuses with
*"1 line is still awaiting a billing decision"* and the card springs back. A board
that bypassed that would be the way around every guard on the job screen.

### Three bugs phase 2 surfaced

1. **`Checkbox` takes `label`, not children.** Passing children spread them onto
   the native `<input>`, which is a void element — a 500 on `/setup/job-workflow`
   reading *"input is a void element tag"*. `check-ui-kit.mjs` cannot catch this:
   it is an API misuse, not a token violation.
2. **`DndContext` and `DragOverlay` cannot render during SSR.** Both mount
   browser-only machinery (a portal, live-regions with generated ids) with no
   server equivalent, and React reports the whole page as a hydration mismatch
   rather than the one node. Fixed by rendering the plain grid first and mounting
   the drag machinery in an effect — the first paint is a working board with every
   link live, and dragging arrives a frame later.
3. **`Date.now()` in a rendered component.** Lateness compared against the
   current time differs between the server render and the client hydration for any
   card near its due moment. Moved into an effect, so only the client ever
   computes it.

Also fixed on the way past: `LEAF_LABELS` labelled every board "Edit", because
`/jobs/board/[slug]` is not a detail route — the segment names *which* board. The
crumb builder now drops a leaf that merely repeats its parent, the same way it
already dropped a child crumb repeating its section.

### Verified

`npm run test:job-cards` — **93 checks**, all passing, adding `(J8)`: a board
holds no jobs, one job appears on every board showing its stage, and a status on
no board hides its jobs from every board (reported, never repaired).

`tsc --noEmit` clean · `next build` green (7 routes) · `check-ui-kit.mjs` clean ·
smoke crawl **7/7** · `posting`/`invoicing`/`quotes`/`sales-orders` all pass.
`test:navigation` still shows the same 3 findings it shows on a clean checkout —
verified by stashing the nav changes and re-running.

---

## What phase 3 shipped

**Migration** `sql/site/105_quote_acceptance.sql` — six columns on
`sales_documents`, no new tables.

The gap it fills is real and was not obvious: **`quotes.ts` has no
`acceptQuote()`**. `quote_outcome = 'accepted'` is set in exactly one place,
inside `convertToInvoice()`, as a side effect of raising the invoice. That works
at a counter where accepting and invoicing are one moment, and breaks on a job
where a customer accepts on Tuesday, work happens Wednesday and Thursday, and the
invoice goes out the following week. In between, the business needs to know the
work was authorised — that is the whole basis for having sent anybody out.

**Data layer** — `src/lib/site/jobQuotes.ts`: `jobQuotes`, `quoteJob`,
`acceptQuote`, `declineJobQuote`, `quoteVariance`, `workBlockedReason`.

**Screens** — a fifth tab, Quotes, with the version chain, the acceptance
evidence, and the quoted-versus-actual panel. Two dialogs: record an acceptance
(method, who, evidence) and record a decline (reason required).

### The decisions

**A revision is a new document, and `supersedes_id` is not `converted_from_id`.**
The PRD is emphatic that amending an accepted quote creates a new version and
never silently overwrites the old one. `converted_from_id` already means *the
document this was raised from* and is how a quote points at its invoice; a
revision is the opposite direction between two quotes. Sharing the column would
make "what did we originally offer" and "what did this become" the same question.

**A new version un-accepts the JOB.** `accepted_quote_id` is cleared the moment
v2 exists, so the job never claims authorisation for a price nobody agreed to.
Two guards follow: an already-accepted version cannot be accepted twice, and an
*open but superseded* version cannot be accepted at all — which is how somebody
answering a stale email after a revised quote went out is caught.

**The method is stored, not just the fact.** `verbal` / `internal` / `in_person`
/ `email` / `link` are five different strengths of evidence, and a dispute turns
on which was used. `quote_accepted_by` (the customer, free text — often a tenant
or site foreman not on file) is kept apart from `quote_accepted_by_user_id` (the
staff member who recorded it), because on an internal acceptance the second is the
only name there is and the audit trail must say so.

**Accepting rebases the covered lines to `quoted`.** Matched by
`job_card_line_id`, so two lines reading the same are two lines. Only `pending`
and `additional` move — a line already `internal` is a cost the business chose to
absorb, and appearing on a quote does not undo that decision. `BILLING_TRANSITIONS`
refuses the same move by hand.

**`quoteVariance()` re-derives from the lines, not the invoice.** It answers *has
the job grown past what we agreed*, which is a question about scope that must be
answerable **before** anything is invoiced. What was actually billed is
`jobTotals().invoiced`, and that reads the invoice. Two different questions, two
different sources.

**The work gate is off by default.** `job_require_quote_acceptance` exists for
businesses that genuinely gate work on a signature. The commonest real case is a
technician already on site finding a second fault, and refusing outright would
strand them.

### Deliberately not built

**The public approval link.** `quote_accept_method = 'link'` is recordable today
(a user ticks it when the customer clicked one), but no route mints or receives
such a link. `orderTrackToken.ts` is the pattern, and its header draws the line
this needs care with: that token is *"sight, not control"* — holding it shows an
order and cannot change anything. Acceptance **is** control, so it needs its own
audience, its own expiry, and a one-shot property that token deliberately lacks.
Phase 4 or later, with the customer portal.

### Verified

`npm run test:job-cards` — **128 checks**, all passing, adding 25 under `(J9)`.
The one worth naming: the superseded guard is tested on a version that is *not*
already accepted (by raising a third), because accepting v1 again hits the
already-accepted refusal first and would have proved nothing.

`tsc` clean · `next build` green · `check-ui-kit.mjs` clean · smoke crawl 6/6 ·
`quotes`/`posting`/`invoicing`/`sales-orders`/`void`/`sequences` all pass. That
`test:quotes` still passes matters: job quotes are `doc_type='quote'` rows sharing
every query in that module.

One trap re-encountered: `ACCEPT_METHODS` and its labels had to move into
`jobStatusModel.ts`, because the acceptance dialog is a client component and
importing them from the `server-only` module would drag mysql2 into the browser
bundle — the same split, for the same reason, as `validateJobCardFields`.

---

## What phase 4 shipped

**Migration** `sql/site/106_job_appointments.sql` — `job_card_appointments` and
`job_appointment_assignees`, plus four settings.

**Data layer** — `src/lib/site/jobAppointments.ts`: `jobAppointments`,
`appointmentsOn`, `findConflicts`, `saveAppointment`, `setAppointmentStatus`,
`deleteAppointment`, `unscheduledJobCount`, `unscheduledJobIds`.

**Screens** — a Visits tab (sixth), and `/jobs/schedule`: the day drawn as one
lane per technician. The Unscheduled tile lands on both the job list and the
schedule.

### The decisions

**Appointment status is a fixed ENUM, unlike job status.** Job statuses are a
configurable table because how many stages a business has and what it calls them
is genuinely local. These seven describe whether somebody has left yet, is
driving, has arrived, or did not turn up — not a matter of vocabulary. A
configurable version would also break the rule the column exists for: the PRD
requires that a cancelled or completed appointment must **not** make a job count
as scheduled, and that cannot survive a business inventing a status the code has
never seen.

**Unscheduled is derived.** An open job with no live *future* appointment.
`LIVE_APPOINTMENT` is one SQL string every such query shares, the same move
`stockHolds.ts` makes with `LIVE_HOLD` and for the same reason — three queries
spelling the rule three ways is how one comes to disagree.

**Conflicts warn; they do not refuse.** Five kinds: overlap, travel gap, approved
leave, outside hours, closed job. `saveAppointment` returns them and the dialog
offers an override with a required reason, stored on the row and in the activity
log. That is the PRD's own answer and the right one — a dispatcher double-booking
somebody because two jobs are next door knows something the scheduler does not,
and a hard refusal makes them book a fake job instead.

**Only approved leave counts.** An unsigned request is not yet a fact about the
day, and warning on it trains dispatchers to ignore warnings — the failure mode
that makes a conflict checker worthless. The leave query is wrapped defensively
so a site that has not run migration 058 can still book a visit, the same
tolerance `reservedQtyFor` applies to online holds.

**A day view, not a week.** A day-by-technician grid answers what a dispatcher
opens the screen for — who is free this afternoon, who is double-booked — with
lanes wide enough to read a name in. The same data across seven days is illegible
slivers unless it collapses to one row per person per day, which answers a
different question and wants a different layout. Building the wrong one first is
how a screen serves neither.

**A CSS grid, not absolute positioning.** A block is `grid-column: start / span n`
and the browser lays it out. Overlapping visits land on two grid *rows* within the
lane, so the lane grows and a deliberate double-booking is visible as two stacked
bars rather than one block hidden under another. Since overrides mean overlaps
exist on purpose, stacking is the honest rendering.

**A visit spanning two people appears in both lanes.** From one row — the question
a lane answers is "what is this person doing", and omitting somebody because they
were the second name would make their afternoon look free.

### The bug that cost the most

**`String(driverDate)` is a locale string, and the obvious fix yields NaN.**

mysql2 returns a `Date`; `String()` on it gives
`'Wed Aug 12 2026 10:00:00 GMT+0200 (South Africa Standard Time)'`. The natural
repair — `new Date(v.replace(' ','T') + 'Z')` — is unparseable because the locale
form already carries an offset, so it returns **NaN**. Every comparison against
NaN is false, so nothing threw: conflict detection reported zero clashes while its
SQL was returning the clashing row, and the schedule drew every block at the far
right edge.

Fixed in three places at once: a `wallClock()` mapper in `jobCards.ts`,
`jobQuotes.ts` and `jobAppointments.ts` (the helper already existed in
`reservations.ts` for exactly this reason), and `storedMillis()` / `storedDate()`
in `jobStatusModel.ts` for the seven client call sites that had each hand-rolled
the same broken parse.

### The gap declared rather than faked

**Real travel time between two addresses is not checked.** It is the PRD's
headline scheduling example — 45 minutes between towns making a 30-minute gap
impossible — and it needs a distance provider this app does not have. The gap
check uses a flat allowance from `job_travel_gap_minutes`, which catches the case
that actually bites (two visits booked back to back across town) without inventing
a figure per pair of addresses and calling it a measurement. `findConflicts()` is
where a provider plugs in.

Also not checked, for the same reason — the data does not exist: required skills
and certifications, and vehicle or equipment allocation.

### Verified

`npm run test:job-cards` — **152 checks**, adding 24 under `(J10)`. Two caught
real bugs rather than confirming intent: the overlap check (which found the NaN)
and *"arriving on site moves the job to work underway"*, which failed because
booking had already moved the job to **Scheduled** — a status with no role, and so
excluded by a role-based allow-list. The guard now tests the record state instead:
advance any `open` job that is not already in progress, however the business named
its stages.

`tsc` clean · `next build` green (7 routes) · `check-ui-kit.mjs` clean · smoke
crawl **7/7** · `reservations`/`posting`/`invoicing`/`quotes`/`sales-orders`/
`void`/`staff-time` all pass.

---

## What phase 5 shipped

**No migration.** `staff_time_entries.job_card_id` shipped unwritten in 104 for
exactly this phase — the second time in this programme that a whole phase landed
without touching the schema.

**Data layer** — `src/lib/site/jobTime.ts`: `jobTime`, `openEntryForUser`,
`startJobTimer`, `stopJobTimer`, `addJobTime`, `deleteJobTime`,
`reconcileJobTime`.

**Screens** — a Time card at the top of the Visits tab, where a technician
already is: start/stop, the entries with their notes, a recorded total, and
whether each has been costed. Two dialogs — stopping (with an optional note that
lands on the labour line) and booking hours somebody forgot.

### The decision that shaped it

**One open timer, and the index stays.** `uq_open_entry` is a generated column
holding the user id while an entry is open and NULLing on close (054:88), so the
**database** refuses a second concurrent entry. The PRD asks for a permissioned
bypass; this phase does not provide one, deliberately.

Relaxing that index cannot be undone — once two overlapping rows exist, no
migration restores the constraint without choosing which of somebody's hours to
delete. And the failure it prevents is the one that matters most: an hour paid
twice, or billed to two customers.

So **starting a timer on job B closes the open one on job A** and says which job
it came off and how long it ran. That covers the real case with one button and no
decision. The case it does not cover — genuinely working two jobs in one hour —
is answered by editing the minutes afterwards, which `editEntry` already audits.

Deliberately, switching does **not** price the entry it closed. That would put an
unreviewed charge on a job nobody was looking at. The entry keeps its minutes and
shows as *"Not costed yet"*, which is the flag that gets it dealt with — and
`reconcileJobTime().unpriced` reports it.

### Two smaller calls

**Money is snapshotted at capture.** Cost from `user_employment.hourly_rate` via
`hourlyCostOf()`; charge-out from the product named in `job_labour_product_id`.
Both written onto the line when the timer stops, so next year's raise does not
restate last year's margin.

**An unpriced line is still created.** No employment record or no labour product
means the line lands in `pending` with zeros. Losing the hours because a setting
is blank would be worse than a line somebody has to price — and `pending` is
already the state that blocks closing the job, so it cannot be forgotten.

A sub-minute timer records the entry and makes **no** line: a zero-hour labour
line is noise on the costing tab, but the button-press is still a fact.

### The bug this surfaced

**`vat_type = 'sales'`, not `'selling'`.** The column on products is
`selling_vat_rate_id`, so the fallback query was written against `'selling'` —
which matched no rows and silently put **0% VAT** on a billable labour line. No
error, just a wrong tax rate. Caught by printing the resolved rate rather than
trusting it, and now checked against the seeds in `001_products.sql`.

### Verified

`npm run test:job-cards` — **181 checks**, adding 29 under `(J11)`. The one that
matters most asserts `COUNT(*) = 1` on open entries after a switch: proof the
database constraint is intact and an hour cannot be paid twice.

`tsc` clean · `check-ui-kit.mjs` clean · smoke crawl **7/7** ·
`staff-time`/`timesheets`/`staff-cost` all pass, which is the regression that
counts — job time is written into the same table payroll reads.

---

## What phase 6 shipped

**Migrations** `107_job_travel.sql` (the table, plus coordinates on
`stock_locations`) and `108_travel_return_leg.sql` (one column, see below).

**Data layer** — `src/lib/site/jobTravel.ts`: `jobTravel`, `saveTravel`,
`verifyTravel`, `deleteTravel`, `travelNeedingVerification`,
`reconcileJobTravel`. The arithmetic — `haversineKm`, `estimatedTripKm`,
`chargeableKm`, `breachesTolerance` — is pure, in `jobStatusModel.ts`.

**Screens** — a Travel card on the Visits tab showing the four figures side by
side, with a *Check it* action and a verify dialog.

### The blocker, answered without an API

The plan flagged this phase as blocked on a distance provider. There is none, and
none was added. But `service_addresses` already stores coordinates and 107 added
them to `stock_locations`, so `expected_km` is **haversine × a road factor** —
pure arithmetic, no key, no cost, works offline.

It is good enough for the thing the column exists for: catching a 60 km claim on a
12 km trip. It is not good enough to argue over 2 km, so `expected_source` records
that it was **estimated** and every surface says so. Labelling an estimate as a
measurement is how somebody gets accused of padding by an arithmetic artefact.
When a provider is wired in it writes `expected_source = 'provider'` and nothing
downstream changes.

### The four figures, and why none derives another

```
Recorded    29.1 km   the claim
Expected    42.4 km   estimated from the pins, before the trip
Verified    29.1 km   somebody accepted it. NULL = nobody has looked.
Chargeable  29 km     after the rounding rule
                      → R188.50 at R6.50/km
```

`verified_km IS NULL` is the load-bearing one: defaulting it to the claim would
make the approval worklist unbuildable, because nothing would distinguish a
checked trip from an unchecked one. `chargeable_km` is stored for the reason 015
stores document totals — a trip invoiced last March must keep the figure it was
invoiced at, even after the rounding rule changes.

### Two calls that went against my first instinct

**Rounding to nearest, not up.** I wrote it rounding up, reasoning that a business
setting "nearest 5" means it bills in blocks of five. The PRD's own example
settles it the other way — 29.1 → 29 — and it is right for a better reason than
matching the document: travel is a line item the customer can see beside a
distance they can check, and 29.1 recorded billed as 30 is an argument on every
invoice.

**The leg count comes from the claim.** `expectedFor()` originally always doubled
the straight-line estimate, reasoning that the technician has to get back. That is
a guess, and it failed in the direction that matters: a 21 km trip got a 42 km
expectation, so somebody claiming the single leg they drove had **twice the
tolerance headroom** and could claim 50 km on a 21 km drive with nothing flagged.
The check silently stopped catching the thing it exists for.

Fixed by asking. `is_return` is stored, because `expected_km` was derived against
it and an edit must re-derive the same figure — inferring the leg count back from
the distance would be circular. Proved by `(J12)`: 50 km one way breaches against
21.2 km; the same 50 km as a return does not.

### And the migration rule, paid for again

That fix needed a column in a file that had **already been applied**. The runner
records migrations by filename, so editing 107 would have changed nothing —
silently. Hence `108_travel_return_leg.sql`, exactly as 085 corrected 081. 107 now
carries a comment at the spot where the column belongs, pointing at 108.

### Verification warns, never blocks

A breached claim flags for a signature; it does not refuse. The commonest cause is
a genuine detour, and a technician who cannot record what they drove stops
recording anything. Accepting a claim as it stands needs no note; **reducing** one
does, because a manager quietly trimming somebody's kilometres is what ends up
disputed. Correcting a claim clears the signature — a stale approval on a new
number means nothing.

Verifying is `jobs.bill_decide`, not `jobs.edit`: the person who drove must not be
the person who signs it off.

### Deliberately still not built

**GPS tracking.** The columns hold a location stamp at the two moments somebody
presses a button — departing and arriving — and nothing more. Continuous tracking
was argued out on POPIA grounds and stays out.

### Verified

`npm run test:job-cards` — **222 checks**, adding 41 under `(J12)`. The PRD's
worked example is asserted directly, and the boundary cases are exact: 20% of 30
accepts 36 and refuses 36.1.

`tsc` clean · `next build` green · `check-ui-kit.mjs` clean · smoke crawl **7/7** ·
`posting`/`invoicing`/`quotes`/`staff-time`/`timesheets`/`locations` all pass —
that last one matters, since 107 altered `stock_locations`.

---

## What phase 7 shipped

`sql/site/110_technician_vans.sql` — `stock_locations.is_mobile`,
`job_card_lines.issued_qty`, `stock_transfer_lines.job_card_line_id`. Three
`ALTER`s, no new table: a van is a `stock_locations` row and issuing is a
`stock_transfers` row, so the only new information is *which job a transfer line
was for*. (110, not 109 — a parallel session took that number.)

**Nothing in this phase writes a stock movement.** `issueParts()` builds a
transfer input and hands it to `postTransfer()`, which is the only thing that
calls `recordMovement()`. That was the whole design goal, because this is the one
phase where a wrong number moves physical goods.

### `is_mobile`, and why not `is_transit`

`is_transit` means *dispatched to another site* and is **hidden from every
picker** — "nobody sells from a truck, counts one, or transfers into one by
hand". A van is the opposite on two of those three: it must be transferable-into
and countable, and must never be sellable. So the picker question is not a
boolean at all, and a third boolean would have been the wrong shape:

```ts
export const LOCATION_PURPOSE = {
  transfer: { mobile: true },  count: { mobile: true },  adjust: { mobile: true },
  sell:     { mobile: false }, receive: { mobile: false }, reorder: { mobile: false },
} as const
```

`listLocations(siteId, includeInactive, excludeTransit, purpose?)` — the caller
says what it is *going to do*, and the list follows. `setMainLocation()` now
refuses a vehicle outright: sales come from main, so a bakkie as main would have
the till promising goods that are on the road.

`is_mobile` is **create-only** in the UI. A room that has held stock for two
years does not become a vehicle, and flipping the flag would silently change
which pickers its pile appears in.

### Two bugs an adversarial review caught before any code was written

Both were verified independently before being acted on, and both are the kind
that leave every existing check green:

1. **`salesPosting.ts:582` passes no `locationId`**, so `recordMovement()`
   defaults to MAIN. A part invoiced while it is still on a bakkie debits a pile
   it is not in — and **all three stock invariants still hold**, because the
   totals are right and only the attribution is wrong. `reconcileStock()` cannot
   see it. This is why returning is a deliberate step, why the Costs tab carries
   a Callout saying so, and why `reconcileJobParts()` exists.
2. **Issuing does not release a reservation**, so a reserved-then-issued unit
   would be deducted twice, permanently.

### The reservation source was cut

The plan had "Reserved on quote acceptance, added to `reservedQtyFor` as a fourth
source". It is **not built**, deliberately. `reservedQtyFor` is on the till's hot
path, `availableToSell` has exactly one reader
(`sales/orders/[id]/page.tsx:49`), and bug 2 above means a job source would have
had to reconcile against issuing to avoid double-deducting. The benefit was a
figure one screen reads; the risk was the shop not being able to sell.

The useful 20% instead: **`partsPromised()`** — a plain read of what open jobs
still need, `SUM(GREATEST(0, qty - GREATEST(issued_qty, invoiced_qty)))`, so a
unit already on a bakkie is not counted twice. No hot path touched.

### Screens

The **Parts card** on the Costs tab: Needed / On a van / To pick / On the shelf,
with issue and bring-back dialogs. Gated on **`stock.transfer`, not a jobs
capability** — somebody who may edit a job card is not thereby allowed to load a
bakkie. The "On the vans" table is narrowed to the products this job needs, and
its heading says *whichever job they were loaded for*, because a pile on a
vehicle carries no job tag.

`/setup/locations` grows the vehicle switch and a badge.
`reconcileJobParts()` is on `/setup/reconciliation` — three drift checks plus two
informational reports (stock living on a vehicle; a part promised to both a job
and a sales order, which nothing links and so can only be reported).

### Verified

`npm run test:job-cards` — **269 checks**, adding 47 under `(J13)`. The piles are
read after every act rather than the return value trusted; the drift function is
made to **fail on purpose** and then repaired, because a reconciliation nobody
has seen fail is one nobody should trust. It ends by asserting
`reconcileStock()` is unchanged after issuing, over-issuing, returning,
tampering and repairing.

`tsc` clean · `next build` green · `check-ui-kit.mjs` clean · smoke crawl
**151 passed, 0 failed** · `locations`/`transfers`/`serials`/`posting`/
`adjustments`/`stock-takes` all pass, each ending on its own zero-drift
assertion. The Costs tab was driven in a browser: 8 needed, 5 issued to a
bakkie, 3 to pick, and the shelf down by exactly 5.

---

## What phase 8 shipped

`sql/site/113_job_sla.sql` — one table (`job_sla_policies`, four seeded rows) and
six columns on `job_cards`. (113, not 111 or 112 — a parallel session took those.)

### The clock counts business hours, and that was the whole decision

A job logged **Friday 16:00** with a four-hour promise is due **Monday 11:00** —
one hour of Friday, three of Monday. Not Friday 20:00.

Chosen deliberately: a calendar clock breaches every job logged after Friday
lunch, and a worklist full of jobs nobody could have acted on is a worklist
people stop opening. The cost is real and is paid on screen — the deadline is no
longer obvious from the logged time, so the job card and the worklist both show
the **absolute deadline next to the business-hours remainder**, and the setup
screen carries a worked example that recalculates as you edit the hours. A red
badge alone is an assertion the reader cannot check, and the first time somebody
disputes it the badge loses.

The arithmetic lives in `jobStatusModel.ts` (browser-safe, no db import) and
works entirely in **UTC millis**, matching `storedMillis()`. `getHours()` would
shift every deadline by two hours on a South African machine — the same bug that
made the schedule draw every block at the right edge.

`holidays.ts` turned out to have no working-day arithmetic at all, only holiday
lookups, so `addBusinessMinutes` / `businessMinutesBetween` are new. Both walk
**day by day**, so a six-month-old job costs ~180 iterations rather than 260,000.

### What is stored, and what is not

| | |
|---|---|
| **Stored** | the promise, and the two deadlines it produced |
| **Derived on read** | whether it breached |

The deadlines are stored for the reason 015 stores document totals and 107 stores
`chargeable_km`: a job promised Monday 11:00 must keep saying Monday 11:00 after
somebody edits the trading hours. Recomputing on read would silently restate what
a customer was told — the one figure a dispute is actually about.

The breach is not stored because a stored flag is wrong the minute after it is
written and would need a cron. `isClosed()` makes the same argument.

**`met` is a third state, not "not breached".** A job answered inside its target
is settled, and showing it beside jobs still counting down is how the list stops
being actionable.

### Two refusals worth naming

**A degenerate trading week returns `null`, not a hang.** A mask of zeroes, or a
closing time before opening, has no working minute to find — and an unbounded
search for one inside a page render is a hung request, not a wrong number. Bounded
at 400 days and guarded by `tradingWeekIsUsable()`.

**A second response is refused, in SQL.** `responded_at IS NULL` in the WHERE
clause rather than a check in code, because two dispatchers opening the same job
would race. Overwriting it would quietly turn a met target into a breach. It is
also deliberately **not** derived from the activity log, whose first entry is the
job's own creation — a job would count as answered the instant it was typed in.

### A priority change re-promises the job

An urgent job downgraded to normal stops being measured against an urgent
promise. Recomputed from the **original `reported_at`**, never from now — the
clock started when the customer phoned, and restarting it on every edit would make
the deadline a thing you can reset with a dropdown.

### Six pre-existing jobs were left untargeted, on purpose

Every job created before this migration carries no deadline, and that is the
correct state: nobody promised those customers anything. Back-dating would
fabricate a promise, and most would have appeared **already breached the moment
the feature shipped** — worse than no figure. Reported on `/setup/job-workflow`
and `/setup/reconciliation`, absent from the worklists, and it drains as they
close.

### Screens

`/jobs/sla` — two tabs, because response and resolution are different questions
asked by different people. No "breached" tab: breach is derived, so soonest-first
already puts the most overdue at the top, and a row appearing in two tabs is a row
worked twice. The SLA panel went onto the existing `/setup/job-workflow` rather
than a new route, and a card sits above the address on the job's Overview.

`reconcileJobSla()` reports three things and colours **one** of them red: a
response recorded before the job was reported cannot happen through the app. The
other two — a deadline predating a trading-hours edit, and a job with no target —
are the design working, so they are listed and not alarmed.

### Verified

`npm run test:job-cards` — **360 checks**, adding 59 under `(J14)`. The
load-bearing ones: Friday 16:00 + 4h = Monday 11:00; **the two clocks agree**
(measuring back from that deadline returns the same 240, so the countdown cannot
contradict the deadline beside it); a degenerate week refuses rather than loops;
and a priority downgrade re-promises from the original report time.

`tsc` clean · `next build` green · `check-ui-kit.mjs` clean · smoke crawl
**152 passed, 0 failed** · `holidays` and `staff-time` pass. Driven in a browser
with three seeded jobs: "2 days over" in red, "1h left" plain, an unassigned
urgent job flagged, and a late first reply badged on the Fix dates tab.

Also corrected while here: the `job_travel_round_to` comment claimed rounding
**up**, contradicting both the PRD example and `chargeableKm`, which rounds to
nearest.

---

## What phase 9 shipped

**No migration.** The report builder, the dashboard and the reconciliation screen
all already existed; this phase is two catalog sources, three template specs and
three widget rows. That was the point of building them as one engine.

### Two sources, for the reason sales and sale lines are two

`jobCards` (47 fields) and `jobCardLines` (35). A job is one row with one customer
and one status; a line is a part or an hour. "How many urgent jobs closed last
month" asked against the lines counts a job once per line, and "what did we spend
on parts" asked against the jobs cannot see a part at all.

**No revenue field on either.** A job line carries `unit_price_incl`, which is an
*intention* — what the customer owes is on the invoice after `documentMath`. A
revenue column read off the line would agree with itself and disagree with the
sales report, so the margin field is named **`intendedProfit`** and says so in its
hint. `invoicedQty` and the invoice number are offered instead, as the thread back
to the paper.

Cost is gated **per field** on `jobs.cost`, never per source: `job-cost-absorbed`
opens for a technician with 4 of its 7 columns rather than refusing. A saved
report shared across a shop should degrade for the junior.

### Three built-ins, not fifteen

`jobs-by-technician` · `job-cost-absorbed` ("Work we did not charge for") ·
`job-parts-used`. Each is a builder spec, so Schedule, Columns, Export and
Customise came free.

`job-cost-absorbed` deliberately has **no** total filter. Filtering to
"absorbed > 0" would hide the jobs whose cost is still *undecided* — the ones
somebody can still act on. Sorting does the work without discarding rows.

### The bug-finding that mattered

The templates all passed on the first run. Then I executed **every catalog field
individually** and eight failed:

- all seven `jobCardLines` time buckets — `timeBuckets()` builds `t.<col>` and a
  job line has no `reported_at` of its own, so every bucket asked for a column
  that does not exist. Fixed with the alias-rewrite `.map()` every other
  line-level source uses.
- `accountRep` — `CUSTOMER_LOOKUP_FIELDS` declares `needs: ['customer',
  'customerRep']` and I had supplied only the first join. A spread field set
  brings its join requirements with it.

None of the three templates selects any of those eight, so all of it would have
shipped and broken only for whoever picked one in the builder. `(J15)` now runs
every field on every push.

### Dashboard: three rows, not a section

Two breach rows (danger) and one unassigned row (warning), added to the existing
`attention` list. Kept separate because each is a different person's job — the
owner's, the dispatcher's — and "12 jobs need attention" is a number nobody can
act on. `jobs.overdue` was deliberately **left out**: SLA breach already covers
anything carrying a promise, and two rows saying nearly the same thing is how a
list gets skimmed. Both reads are `.catch(() => null)` — the dashboard is the
screen somebody opens to find out what is wrong, so a site mid-migration must not
be met with a stack trace.

### `reconcileJobCards()` finally reaches a screen

Written in phase 1, wired now. Four bug checks (over-invoiced, orphaned invoice
link, billed-unbillable, and a stored open/closed flag its stage contradicts) and
one configuration report — a stage no board lists, whose jobs are therefore
invisible on every board. Only the four are red.

### Verified

`npm run test:job-cards` — **388 checks**, adding 28 under `(J15)`. The load-bearing
one runs all 82 catalog fields as real SQL. `builder`, `report-templates` and
`dashboard` suites pass · `tsc` clean · `check-ui-kit` clean · `next build` green ·
smoke crawl **152 passed, 0 failed**. Driven in a browser: all three templates
appear in the catalogue, `job-cost-absorbed` renders 7 rows with a correct totals
footer, and the dashboard shows "1 job with nobody on it" sorted into the warning
band.

### One thing to note

While adding these sources I ran a line-based `sed -i` on `catalog.ts` while a
concurrent session was editing the same file, and **destroyed their uncommitted
version of the same two sources** (~190 lines). It was unrecoverable — nothing in
git, and my backup was taken after the first bad edit. Their distinguishable
ideas were folded into what shipped: `type: 'document'` on the job numbers, the
`COALESCE(closed_at, NOW())` day count that answers open-age and turnaround in one
column, `daysOverdue` against the due date, `customerPhone`, hourly buckets, the
price/profit fields — and the two `source` enum values I had missed
(`walk_in`, `internal`), whose absence would have offered filters that could never
match. **Never run `sed -i` against a shared file.**

---

## Deferred, and what each is blocked on

Not "later" — **blocked on infrastructure that does not exist**.

| Deferred | Blocked on / decision |
|---|---|
| **SMS / WhatsApp / push** | Only `mail.ts` exists. **SMS belongs beside it as a platform project** (one week, benefits eight other modules). **WhatsApp** needs Meta business verification and per-template approval — a commercial project. **Push** argued out: no PWA/service-worker story. Any channel needs a per-customer opt-out record for POPIA, cheaper before the first send. |
| **In-app notifications** | A separate platform project; every module wants it, and building it inside job cards guarantees it ends up job-shaped. Phase 1's substitute is a list filtered to "assigned to me". |
| **Two-way calendar sync** | **Argued out.** Ship a read-only per-technician ICS feed (~150 lines, no OAuth, subscribes in Google/Outlook/Apple). Two-way needs OAuth token storage per user-per-site, webhooks, delete-tombstoning, and an authority question with no good answer. |
| **GPS tracking / geofence** | **Argued out.** POPIA makes continuous location special-category processing, and consent from an employee as a condition of employment is weak. Replaced by arrive/leave stamps in phase 6. |
| **Form builder** | **Argued out.** Build **checklist templates** instead (ordered items per job type: text / yes-no / number / photo / signature). **Do not generalise `instructionRules.ts`** — it is on the till's hot path and in the offline bundle. |
| **Workflow automation engine** | Hard-code the six automations that matter as named, defaults-off, separately-granted toggles — the `contracts.auto_send` precedent. A general engine needs an event bus this app does not have. |
| **Offline mobile sync** | `posOffline`'s rule is *"an offline sale is ALWAYS POSTED"* — it **refuses** conflict resolution because the customer has the goods. A job card has no such forcing function, so it genuinely needs the merge semantics the till avoided. Revisit only after the schema stops moving. |
| **Receipt OCR** | Attachments (phase 1) make the receipt present; extracting it is optional forever. |
| **Customer portal / public forms** | `customerAuth.ts` and `/reserve/[token]` are the hard parts and exist. Still a full set of public screens plus a field-by-field scope audit. The `source` enum already reserves the values. |
| **Row-level data scoping** | Argued out. The in-house answer is a capability pair (`jobs.view_own` / `jobs.view_all`), matching `staff.*` and `commission.*` — one `WHERE` clause. A general framework touches `CapabilitySet` and all 137 modules. |
| **Deposits** | The PRD says no accounting sync is needed yet, so a deposit is a normal invoice against the job. No work. |
| **Retention periods** | **Rejected "AI to decide".** Retention is a legal determination — SARS 5 years, BCEA 3 years. A settings screen with a citation beside each, and the house stance is *reports, never repairs*. |

---

## Risks to hold onto

1. **A second posting engine.** The costing model tempts a `postJobToInvoice()`
   that writes documents, movements and a number itself. Then VAT is computed in
   two places and **the divergence is silent** — `reconcileStock()` only checks
   quantities. Nothing in the module imports `recordMovement`,
   `nextDocumentNumber`, `postTransaction` or `mirrorSale`.
2. **`reservedQtyFor` is on the till's hot path.** It deliberately keeps online
   holds out of its UNION so an unmigrated site cannot stop the shop selling.
   Phase 7 **did not add a job source** — see above — precisely because the
   benefit was one screen's figure and the downside was the shop not selling. If
   one is ever added it needs the same defensive swallow *and* must reconcile
   against `issued_qty`, or an issued unit is deducted twice.
3. **A sale consumes from MAIN regardless of where the goods are.**
   `salesPosting.ts` passes no `locationId`, so invoicing a part still on a van
   debits the wrong pile while every invariant holds. `reconcileJobParts()` is
   the only thing that can see this; do not "fix" it by having the job module
   write its own movement.
4. **`is_transit` is taken** and hidden from every picker — which is why phase 7
   added `is_mobile` plus `LOCATION_PURPOSE` rather than a third boolean. Reusing
   `is_transit` would have hidden every van from the stock-take scope picker.
5. **A serial is not an asset.** Link by nullable reference, or every
   third-party air conditioner needs a fake product and a fake serial that then
   counts toward invariant (S1). Relatedly, phase 7 **refuses to issue a
   serial-tracked part to a van**: which unit was fitted is the whole point of a
   serial, and choosing it on the pavement is how a warranty lands against the
   wrong customer.

## Answered as the phases shipped

- **The one-open-timer bypass** (phase 5) — there is none. Starting a second timer
  stops the first, so `uq_open_entry` stays intact. Relaxing it could never be
  re-tightened once two overlapping entries existed.
- **Travel rounding** (phase 6) — to the **nearest** block, matching the PRD's own
  worked example (29.1 becomes 29). Rounding up would bill kilometres nobody drove.
- **A distance provider** (phase 6) — none available, so `expected_km` is haversine
  times a road factor and is labelled *estimated*. Good enough to catch a 60 km
  claim on a 12 km trip, which is what the tolerance check is for.
- **The SLA clock** (phase 8) — **business hours**, not wall clock. A calendar
  clock breaches every job logged after Friday lunch.
- **Jobs predating the SLA feature** (phase 8) — left untargeted and reported,
  rather than back-dated. Nobody promised those customers anything.

## Still open

1. **Which of the six billing states does the business actually use?** (review
   after ~50 real jobs) If `variation` and `additional` are the same thing in
   practice, or `pending` is never used, they are dead weight on every screen.
   This is the one place the PRD's completeness may exceed the business's —
   worth measuring rather than guessing.
2. **Do the seeded SLA figures match what this business actually promises?**
   (review after the first month) 1h/4h/1day/2day response and 1/2/5 day
   resolution are defensible defaults, not this shop's commitments. The screen
   exists to change them; whether anybody has is the question.
