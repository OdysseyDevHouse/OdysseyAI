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

### The suite was not in the aggregate chain

`test:job-cards` existed and passed, and `npm test` **never ran it** — it was never
appended to the 43-suite chain in `package.json`. 390 checks that only ran when
somebody invoked them by name. Now suite 44 of 44.

Running the whole chain then surfaced four **pre-existing** blockers, none of them
job-related, all recorded here because `&&` chaining means the first one stops
everything after it:

| Suite | Why |
|---|---|
| `test:navigation` (3) | `/sales` and `/sales/invoicing` — fail identically against `HEAD`'s `nav.ts`, verified by swapping it in |
| `test:purchasing`, `test:opening-balances`, `test:payment-runs` (1 each) | all the same `reconcileSupplierBalances` drift: supplier `REF55846921` "Refer Test Wholesalers" carries a stored R5 796 with no transactions — litter from the refers suite |
| `test:storefront` (2) | needs a department flagged "show in online store"; a data prerequisite, not a code fault |

`test:navigation` is third in the chain, so **nothing after it had been running**.

### All of them are now fixed, and `npm test` is green end to end

**2 516 assertions, 0 failures**, 44 suites, exit 0. None of the fixes touched
product code except one duplicated search keyword.

**One root cause behind three suites.** `REF55846921` was not the stray fixture it
looked like. The refers suite deletes **three named GRV ids**, and a fourth
(GRV003258) was not among them — so it survived, held the supplier alive through its
FK, and made the suite's own `DELETE FROM suppliers` **fail silently**, leaving a
balance of R5 796 behind a document worth R276. The document was a husk: no lines,
no movements, no ledger rows. Cleared it, and the sweep now deletes **by
supplier_id** rather than by a remembered list — plus asserts the supplier is
actually gone, because a silent failed delete is what turned one row into three
unrelated suites failing.

**Two suites were failing on their own fixtures.** Both `test-storefront.ts` and
`test-customer-accounts.ts` published "the first department with no parent", which on
this database was an import fixture holding **zero products**. `publishMode:
'departments'` counts products in published departments rather than the flags
themselves, so `saveOnlineSettings` correctly refused to open an empty shop. Both now
pick a top-level department that has stock. `test-customer-accounts.ts` additionally
ordered the cheapest of five published products without checking stock, and got a
truthful "has just sold out" — it now filters on `inStock` over a wider sample.

**Two nav assertions were stale.** `/sales/invoicing` had `invoice` twice in its
keywords. And `/sales` is a redirect kept for bookmarks and `revalidatePath` calls,
so it is correctly absent from the menu — one check demanded it be linked, another
demanded it appear in a capability-filtered index. Allowlisted, and the second
assertion retargeted at `/sales/invoicing`, the screen `sales.view` actually grants.

A caution for next time: my first pass at reading the chain grepped for `FAIL` and
reported all-green, while `test:customer-accounts` was **throwing** rather than
printing. Check the exit code and the tail, not a pattern.

### And this suite was leaving litter of its own

Having diagnosed three suites failing on somebody else's leftovers, the obvious next
question was whether this one does the same. It did: four orphaned `activity_log`
rows, because `sweepStrays()` deleted by one actor name while the later phases had
used three others.

The old cleanliness check looked at `job_cards` alone and passed straight over them.
`(J17)` now asserts **every** table the suite touches is empty by name — including
the three orphan shapes no fixture pattern can catch (a line, an activity row or a
time entry whose job has already gone) — and names which one failed. Verified
independently afterwards: clean.

This is not housekeeping. Litter from one suite is how another suite fails, and it
is close to undiagnosable from the far side: nothing about
`reconcileSupplierBalances` failing in `test:payment-runs` points at the refers
suite.

### An audit found a half-built feature

With all nine phases done I audited the module against the database rather than
against my own notes — migrations applied, tables present, every `reconcile*()`
run, the JC sequence verified. Two things came out of it.

**`travelNeedingVerification()` had no caller.** Written in phase 6 with its own
index `ix_jtravel_verify` and its own tests, and referenced from nowhere. A real
claim — 88 km against a 42.4 km estimate — was sitting in the database appearing on
no screen, so the approval half of the travel workflow did not exist. It is now a
third tab on `/jobs/sla` ("Travel to check"), because the question is the same
shape as the SLA lists: work sitting still until somebody senior looks at it. Gated
on `jobs.bill_decide`, not `jobs.edit` — the person who drove must not sign it off.

`(J16)` now asserts the worklist has a reader, because the same thing can happen to
any read that outlives the screen it was written for.

**The one-engine rule was stated too loosely,** here and in my own summaries. See
the corrected wording under Risks: `nextDocumentNumber` IS used, in two places, and
that is correct. The three functions that must never appear are `recordMovement`,
`postTransaction` and `mirrorSale` — verified by grep.

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

## Phases 10+ — the gap against the PRD

Phases 1–9 built the **transactional spine**: a job can be logged, quoted,
scheduled, worked, stocked, measured against an SLA, billed and reported on. What
they did not build is the **configurability layer** that makes it a product rather
than one shop's workflow. Measured against the PRD, in rough order of how much
each unblocks:

| PRD | Missing | Note |
|---|---|---|
| §8 | ~~Job headlines~~ | **shipped, phase 10** |
| §23 | ~~Tasks and checklists~~ | **shipped, phase 10** |
| §24 | ~~Custom forms~~ | **shipped as checklist templates, phases 10 + 13.** All eight response types, and since 13 a photo holds a photo and a signature holds a signature. What remains undone is the *builder* — conditional logic and per-response versioning — which is a different product, not a missing half of this one. |
| §18 | ~~Customer assets + service history~~ | **shipped, phase 11** |
| §13 | ~~Followers~~ | **shipped, phase 14** — with email on three moments, never on every edit |
| §16 | ~~Teams, job-level multi-assignee~~ | **shipped, phase 14.** What remains is a *named* team as a reusable entity ("the North crew"), which is a different feature from putting several people on a job. |
| §15 | ~~Recurring jobs~~ | **shipped, phase 12** |
| §12 | ~~Workflow automation~~ | **shipped as six named rules, phases 14 + 15.** Three notifications and three time-based automations, each separately switchable. A general *engine* remains deliberately unbuilt — see the deferred table. |
| §4.2, §4.3 | ~~Customer portal, public forms~~ | **both shipped, phases 28 + 29.** A public request lands in a holding area and becomes a job only when somebody accepts it with a chosen customer; the portal signs a customer in by emailed link and shows their own jobs, quotes and invoices. `source='public_form'` is finally written rather than merely reserved. |
| §36 | ~~Notifications~~ | **email subset shipped, phases 14 + 15.** In-app notifications and SMS remain separate platform projects; the header bell is still a dead button. |
| §37.2 | ~~Kanban grouping, saved views, bulk actions~~ | **shipped, phase 17.** All three. |
| §60 | ~~Week / technician-lane calendar~~ | **shipped, phase 18** — read-only. Drag-to-reschedule is a phase of its own: it needs a conflict check, an audit trail and a notification. |
| Phase-1 dashboards | **2 of 4 shipped, phases 20 + 21.** Operations and My Work. The Scheduling dashboard is largely covered by the week grid and the board; the Financial one wants the costing reports first. |
| Phase-1 reports | ~~**15 of 15**~~ — **eight in phase 22, the remaining seven in phase 31.** No new code for the second batch: making `jobTime`, `jobTravel` and `jobVisits` catalog sources turned twelve developer tasks into a list of column choices. |
| §27 | Receipt OCR | Deferred by agreement |
| §33 | ~~Deposits on a job~~ | **shipped, phase 23** — as a customer receipt through the cashbook, so the ledger and the bank account both move. No new table. |
| §41 | Offline mobile | Deferred by agreement |
| §14.2 | ~~ICS calendar feed~~ | **shipped, phase 24.** Read-only, signed per-technician token, nothing stored. Two-way sync stays deferred — see the deferred table for why. |
| — | ~~Custom fields~~ | **shipped, phase 26** — as a module serving jobs, customers and equipment rather than a job feature |
| — | ~~Feedback / rating~~ | **shipped, phase 27** — one star and one sentence, asked on close, off by default |
| — | Sign-off, ticket module | Still outstanding, from the PRD's own "AI can make a call" list. The ticket module is a second product rather than a phase |

## What phase 10 shipped

`sql/site/114_job_headlines.sql` — five tables, three settings, no changes to
anything that already existed.

### A headline is not a category

`job_cards.title` says what *this* job is. A headline says what jobs of its kind
always require: the checks a service needs, the filter it consumes, the two hours
it takes, the board it belongs on. A dropdown that only labels the job is a report
filter; **a headline that attaches the work** is the difference between configuring
a business once and every technician retyping the same checklist.

Many per job, per §8 — replacing a compressor and surveying the site can be one
visit — so `job_card_headlines` is a join table, not a column.

### One item table for tasks AND checks

§23 calls them different things. Structurally they are one thing: an ordered list of
named items, each done or not, each optionally required. The **only** difference is
that a check captures a value, so `response_type = 'none'` *is* a task, and `kind`
survives purely as a label because Task and Check are the words the trade uses.

Two tables would have been two copies of the ordering rule, two of the blocking
rule, two near-identical screens, and a permanent question about which one a new
requirement belongs in.

### The items are copied onto the job, not referenced

`job_card_items` holds its own name and response type. Editing *"Check gas
pressure"* to *"Check refrigerant pressure"* next March must not rewrite what
somebody signed off last week — the same argument the job lines make for
snapshotting `product_code`.

The cost, stated plainly: **fixing a template typo does not fix the jobs already
carrying it.** That is the right trade. A completed check records what a person
confirmed, and a record that changes underneath its author is not a record.

### Merging, and what survives a reclassification

Two headlines that both require an item produce **one**, matched on the trimmed
lower-cased name, and the caller is told which merged so the screen can say so. A
later duplicate that is **required promotes the survivor** — if either headline
insists, the job insists; silently keeping the optional copy would drop a
requirement somebody configured.

Deselecting a headline clears only its **untouched** items. Anything completed
stays (deleting a signed-off check destroys evidence) and so does anything a
technician added by hand — `headline_item_id IS NULL` is what protects it.

### The required flag now blocks closing

Wired into `setStatus`, beside the undecided-cost guard, and it **names the items**:
*"Still to do before this job can be closed: Isolate power, Gas pressure, Customer
signature."* A count sends somebody hunting; a list tells them what to do.

Switchable via `job_items_block_close`, and **tolerant of a site without migration
114** — a missing feature must never stop a job being closed.

Two smaller refusals worth naming: a check that captures a value **cannot be
completed without one** (otherwise "completed" just means somebody pressed a
button, which is the box-ticking a checklist exists to prevent), and a
**signed-off item cannot be deleted** — untick it first if it was recorded in error.

### Deliberately not built here

- **Forms** (§24) — the builder with conditional logic and per-response versioning
  rivals phase 1 on its own.
- **A skills register.** `required_skills` is free text: a normalised register with
  per-user certifications and expiry dates is its own project, and the table without
  the register would be a foreign key to nothing.
- **Thresholds on measurements.** Whether 12 bar is acceptable is engineering
  judgement this system does not have, so only yes/no and pass/fail can fail.
- **Auto-adding standard parts.** Off by default: offering them is safe, adding a
  billable line because somebody picked a dropdown is how a customer gets charged
  for a filter nobody fitted.

### Screens

**Setup** — a *Kinds of work* card on the existing `/setup/job-workflow`, between
the boards and the promises, because a headline decides a job's priority and board
so it reads before the things that measure it. The item editor is a **flat list
with the phase as a field**: grouping is a reading concern, and three drop zones
would make moving an item between phases a drag rather than a dropdown. Arrows
reorder rather than DnD — a checklist is edited rarely and read constantly, and
arrows work on a phone with no hydration gate. The board earns its DnD because
dragging a job between columns *is* the gesture.

**Job card** — a *Checks* tab, grouped Before / While / Before leaving, because
that is the order the work is done in and a safety check buried between two
readings is one somebody skips. The tab count is **outstanding required items, not
the total**: a count on a tab exists to pull somebody towards work they must do,
and "12" on a finished checklist pulls them towards nothing.

One field per response type rather than a generic box — a yes/no gets two buttons
(one tap that both answers and completes), a measurement gets a number field with
its unit beside it, a signature gets a name box. The model already knows which, so
the screen asks it rather than carrying a second copy of the mapping. A text input
for everything is how a reading of 12 gets typed as "twleve" on a phone in a plant
room.

`reconcileJobHeadlines()` is on `/setup/reconciliation`: two red checks (a check
signed off with nothing recorded; a failure flag disagreeing with its answer — both
impossible through the app) and one informational (open jobs with no kind of work,
listed only when the setting demands one).

### Verified

**432 checks** in `test:job-cards`, adding 42 under `(J18)`, and `(J17)` extended to
assert the three new tables leave nothing behind. Full chain green: **2 558
assertions, 0 failures, exit 0**.

Migration applied and idempotent; all five tables, three settings and every index
confirmed. The pure model tested standalone: merge across case and whitespace,
required-promotion, and failure detection — where the load-bearing case is that an
**empty answer is unanswered, not failing**, since treating them alike would put
every untouched job on the exception report.

Driven end to end through the real functions and then in a browser: two kinds of
work on one job produced 4 items from 3+2 with the shared one merged and promoted;
priority taken from the headline; close refused **by name** then allowed once
answered; a failing check flagged with its note; a hand-added task and a signed-off
check both surviving a reclassification; a used headline refusing deletion.
Unticking a failed check cleared the answer **and** the flag together, so no stale
failure survives. `tsc` clean · `check-ui-kit` clean · `next build` green · smoke
crawl **152 passed, 0 failed**.

## What phase 11 shipped

Three migrations — **115** the tables, **116** a `status` column, **117** a rename.
Two of those three were corrections, and the reason is worth recording.

### Three tables that look alike and are not

| | |
|---|---|
| `fixed_assets` (046) | what the BUSINESS owns and depreciates |
| `product_serials` (021) | a unit WE bought or sold |
| `customer_assets` (115) | what we look after for somebody else |

Decision 7 was right, and now verified rather than assumed: `fixed_assets` carries
`depreciation_method` and `residual_value` with `depreciation_runs` beside it. A
customer air conditioner in that table would put customer equipment on our balance
sheet.

`product_id` and `serial_id` are **nullable**, set only when we sold the unit — a
plumber servicing a geyser fitted by somebody else in 2011 still needs a record of
it, and requiring `serial_id` would mean a fake serial that then counts toward
serial invariant S1. `customer_id` is nullable too, per §52 Q8: a unit can be in
the workshop before anybody claims it.

### The duplicate check is a generated column

```sql
serial_key VARCHAR(64) GENERATED ALWAYS AS
  (UPPER(REPLACE(REPLACE(COALESCE(serial_text,''),' ',''),'-',''))) STORED
```

Verified end to end: `" ab-12 cd "` and `"AB12CD"` collapse to one key, and search
finds the unit by `"ab 12-cd"`. Normalising in code would mean every caller had to
remember to, and one that forgot would create the duplicate the check exists to
prevent. Scoped **to the customer** — two customers can each own a unit whose plate
reads 001 — and it **warns rather than blocks** by default, because §18.3 is
explicit that plenty of equipment has no legible serial.

### Two migrations I should not have needed

`verifySequence()` has **two** hard-coded expectations of any table in
`OWN_TABLE_TYPES`, and my notes recorded only one. 116 added the `status` column the
note described; then 117 had to rename `asset_code` to `document_number`, because
the same function also counts `WHERE document_number IS NOT NULL`.

The memory is updated: **read the SELECT inside `verifySequence`** rather than
trusting the note or the surrounding code. It is one query and it names every
column it needs. `AST000001` now reconciles — 2 issued, 2 live, **0 missing**.

### One asset per job, and history is a query

`job_cards.asset_id` is a single column where headlines are a join table. A job is a
visit to fix a thing; servicing eight units is eight jobs or one job with eight
lines, both already expressible. A join table would make every cost, check and
warranty question need to say *which* asset — and a join table can be added later
without moving what is already recorded.

`assetHistory()` is `SELECT ... FROM job_cards WHERE asset_id = ?`. A history table
would be a second copy of the job list, and the two would drift the first time a
job was cancelled.

### Closing a job rolls the service dates

Wired into `setStatus`, **after the commit and on its own connection**: it must see
the job as closed, and a failed service date must not roll back the closure. A date
is a convenience; the status change is the record.

Verified that it fires on **close** and not on **cancel** — a cancelled job serviced
nothing, and both dates stayed null. A type with no interval leaves
`next_service_on` alone, because on-demand equipment has no next service and
inventing one fills the due list with work nobody asked for.

### Verified

Migrations applied and idempotent; the generated column, sequence and settings
confirmed. Driven end to end: AST number issued and reconciling, identifier label
taken from the type (§75 asks for a customisable asset field label), duplicate
warning across spellings, delete refused once a job exists, `status`/`is_active`
moving together with the drift check catching a hand-edit, and `test:job-cards`
still passing its 432 checks with `test:sequences` green.

### Screens

`/jobs/equipment` — the list, under **/jobs and not /customers**: the customer screen
is where you look a unit up when you have the customer in front of you, but the
question this list answers is *what is due a service*, which is a dispatcher's
question asked across every customer at once and whose answer turns into jobs. One
tile, because there is one question; a strip of five equipment counts would be four
numbers nobody acts on.

`/jobs/equipment/[id]` — the unit and its history. `/new` and `/edit` share one form
where the **identifier field is relabelled by the kind** (§75 asks for a
customisable asset field label): a technician typing into a box marked the wrong
thing hesitates, and then types it into the notes where nothing can search it.

On the job card, *What it is about* sits **above the address** — a technician wants
to know which unit before which gate — carrying the serial and the warranty badge,
because whether it is under warranty is the question they have first.

Kinds of equipment went onto the existing `/setup/job-workflow` after kinds of work.
`reconcileAssets()` is on `/setup/reconciliation`: three red checks and one
informational (an open job on retired equipment, which is **allowed** — somebody has
to be able to log the job that scrapped it).

### Verified

**469 checks** in `test:job-cards`, adding 37 under `(J19)`, and `(J17)` extended so
the two new tables cannot leak. Full chain green: **2 595 assertions, 0 failures,
exit 0**. `tsc` clean · `check-ui-kit` clean · `next build` green · smoke crawl
**156 passed, 0 failed**.

Two things the browser found that the tests could not:

- The activity date rendered as **"hu Aug 13 2026"** — `String(driverDate)` is a
  locale string and my `.slice(0,16)` cut it mid-word. Fixed to the
  `toLocaleString('en-ZA', …)` the job history already uses.
- `/jobs/equipment/[id]` and `/edit` were **SKIPPED** by the smoke crawl for want of
  an id source, so neither was actually checked. Registered one that picks the unit
  with the most history, so the crawl renders the history table rather than its empty
  state.

One assertion of mine was wrong rather than the code: I asserted the AST sequence had
`missing === 0`, and it reported 4. The counter was at 7 with zero assets — my own
probe runs had allocated numbers and deleted their rows, exactly as the JC sequence
does. Rewritten baseline-relative, so it proves what matters: the sequence is
registered, the query **runs**, and `live + missing === issued`.

## What phase 12 shipped

`sql/site/118_recurring_jobs.sql` — three tables plus a column on `job_cards`.

### This is `061_contracts.sql` with a job instead of an invoice

Copied deliberately, down to the column names, because that module already solved
recurrence twice over:

**Claim-then-create.** A period is inserted into `job_series_runs` under a unique key
on `(series_id, for_date)` **before** the job is built. A second tick racing the
first fails on that insert having written nothing. Verified: tick two created 0, and
a concurrent pair produced exactly **1 + 0**.

**Catch-up.** `duePeriods()` walks from the cursor to today and returns every period
it passed. A series left un-ticked for three months raises three jobs — verified, and
**each job is dated for its own period**, not the run date, so an SLA clock starts
when the work was due.

What is genuinely shared is `nextOccurrence()` from `expenseModel`: pure date
arithmetic already used by expenses and contracts, and the one place "the 31st in
February" is decided. `test:contracts` still passes, so reusing it disturbed nothing.

### Four frequencies, not six

You chose to reuse the shared `FREQUENCIES` as-is. §15 also asks for daily and custom
intervals; adding either would have put them in the **expense and contract pickers
too**, offering a daily recurring invoice nobody asked for. Every real maintenance
pattern is weekly, monthly, quarterly or annual — a daily recurring job is a roster.

### Three decisions worth naming

**Lead time shifts the window, not the date.** A series with 14 days of lead raises
April's job on 20 March, and the job still says 1 April. Shifting the date instead
would quietly move every due date forward.

**`auto_create` defaults OFF**, exactly as `contracts.auto_send` does: a schedule
that started raising three months of catch-up the moment somebody saved it is a
schedule nobody trusts again. A manual "raise it now" overrides the switch, because
somebody pressing a button *is* the decision the switch guards.

**Deleting a schedule keeps the work.** `fk_jcard_series` is SET NULL — a schedule is
a plan, the jobs are the record. Verified: 5 jobs survived with `series_id` null.

### What an occurrence does not inherit

Per §19: `raiseOne()` **builds** a fresh job rather than cloning the previous one, so
no checklist answers, time entries, costs, comments or files carry forward. A service
sheet arriving pre-signed by last quarter's technician is worse than none. The
headlines it *does* carry then attach their own fresh checks.

`reconcileJobSeries()` reports three shapes, the serious one being a **stranded
claim** — a period claimed but never produced, which the unique key means will never
be retried. That is the only drift here that silently loses work.

### The screens

`/jobs/recurring` is one screen, not a section: a list with an editor modal and a
runs-history modal. A schedule is set up rarely and read occasionally, so it earns a
route and not a hub.

Three tiles: **Schedules**, **Owing a job now**, **Switched off**. The middle one is
the only figure that means anything operationally — it counts periods `duePeriods()`
would return right now, so a non-zero number means work the business intends to do
has not been raised.

**The screen explains its own paused schedules.** `auto_create` defaults off, so the
first thing a new user sees is a schedule that is not doing anything. Rather than
leave that looking broken, a switched-off schedule carries a **"Not raising"** badge
and a callout names them and says why the default is off. A feature whose safe default
looks like a bug gets switched on carelessly.

**The cron banner is the point of the whole screen.** If `JOB_SERIES_CRON_SECRET` is
unset while schedules are switched on, the screen says *nothing is calling the daily
run*. That state is otherwise completely silent: every schedule reads as healthy and
no job is ever raised. Verified both ways — banner present with no secret, absent with
one.

`/api/jobs/series/tick` follows `contracts/tick`: secret compared in constant time,
**503 when no secret is configured** rather than running wide open, and each site in
its own try/catch so one broken site cannot stop the sweep. That last part earned
itself immediately — the first live tick raised `JC000431` on site 1 while site 2
failed on a missing table, and the sweep completed and reported it. Site 2 was six
migrations behind; that is how I found out.

It also needed `'/api/jobs/series/tick'` in `PUBLIC_EXACT` in `src/proxy.ts`. Without
it the route 307s to the login page and a cron job records a perfectly successful
fetch of an HTML page, forever. Verified: **401 without a secret, not 307.**

On the job card, a **"Raised by a schedule"** callout names the series, the frequency
and the period, and states plainly that nothing carried over from the previous
occurrence — the §19 guarantee, written where the technician wondering about it is
looking.

`reconcileJobSeries()` joins `/setup/reconciliation` as two tables: stranded claims
and cursor drift.

### Verified

`(J20)` is 27 checks; the suite is **496** and `sweepStrays()` covers the new
fixtures. The full chain: **44 suites, exit 0, zero failures** — checked by reading
the tail and counting suite banners, not by grepping for `FAIL`, which does not catch
a suite that throws.

Smoke crawl **157 passed, 0 failed** — up from 156, with `/jobs/recurring` passing
rather than silently skipped for want of an id source, which is how two equipment
routes went unchecked in phase 11.

Demo schedules and their jobs removed from both sites afterwards; `reconcileJobSeries()`
and `reconcileAssets()` both report zero drift on site 1 and site 2.

---

## What phase 13 shipped

`sql/site/119_job_evidence.sql` — two columns and a foreign key. No new tables.

### The gap was narrower than "build a form builder"

§24 asks for custom forms. That was argued out in favour of checklist templates,
and phase 11 built them — with all eight response types, work phases and required
items. So §24 was substantially done, except for one thing.

A `photo` item asked the technician to type a **"Reference"**. A `signature` item
asked them to type a **"Name"**. Both recorded that a photograph or a signature
had happened, without holding either. For a gas certificate or a customer
sign-off that is not evidence of anything — the artefact IS the record, and a
dispute turns on having it.

### Why no new table

`party_documents` already holds files against a loose `(entity, entity_id)` pair
with an opaque generated `stored_name`, and `job_card` was already a registered
attachment target. A `job_evidence` table would have been a second copy of an
upload pipeline hardened once — including the rule in `uploads.ts` that the
user's filename never touches the filesystem.

**The link points from the item, not the document.** `party_documents` has no FK
on `entity_id` and cannot have one; the pair is loose so it can serve customers,
suppliers, GRVs and jobs. `job_card_items.attachment_id` gets a real foreign key
in the direction that works, `ON DELETE SET NULL` — deleting the file un-answers
the item rather than leaving it pointing at bytes that are gone.

### Deleting the file is the case that matters

The happy path is easy. The failure that costs a business a dispute is a job that
still reads *signed off* once the attachment is gone, so that state is handled
three times over:

- `outstandingRequiredTx` re-checks `attachment_id`, not just `completed_at` —
  **the job cannot close** over a tick with no file behind it
- `reconcileJobHeadlines` reports it as `completedWithoutEvidence`, the serious
  drift shape: every other one is a figure disagreeing with itself, this is a
  job that looks finished with nothing to show
- the check itself shows a **"File missing"** badge and un-strikes its name, with
  the capture control back — fixable where somebody is standing

`applyHeadlines` also gained `attachment_id IS NULL` in its clear-untouched
delete. Without it, reclassifying a job would have deleted the item and orphaned
the photograph — the one piece of evidence that cannot be re-taken after the
technician has driven away.

### The signature pad

`SignaturePad` is new in the kit and on the style guide. Pointer events, so
finger, stylus and mouse all draw through one set of handlers; `touch-none`,
without which the browser claims the gesture for scrolling and a signature comes
out as disconnected dots; the backing store scaled by `devicePixelRatio` so it is
not a blurry enlargement on a phone.

**It composites onto opaque white before saving.** The pad draws in the theme's
ink colour, so a signature captured in dark mode is near-white strokes on
transparency — invisible the moment it is opened in a viewer that assumes a white
page, which is every PDF and every printed job sheet. Verified by capturing one
in dark mode and opening the stored PNG: dark ink, white ground.

Accept is disabled until there is ink. A blank white PNG stored as a customer
signature is worse than no signature, because in a list it looks like one.

`evidence_required` is a stored flag rather than derived from `response_type`,
for one reason: items answered under the old rules were backfilled to 0 and stay
complete. **A job closed correctly under the rules of the day must not reopen
because the rules improved.**

### Verified

`(J21)` is 25 checks; the suite is **521**, up from 496. The chain: **45 suites,
exit 0, zero failures** — read from the log and counted, not grepped for `FAIL`.

Driven live: signed the pad over CDP, and the capture produced an 11.4 KB PNG on
disk with a `party_documents` row naming the question it answers. The download
link returns **200 with `?entity=job_card&entityId=...` and 404 without it** —
the route resolves `(id, entity, entity_id)` precisely so a guessed id cannot
walk into somebody else's paperwork, and the first version of my link omitted the
pair and 404'd.

One gap found only by looking: a completed item renders no controls, so the
signature was captured and then **invisible on the screen that captured it**. A
"View signature" link now stays on the finished row, including after the job
closes — which is exactly when somebody comes looking.

Smoke crawl **155 passed, 0 failed**. Demo data removed from both sites;
`reconcileJobHeadlines` reports zero drift on each.

**Not done:** `job_signature_statement` and `job_signature_width` have defensible
defaults but no settings screen — neither does `job_items_block_close` or
`job_headline_required` from phase 11, so the whole group wants one panel rather
than a field bolted on here.

---

## What phase 14 shipped

`sql/site/120_job_people.sql` — one table, three settings.

### Two PRD sections, one shape

§16 wants a job-level team: two technicians on one job without booking a visit
first. §13 wants followers: a manager who hears about a job without being
responsible for it. Both are "more people attached to a job", so they share one
table with a `role ENUM('assignee','follower')`.

The split into two tables was rejected **on the read**. "Every job I am involved
in" feeds the job list filter, the dashboard tile and every notification
decision, and across two tables it is a UNION that every future caller has to
remember to write both halves of. Getting it wrong does not error — it silently
shows somebody half their work. One table also makes promotion an `UPDATE`
rather than a delete-and-insert, so the row recording *when they first got
involved* survives it.

### The owner stays a column

It would be tidier to delete `owner_user_id` and make the owner "the assignee
with a flag". It stays, for the reason 104 gave it: the owner is the ONE person
answerable, it is on every list screen and index, and turning a single-valued
fact into a row somebody must aggregate is how a list screen acquires a
subquery.

So the owner is **not** a row here, and `setJobPerson` refuses to make one —
a person in both places is counted twice on every workload figure.
`everyoneOn()` adds them from the column instead.

### The bug that only pressing the button found

`setJobPerson` refused the owner. **`toggleFollow` did not.** Following your own
job wrote exactly the `ownerDuplicated` row that `reconcileJobPeople` exists to
report — caught by clicking Follow on a live screen, not by any assertion.

`everyoneOn` deduplicates, so nobody was ever emailed twice. But a row that a
reconciliation screen calls drift must not be creatable by pressing a button.
Both the server and the panel now refuse it, and `(J22)` asserts it.

Relatedly, the panel takes `ownerUserId` and not just `ownerName`: a live job on
this site has **"Naledi K" stored against user 1, Tiaan Smith**, so matching on
the snapshot name would have got the check wrong.

### Notification, on three moments

Assigned, status changed, closed — not every edit. A notification on every change
trains people to filter the lot into a folder they never open, at which point the
feature is worse than absent because everybody believes they were told.

Every send follows the `orderNotify` contract exactly: **never throws, never
blocks the state change**, and returns a reason rather than failing silently. It
is fired after the commit with `void … .catch(() => {})` from `setStatus` and
`assignOwner`, beside `recordServiceOnClose` and for the same reason. A job that
cannot be closed because a mail server is down is a far worse outcome than an
email nobody receives.

In-app notifications remain the separate platform project the plan called them.
`052_status_notifications.sql` is customer-facing order email and is not reusable
here; the header bell is still a dead button.

**A follower row grants nothing.** What somebody may see is still decided by
`jobs.view` / `jobs.view_own`. If following granted access, adding a follower
would become a way to widen permissions without touching the permissions screen.

`toggleFollow` is guarded on `jobs.view`, not `jobs.assign`: choosing to watch
something you can already see needs no authority over it, and requiring
`jobs.assign` would mean only the people who hand out work could subscribe to it.

### The test suite was emailing a real person

`(J22)`'s first run reported **"sent 1"**. This dev box has real SMTP credentials
in `.env`, so `setJobPerson` and `assignOwner` were mailing an actual user on
every run. Mail is now switched off for the whole block and restored in the
teardown — which also exercises the switch, so nothing was lost. A test suite
that mails people is a test suite somebody eventually stops running.

### Verified

`(J22)` is 24 checks; the suite is **546**, up from 521. The chain: **45 suites,
exit 0, zero failures, and no mail sent** — the last confirmed by grepping the
log for a non-zero send.

Driven live: added an assignee, watched the owner refusal fire with its own
message, followed and unfollowed a job and saw the count and button flip, then
confirmed the Follow button is **hidden for the owner** and the picker excludes
them. Smoke crawl **155 passed, 0 failed**. `reconcileJobPeople` reports zero
drift on both sites.

**Not done:** the three `job_notify_*` settings have no screen, joining
`job_signature_*` from phase 13 and `job_items_block_close` from phase 11. That
group now wants one job-notification panel rather than a field bolted onto any of
them.

---

## What phase 15 shipped

`sql/site/121_job_automations.sql` — one claim table, four settings.

### Three named rules, not an engine

§12 asks for a workflow automation engine. The plan argued that out in favour of
six named, separately-switchable rules: a general engine needs an event bus this
app does not have, plus loop detection and an execution log, and costs more
forever in support than the six anybody actually wants.

Three of the six arrived with phase 14 as notifications. These are the other
three, and what they share is that **a clock fires them rather than a person** —
which is exactly why they need a claim table and the notifications did not. An
event that fires because somebody clicked needs no record; one that fires because
a clock passed needs to know whether it already did.

| | |
|---|---|
| Escalate a breached SLA | ON — the data has existed since phase 8 and nothing ever acted on it |
| Remind before a visit | ON — claimed against the **visit** date, so moving a booking earns a fresh reminder |
| Invoice on completion | **OFF** — see below |

### Claim first, act second

Every run inserts its claim under `(job, event, day)` before doing anything. The
ordering is the whole point: claiming *after* the work means a crash in between
does it twice; claiming *before* means a crash leaves a claim with no delivery —
which `reconcileJobAutomations` reports and a person can act on.

Sending an email twice is the failure nobody notices until somebody complains.
Not sending it is the failure a screen can find.

Verified: two sweeps racing claimed it **zero times between them**, and a
backdated unsettled claim is caught as drift.

### Why auto-invoicing is the one that is off

The other two send an email, where a wrong one is noise. This creates **paperwork
against a real customer account**. It raises a *draft* and stops — finalising
stays a human act through the one posting engine — but a job closed by mistake
would still leave an invoice somebody has to find and void.

It also only looks at jobs closed in the **last 7 days**. Switching it on for the
first time on a site with four years of history must not raise four years of
invoices; that window is in the code rather than a TODO for exactly that reason.

### Two bugs the tests caught, and one the tests caused

**Both deadlines were escalated whenever either passed.** The `WHERE` matches a
row on `respond_by` OR `resolve_by`, but the per-row classification then pushed
both events on `IS NOT NULL` alone. A job that had only missed its response time
permanently consumed the resolution claim for that day — so when it later
breached its resolution promise for real, nobody would ever be told.

**Fixing it in JavaScript was also wrong.** DATETIME columns come back as driver
Dates parsed as UTC (the pool sets timezone `'Z'`) while `NOW()` runs in the
session timezone, so the two clocks disagreed and a genuinely breached job failed
the JS test while passing the SQL one. Both flags are now computed by SQL, using
the same expressions as the `WHERE`, so filter and classification cannot drift.

**And the test raised a real invoice.** `(J23)` switched `job_auto_invoice` on and
ran the sweep, which picked up an unrelated closed job in the seven-day window —
R720.00 against a real customer, with the job line stamped as invoiced. A draft
with no document number, so nothing posted and no sequence number was consumed,
but it had to be unwound by hand. The block no longer runs that sweep switched
on: what matters is provable without it, and a test that flips a money-making
switch on shared data is an outage waiting for the right dataset.

### Verified

`(J23)` is 18 checks; the suite is **564**, up from 546. Cron route driven live:
**503** with no secret configured, **401 not 307** without one and with a wrong
one, and with the right one it escalated `JC000014` — then a second tick did
nothing and reported nothing.

**43 of 44 suites pass, zero failures.** `test:navigation` fails on a search
keyword clash from another session's uncommitted `/setup/menu-designer` entry,
whose keywords include "till pos" and now outrank Tills for "rang up". Not this
phase's code and not mine to fix in a shared file.

Demo data removed, `job_notify_enabled` restored to 1 and `job_auto_invoice` to 0
on both sites; `reconcileJobAutomations` reports zero drift on each.

**Not done:** the four `job_auto_*` settings have no screen, joining
`job_notify_*` (14), `job_signature_*` (13) and `job_items_block_close` (11).
That is now eleven settings across four phases with no UI — a single job-settings
panel is the obvious next piece of work.

---

## What phases 16, 17 and 18 shipped

Three phases in one run, verified between each and together at the end.

### 16 — the settings finally have a screen

Eleven `job_*` settings had accumulated across phases 11 to 15 with no UI at all,
so every one of them had been whatever its migration seeded. They are now one
panel on `/setup/job-workflow`, beside SLA, headlines and asset types — grouped
by the question they answer rather than by the phase that shipped them: **before
a job can be closed**, **telling people**, **what happens on its own**.

No migration. `job_signature_width` is deliberately not on the screen: it is a
rendering detail with no sensible control.

**The two config warnings are the point.** Escalation and reminders do nothing
without a cron secret, and their failure is silent — every switch reads healthy
and nothing ever fires. The panel says so. Likewise, with no SMTP configured
every notification switch is decoration, and it says that too. Both are read on
the server, because `isConfigured()` reads `process.env` and a client component
cannot see it.

### 17 — bulk actions, saved views, swimlanes

`sql/site/122_job_saved_views.sql` — one table, for the only one of the three
that needs storage. Bulk actions change jobs rather than describing anything, and
grouping is a choice carried in the URL, which is the right lifetime for a way of
looking at something.

**A view stores the question, never the answer.** The same argument boards
settled in phase 1: "mine, overdue, urgent" is filters, and the jobs matching it
change every hour without anybody editing the view. A view holding job ids would
go stale the moment one closed. `(J24)` asserts the filters contain no job id.

The filters are JSON, against the grain of this schema, because a filter set is
not data the business owns — it is a saved URL. Nothing joins on it, nothing
aggregates it, and a column per filter would mean a migration every time the list
learns a new one.

**Bulk loops rather than issuing one UPDATE**, and that is the whole design.
Moving a job to a status runs `setStatus`, which stamps SLA deadlines, refuses a
close over outstanding checks, logs the change and notifies whoever is watching.
A blind `UPDATE ... WHERE id IN (...)` would skip every one of those, and jobs
changed in bulk would quietly differ from jobs changed one at a time. Slower, and
correct. Proved live: **3 changed, 1 skipped — "JC000015: This job is closed."**

The skipped list stays on screen rather than in a toast, because it is the half
somebody has to read and act on.

`setPriority` is new and small: a bulk priority change needs the SLA re-stamp
without reconstructing the whole record, and sending back fields nobody edited is
how a bulk action overwrites somebody else's change to the same job.

### 18 — the week grid

`LaneWeek` is new in the kit and on the style guide: lanes, days and blocks, and
nothing that knows what a job is. The same component would serve a staff roster
without change.

The day and week grids are separate components over the same data rather than one
grid with a zoom level. The day has a time axis and answers *who is free this
afternoon*; the week drops it entirely and answers *how loaded is next week*.
Keeping a time axis across seven days is what turns a week view into columns of
illegible slivers.

**Unassigned is a lane, pinned last** — a visit nobody is going to is exactly
what a dispatcher opens the week to find, and dropping it for having no
technician would hide it. **A visit with two people appears in both lanes**,
deliberately: showing it against the lead only would make the second person look
free on a day they are committed.

Read-only. Dragging a visit to another day or person is a reassignment needing a
conflict check, an audit trail and somebody told — a phase of its own rather than
a rider on this one.

### Verified

`(J24)` is 15 checks; the suite is **579**, up from 564. The chain: **45 suites,
exit 0, zero failures**. Smoke crawl **156 passed, 0 failed**.

Driven in the browser: the settings panel saved and survived a refresh with the
cron warning showing correctly; the board rendered swimlanes per person with
counts and Nobody last; the week grid rendered six lanes with today marked and
weekends dimmed. Demo visits removed afterwards, and `reconcileJobViews`,
`reconcileJobPeople` and `reconcileJobAutomations` all report zero drift on both
sites.

**A note on what the harness could not do.** React's controlled inputs do not
respond to synthetic `click` or `change` dispatched from CDP, so bulk selection
could not be driven from the browser. The server path was tested directly instead
and behaved exactly as the UI would — but the click-through itself is unproven,
and worth a human trying once.

---

## What phase 19 shipped

`sql/site/123_job_status_rules.sql` and `124_job_status_rules_fix.sql`.

Found by auditing the PRD itself rather than my own gap notes — which had
recorded neither of these.

### The five missing stages

104 seeded eight of the thirteen §10.1 names. Paused, Awaiting Customer, Ready
to Invoice, Invoiced and Closed are now seeded too.

**None of them claimed a role.** A role exists so code can find a stage whose
name a business changed — `assignOwner` looks for `assigned`, `closeJob` for
`completed`. Nothing needs to *find* "Awaiting Customer". Adding roles would also
have broken every existing site, because `REQUIRED_ROLES` is validated and a new
required role has no holder until somebody creates one.

Closed is the interesting one: the PRD lists it as a status, but closed-ness was
derived from the role. A "Closed" status carrying role `completed` would mean two
stages both claiming the completion meaning, and `statusForRole` would return
whichever sorted first. So it carries **no role and a new `is_closed_stage`
flag** — which is what now lets a business add a closing stage of its own.

### Rules per stage, not one global switch

§10.1 asks for three things per status that this schema decided globally:

| | |
|---|---|
| `requires_reason` | "why is this on hold?" matters; "why is this in progress?" does not |
| `blocks_on_incomplete` | **nullable** — NULL means "use the site setting" |
| `audience` | `office` keeps a technician out of the billing stages |

The blocking rule is why it had to move off a global switch: **the two closing
stages want opposite answers.** Work Completed must demand its checks; Cancelled
must not — refusing to cancel a job over an unticked check is how a job nobody
wants stays open forever.

`blocks_on_incomplete` is nullable rather than a plain boolean so "not decided"
stays distinguishable from "decided no". A boolean defaulting to 0 would have
silently switched the close guard off for every existing site.

All four rules are enforced in `setStatus`, which is the one door the job card,
the board drag and the bulk bar all go through. A consequence worth naming: **a
stage that needs a reason cannot be reached by dragging**, because a drag carries
no sentence. The card bounces back with the reason named.

### The migration that changed existing behaviour

123 turned `requires_reason` ON for On Hold and Cancelled. **(J8) failed
immediately** — a board test moves a job to On Hold with no reason.

The failure was the correct behaviour of a wrong decision. §10.1 says the rule is
*configurable*; it does not say On Hold must demand one. A migration that quietly
makes an existing stage refuse moves it used to accept breaks every site that
migrates, and the drag path can never satisfy it.

`124` reverts it. The rule stays, the seeding of it does not — a business that
wants a reason on On Hold ticks the box. Only the five **new** stages keep their
seeded rules, because nothing was moving jobs to them before.

The correction is a new file because **migrations are recorded by filename**:
editing 123 after it applied would have done nothing at all.

### Verified

`(J25)` is 20 checks; the suite is **600**, up from 579. The chain: **45 suites,
exit 0, zero failures**. Driven in the browser: 13 stages listed, three reading
as Closed (including the flag-only one), and all four rule controls rendering
with the right values.

Both sites end with `requires_reason` set on **only the two new stages** — no
existing stage was made stricter.

---

## What phases 20 and 21 shipped

The PRD asks for four Phase-1 dashboards. **Zero existed.** These are two of them,
and the shape of the answer was decided by something the audit turned up: the
dashboard at `/dashboard` is already a draggable, per-user, capability-filtered
widget grid. It simply had no job widgets.

### 20 — job widgets, not a second dashboard

Seven widgets on the existing grid rather than a new page. A dispatcher drags the
job ones up and hides the tender mix; a shop owner does the reverse. One
dashboard, arranged per person — which is what the grid was built for.

| | |
|---|---|
| Five KPI tiles | open · unassigned · under way · waiting on parts · **done, not billed** |
| Two splits | by stage, by technician |
| New reads | `jobOpsCounts()`, `jobBreakdowns()`, folded into the single overview fetch |

**Every figure is a link.** The PRD requires it — selecting "Awaiting Parts: 8"
opens those eight jobs — and a number nobody can act on is a number they stop
reading.

**`completedNotInvoiced` is not "closed jobs with no invoice".** It counts closed
jobs still carrying *billable* lines. A warranty call with nothing chargeable on
it is finished, not outstanding, and counting it would put permanent noise on the
one figure that protects cash flow. Verified against real data: it found
JC000015, closed with four filters quoted and none invoiced.

**Unassigned appears both as a tile and in the attention list, deliberately.**
They answer different questions: the attention row appears only when the count is
non-zero — it is a to-do list — while the tile is the only place a dispatcher can
see **0** and be reassured rather than wonder whether the row is missing.

No storage-key bump. A new widget id is not in anybody saved layout, so it lands
at its default and every existing arrangement is untouched.

**Two things only the screenshot caught:** the tile label repeated the card title
("Open jobs / Open / 6"), and `MiniStat` produced a stutter. Both now read as a
figure with a description under it.

### 21 — My work

`/jobs/my-work`, first in the Jobs section, because it is the screen a technician
opens and the job list is the one an office user opens.

**Actions, not statistics.** The PRD says so explicitly, and every section is
something somebody can do:

1. **A timer still running** — first, always. The commonest thing a technician
   forgets, and every hour it runs unnoticed is an hour costed to the wrong job.
2. **Where you are going** — today and tomorrow only. Further ahead is what the
   schedule screen is for.
3. **Still to do** — required checks with no answer, **named rather than
   counted**: "3 outstanding" sends somebody hunting, "Gas leak test, Customer
   signature" tells them what to do.
4. **Your open jobs** — owner or assignee, urgent first, with a *helping* badge
   where they are not the owner.
5. **Travel waiting to be checked** — last, because it is the only thing here
   waiting on somebody else.

There is no utilisation figure and no chart. A technician in a plant room does
not need their own throughput, and putting it on the screen they work from would
be measuring them with it.

**And it is not configurable.** `/dashboard` is a grid somebody arranges once and
reads all week; this is opened for thirty seconds between two jobs on a phone,
and a screen that must be set up before it is useful will not be.

`myJobs` is a UNION rather than an OR across a join — the join would multiply a
job by its people and need a DISTINCT, and the two halves answer genuinely
different questions ("answerable for" versus "working on").

### Verified

**45 suites, exit 0, zero failures** — `test:navigation` included, the other
session having fixed the keyword clash. Smoke crawl **157 passed, 0 failed**,
with `/jobs/my-work` discovered automatically.

Driven in the browser on real data: the dashboard showing 6 open, 1 unassigned,
3 under way, 1 waiting on parts, 1 done-not-billed; My Work showing today's 14:00
visit, JC000014 naming both outstanding checks, and five open jobs urgent-first.
Demo data removed, and all three reconcile functions report zero drift on both
sites.

**Outstanding from the audit:** 3 of 15 reports. Time & labour, travel and
appointment performance still need catalog sources — those tables are not exposed
to the report builder at all.

---

## What phase 22 shipped

Three report sources, and the templates they unlocked.

### The sources are the durable half

`jobTime`, `jobTravel` and `jobVisits` expose `staff_time_entries`,
`job_card_travel` and `job_card_appointments` to the report builder. Those
tables had existed since phases 5, 6 and 4 and were never in the catalog —
which is why twelve of the PRD's fifteen Phase-1 reports could not be expressed
**even by hand**.

A source outlasts any template built on it: once a table is in the catalog,
anybody can answer a question nobody anticipated without a developer. That is
why this phase led with sources rather than with the fifteen reports.

**153 fields across the five job sources**, every one verified to produce
runnable SQL against the real database — the `(J15)` probe runs each field as
its own one-column report.

Three decisions worth naming:

**Time and travel date from their own event, not from the job.** A line dates
from its job, because a part added on Friday to a Monday job belongs to Monday's
cost. But a trip made on Friday *is* a Friday trip — a travel report scoped to
last week must show last week's driving, not the driving on jobs logged last
week.

**`jobTime` joins to `job_cards` with an INNER JOIN, and the join is the
filter.** `staff_time_entries` holds every clock-in in the business, most with
no job at all — it is the till's timesheet table too. A LEFT JOIN would have
reported a shop assistant's Tuesday as job time.

**A running timer contributes NULL minutes, not zero.** Counting it as zero
understates a technician's day; counting it up to `NOW()` makes the same report
give a different answer every time it runs.

### Five templates, not twelve

| | |
|---|---|
| Time and labour on jobs | hours by person, net of breaks |
| Travel on jobs | all four distances, biggest overrun first |
| **Travel nobody has checked** | money owed, or money that should not be paid |
| Did we turn up on time | on time = within 15 minutes, per the PRD |
| **Visits that did not happen** | a customer whose name repeats is one about to leave |

Eight job built-ins now, still short of fifteen — the PRD's own advice is "avoid
building too many specialised reports initially", and the builder is the answer
to the rest. The count is asserted so adding one is a decision rather than a
drift.

### A gap the tests had

`(J15)` filtered templates on `startsWith('jobCard')`, which covered the two
phase-9 sources and would have **silently missed all five new templates**. Now
matched against the source list itself, so the next source cannot slip through
the same hole.

### Verified

The suite is **633**, up from 600. **45 suites, exit 0, zero failures.** Smoke
crawl **157 passed, 0 failed**.

Every job template run against real data — all eight return rows, including the
two that protect money: `job-travel-unverified` found two unchecked trips and
`job-visits-missed` found four. Opened `Travel nobody has checked` in the
browser: two rows, columns reading Date · Job number · Who drove · Recorded km ·
Over the expected · Travel charge · Over the tolerance. Zero drift on both sites.

**Reports now stand at 8 of 15 named**, with every remaining one expressible in
the builder — the three missing sources were the real blocker, and they are gone.

---

## What phase 23 shipped

Deposits (§33). **No migration** — a deposit is a customer receipt, which this
app already knows how to record.

### The mistake, and how it was caught

The first version called `postTransaction` directly. That writes the **debtors
side only**: the customer owes less, and the money appears in no bank account.
Every deposit ever taken would have left the cash position understated, and
somebody would have had to re-key the receipt on the cashbook to put it right.

It was found by reading what `postTransaction` actually does rather than what
its name suggests — a comment claiming it wrote "the balance update and the GL
mirror" turned out to be wrong on the second half.

It now goes through `recordCustomerReceipt`, which does both halves in the order
the cashbook chose: ledger first, bank row second, so a failure in between leaves
an unlinked receipt rather than a bank row pointing at a payment that does not
exist. `(J26)` asserts **both** balances move, which is the assertion that would
have caught it.

`ReceiptInput` gained an optional `source`/`sourceDocId` so a deposit is findable
as one. Additive: every existing caller still defaults to `'receipt'`.

### Three decisions

**It does not allocate itself.** A deposit sits as an unallocated credit until
somebody settles it against an invoice. Auto-allocating on invoicing would look
helpful and be wrong — a job can raise more than one invoice, and the deposit
would land on whichever came first rather than the one the customer meant.

**The bank account is required, not defaulted.** Money received has to be
received into something, and a default would be this module inventing an
accounting fact.

**Two capabilities.** `jobs.edit` says you may change this job; `cashbook.edit`
says you may record money received — which the cashbook screen requires for the
identical act. Guarding on `jobs.edit` alone would have let a dispatcher write
into a bank account through a door the cashbook keeps shut.

The panel leads with what is **still to pay**, not with the deposit: a deposit
alone is a number nobody can act on. Where the job has no accepted quote there is
nothing to measure against, so the balance line is absent rather than invented.

### Verified

`(J26)` is 13 checks; the suite is **646**, up from 633. **45 suites, exit 0,
zero failures.** Both sites end with zero deposits, zero orphans and zero stray
bank rows — the fixture unwinds both balances.

**Not verified in a browser.** A concurrent session has `(pos)/PosShell.tsx` and
`TableGate.tsx` mid-edit with 16 type errors, so the production build cannot
compile and the panel could not be rendered. The data layer is proven by test;
the panel is not.

---

## What phase 24 shipped

The calendar feed (§14.2). No migration, no stored token, ~200 lines.

### Read-only, and that is the design

The PRD spends four pages on two-way sync and never settles "which side wins".
This is the ninety per cent that needs none of it: a technician subscribes once
and their own phone shows their day, in whatever calendar app they already use.

There is **no write path at all**, so the question the PRD wrestles with — a
technician deleting an event and cancelling a job — cannot arise. Deleting the
event unsubscribes them from a row that simply comes back.

### The URL is the credential

Google, Outlook and Apple all fetch on a schedule with no browser and no cookie.
So the token is a signed JWT naming one user on one site, minted per request and
**never stored** — it is derived, so rotating `SESSION_SECRET` revokes every
subscription at once with no table to clear.

It carries **no expiry**, deliberately. A subscription is set up once and polled
for years; a URL that dies after a day is a feature that stops working with
nothing to tell anybody why. The cost is stated in the file: a leaked URL exposes
that person's schedule until the secret rotates. Which is why the feed carries no
prices, no costs and no margins — the worst case is somebody learning where a
technician will be.

`'/api/jobs/calendar/'` is in `PUBLIC_PREFIXES` with its trailing slash. Without
it, a calendar service fetches the login page for ever and renders an empty week
with no error — the failure that looks exactly like "nothing is booked".

### Five details that decide whether the file works at all

An invalid `.ics` fails in the worst way: the app rejects it silently and shows
an empty calendar.

| | |
|---|---|
| **Escape the backslash first** | otherwise escaping `,` and `;` double-escapes what was just added |
| **Fold at 75 OCTETS** | an emoji is four bytes; a character count produces lines legal by length and illegal by size |
| **Split on code points** | half a surrogate pair is invalid UTF-8 and can take a parser down |
| **CRLF throughout, and a trailing one** | Outlook rejects a file that ends without it |
| **A stable UID** | a calendar matches by UID — if it moved when a visit was edited, the subscriber would hold the old booking *and* the new one |

A cancelled visit publishes as `STATUS:CANCELLED` rather than being dropped: a
calendar only removes an event it is told about, so a row that vanishes from the
feed just stops being mentioned — and the technician drives to a call that was
called off.

### Verified

`(J27)` is 19 checks; the suite is **665**, up from 646. **45 suites, exit 0,
zero failures.** Smoke crawl **157 passed, 0 failed**.

Fetched live: **200 `text/calendar`** (not a 307 to login), **404** for a bad
token, and a valid calendar naming the technician with the visit at 09:30–11:00.
The subscribe card on My Work hides the URL until asked for and warns that it is
a password. Demo visit removed; no orphaned assignees.

Also verified this turn: the **phase 23 deposits panel**, which the previous
turn could not build because of a concurrent session's type errors. It renders on
the Quotes tab as intended.

---

## What phase 25 shipped

Named crews (§16) — "the North crew" — as a way of putting three people on a job
in one press. `sql/site/126_job_teams.sql` (125 was taken by a parallel session),
`src/lib/site/jobTeams.ts`, a panel on `/setup/job-workflow`, a picker on the job,
and two drift tables.

### A crew is a shortcut, not an owner

The tempting schema is `job_cards.team_id`. It was rejected, and the reason is
the whole design:

Selecting a crew **expands** into individual `job_card_people` rows, and the job
then knows only the people. Nothing else has to be taught anything. My Work, the
board lanes, the workload figures and the notification recipient lists all read
`job_card_people` and keep working untouched — a `team_id` would have required
every one of them to learn about a second source of "who is on this job", and
would have silently returned half the answer wherever somebody forgot.

The second consequence is the one users feel: **editing a crew does not reach
backwards.** Take somebody off the North crew and January's jobs are untouched,
because those jobs copied the names when the crew was applied. Deleting a crew is
therefore allowed with no refusal at all — unlike a status or a headline, both of
which refuse while anything points at them. The confirm dialog says exactly that
rather than implying a risk that is not there.

### It goes through the same door

`applyTeamToJob` calls `setJobPerson` per member rather than doing one bulk
`INSERT`. That door refuses the owner, refuses an inactive user, logs the change
and fires the assignment notification — and a crew that bypassed all of it would
produce jobs subtly unlike the ones assigned one name at a time. The cost is
honest: a five-person crew is five round trips and five emails. Both are correct.
Five people were each given work.

The crew is named in the activity log and **nowhere else**. After expansion the
job knows only the people, so the log is the only record that a crew was chosen
rather than three names picked individually.

### Two bugs, one found by a test and one only by a picture

**Applying a crew twice reported "2 added" having added nobody.** `setJobPerson`
is deliberately idempotent — its `INSERT` is `ON DUPLICATE KEY UPDATE`, which is
how a follower gets promoted — so re-applying succeeded on every member and
counted each as an addition. It would also have sent two people a second email
about work they already had. Fixed by reading who is already on the job first;
an existing **assignee** is skipped and named, while an existing **follower** is
still promoted and still counted, because that genuinely changes their role.

**The panel claimed the lead becomes the job owner.** It does not — and the
screenshot proved it, with "2 added" beside an "Assigned to: Nobody" field.
Making the claim true would have been the worse fix: a crew put on a job that
already has an owner would silently take the job off them. So the lead is what it
actually is — who to ask about this crew — and the hint, the drift description
and the test label were all corrected to match.

### Verified

`(J28)` is 24 checks; the suite is **689**, up from 665, exit 0. Typecheck clean,
`check-ui-kit` clean, build clean, migration 126 applied to sites 1 and 2.

Driven live in Chrome rather than only compiled: the dialog refuses an empty
form, ticks the first person as lead automatically, keeps exactly one lead when
the lead is moved, saves through the real action ("Second Person (leads), Tiaan
Smith"), and the job's picker offers the crew with its size. Applying it put
**two individual rows** on job 12 with the person picker correctly reporting
"Everybody is already on this job". Site 1 restored exactly as found — crew,
people, activity rows removed and job notifications switched back on.

---

## What phases 26–29 shipped

Four features, five migrations (127–131), and the two that face the public are
the reason this section is long.

### 26 — Custom fields, as a module rather than a job feature

`custom_field_defs` + `custom_field_values` (127), serving **jobs, customers and
equipment**. The plan warned that a general mechanism built inside job cards ends
up job-shaped; the defence is that `entity` is a parameter everywhere, nothing in
the module mentions a job, and a fourth entity would need no edit to it.

Three refusals carry the design:

| | |
|---|---|
| **The type is frozen once anybody fills it in** | a date becoming a number makes every existing answer unreadable. Nothing fails at the database — the values are text — which is exactly why it is refused in code |
| **A field holding answers cannot be deleted** | the FK cascades, so allowing it would silently destroy every answer. Retiring is offered instead |
| **Each entity's action pins its own entity** | the panel is shared, so `entity` arrives from the client. A `customers.edit` holder must not be able to write job fields by changing a prop |

Emptying a value DELETES its row rather than storing `''`, so "never answered"
and "answered, then cleared" stay distinguishable — which a required-field check
depends on.

### 27 — Feedback: one star, one sentence

`job_feedback` (128), a 60-day signed token with its own audience, a public page
at `/feedback/[token]`, and the request fired when a job closes — **off by
default**, because switching it on emails every customer from the business's own
address.

Asking and answering are separate events: `requestFeedback` writes a row with
`requested_at` and no rating, so rows with no `responded_at` are people who were
asked and said nothing. That is what makes a response RATE real rather than
guessed. The row is claimed BEFORE the email goes, so a job closed, reopened and
closed again asks once.

The public page shows the job number and title and **nothing else** — no
customer name, no money, no phone number, no staff name. Verified by fetching it
and grepping for each.

### 28 — Intake: a holding area, not a job

`job_requests` (129). The load-bearing decision: a public submission does **not**
become a job and does **not** become a customer. It sits in a queue until
somebody matches it to an account and presses Accept.

That is also how the rest of the app already behaves — a guest booking is a
`reservations` row with loose contact strings, a guest order carries a nullable
customer link, a product review has none at all, and there is exactly one
`INSERT INTO customers` in the codebase that no public path reaches.

Guarded by what reservations already proves: a **honeypot answered with a
fabricated success** (a bot that is told it failed tries again differently), a
**per-phone daily cap**, and a switch that fails closed. No IP blocking and no
captcha — the repo has neither, and building a general rate limiter inside a
job-cards feature would be a platform decision made in the wrong place.

Verified through the real form: the submission produced **one row, zero jobs,
zero customers**, and accepting it raised JC001221 with `source='public_form'`,
the customer's own words kept, and the request marked accepted with who decided.

### 29 — The portal, and what a customer may see

Magic-link sign-in (130), plus **131** — two columns, `is_customer` and
`is_visible`, on `party_comments` and `party_documents`.

131 is the one to understand. Those tables were staff-only: every comment in them
was written by somebody in the back office ABOUT a customer. Both columns default
to **0**, so switching the portal on publishes nothing written before it existed.
Verified: zero pre-existing comments became visible.

**What a customer sees:** their jobs and stage names, booked visits, issued
quotes, finalised invoices, shared files and messages, and custom fields marked
public.

**What is withheld, deliberately:** cost, margin, internal notes, which
technician is assigned, hours worked, kilometres driven, draft invoices, and
anything belonging to anybody else. `portalData.ts` names every column in every
SELECT for this reason — a `SELECT *` would publish whatever column somebody adds
to `job_cards` next year.

Access control is one boring rule applied everywhere: **the customer id from the
session appears in the WHERE of every statement**, so another customer's job
returns nothing rather than something. Verified over HTTP — job 1222 returned
**404**, identical to a job that does not exist.

The link is 32 random bytes, stored **hashed**, **single use**, and 30 minutes
long. `consumeLink` does its UPDATE first with `used_at IS NULL` in the WHERE, so
the database decides the race and two simultaneous clicks produce one session.

Paying reuses `/pay` rather than rebuilding it: the portal mints a payment intent
with the `debtor_invoice` purpose 038 already anticipated, and hands off.

### Five bugs the probes caught

1. **`portalAuth` queried `customers.is_active`** — that column does not exist. Every sign-in would have thrown.
2. **`portalData` assumed four things that were not there**: `party_comments.is_internal`, `party_documents.original_name`, a `job_appointments` table, and `sales_documents.doc_date`. An earlier claim that partyComments already split visible from internal was simply wrong — hence 131.
3. **The enter route was a page, and a page cannot set a cookie.** Next refuses cookie writes outside an action or a route handler. Rewritten as a Route Handler, which is the one primitive that is both a GET and allowed to write.
4. **`applyTeamToJob` counted no-op re-assignments as additions** (phase 25).
5. **The cross-audience token test passed vacuously** — `createCalendarToken` takes positional arguments, so it was rejecting a malformed token rather than a real one.

### Verified

Four module probes: **29 + 29 + 44 + 36 checks, all passing.** Typecheck,
`check-ui-kit` and `next build` clean. Migrations 127–131 applied to sites 1 and
2, with columns confirmed present on both by `SHOW COLUMNS`.

Driven live in Chrome for each: the custom-field dialog's live refusals, a real
field saved and filled in on a job, the feedback form's five keyboard-operable
stars and a 2-star rating landing flagged "Worth a look", the intake form's
hidden honeypot and progressive enabling, and the portal's whole journey —
sign-in, single use proven by a second click, job list, job detail, a message
sent and attributed to the customer.

One thing the browser showed that no assertion would: a browser **signed into the
back office as staff** is still sent to the customer sign-in. The two session
types are properly separate.

Two pre-existing failures remain and are not from this work: `test:serials` fails
on leaked `INS*` instruction fixtures (the documented instructions-suite leak),
and the smoke crawl's `/sales/[id]/bill` 404s because it sampled a finalised
invoice, which has no bill to show.

---

## What phases 30–31 shipped

### 30 — The checklist template bug

A defect found by the phase 26–29 audit and fixed here, because it was quietly
destroying reporting that the schema was built for.

`saveHeadline` replaced its items wholesale — `DELETE` then re-`INSERT` — on the
stated grounds that a template is a short list somebody edits as a whole and
diffing bought nothing. That reasoning was wrong, and the cost was invisible:
every re-insert allocated fresh ids, and `job_card_items.headline_item_id` is
`ON DELETE SET NULL`, so **every prior job's link back to its template item was
nulled on every save**. Correcting one typo destroyed it, and nothing said so.

`114_job_headlines.sql` keeps that column for one purpose — reporting on which
kind of work generates the most unfinished tasks — so the damage landed exactly
where nobody would look.

Now an item arriving with an id is UPDATED, one without is inserted, and only ids
the user actually removed are deleted. The client half already sent the ids; only
the server was throwing them away. Parts stay a wholesale replace, because
nothing copies a part id onto a job.

The `UPDATE` carries `headline_id = ?` in its WHERE, and that is not decoration:
the id arrives from a form, so without it somebody could edit an item belonging to
another template by changing a number. Asserted.

**16 checks**, including the one that matters: after an edit, the job still points
back at the template (2 of 2 linked), while keeping its own snapshot wording.

### 31 — The remaining seven reports

Where the work is · Jobs past their date · Work by customer · Promises that were
missed · Costs nobody has decided about · What was written off · Billable work
not yet invoiced.

**No new code.** Seven specs against sources that already existed — which is the
dividend phase 22 was for.

Two things the verification caught that a typecheck could not:

**A blank column that looked broken.** `jobs-open-by-stage` grouped `MAX(daysOverdue)`,
and the job version of that field is `DATEDIFF(now, due_at)` with no clamp — so a
job not yet due is a NEGATIVE number, and a stage with nothing late rendered
empty. Swapped for `MAX(daysOpen)`, which answers the same question honestly.
`jobs-overdue` still uses the field, where its `> 0` filter guarantees the sign.

**Three reports gated too tightly.** I put the cost-bearing ones behind
`jobs.cost` and `jobs.invoice`. `(J15)` refused them, and it was right: every job
template is gated on `jobs.view` and **degrades** for somebody without the cost
right — a saved report should open with fewer columns rather than refuse. Tighter
permissions would have defeated the mechanism the plan asked for.

The `(J15)` count assertion moved from 8 to 15, which is what it exists for: it
made adding reports a decision somebody records rather than a drift nobody sees.

### Verified

**16 + 15 checks** across two probes; every one of the fifteen job reports RUN
rather than typechecked, old and new, plus their degraded form for a technician.
Typecheck, `check-ui-kit`, build and `test:job-cards` all clean. Smoke crawl
reports only the pre-existing `/sales/[id]/bill` sampling failure.

Confirmed on screen: all seven appear in `/reports`, and `jobs-open-by-stage`
renders 5 stages over 8 jobs with the full toolbar working for free. Three of the
seven return no rows, and each was checked against the database — genuinely no
overdue jobs, no late responses, no written-off lines — with the write-off report
proven to return data by borrowing one line and putting it straight back.

---

## What phase 32 shipped

The job card as a document a customer can be handed — the only customer-facing
artefact the module lacked, and the thing that makes the signature capture built
in phase 13 worth something. `src/lib/jobs/render.ts` + `src/lib/jobs/pdf.ts`
behind `GET /api/jobs/[id]/report`. No migration.

### What may appear is decided in one place

The `render`/`pdf` split copies `statements/`: the render module assembles and
decides, the pdf module only draws. So a future preview screen cannot disagree
with the printed sheet, and "may a customer see this" has one answer.

Withheld, matching what [portalData.ts](src/lib/site/portalData.ts) already
enforces: cost, margin, `internal` and `written_off` lines, `pending` lines
(nobody has decided who pays), internal notes, and staff names beyond whoever
signed. Every field is **named** in the mapping rather than spread — `{...line}`
would publish `costExcl` the day somebody widens `JobCardLine`.

On the live fixture that meant **4 billable lines shown and 5 withheld**.

### Three bugs, and only one was in my reasoning

**Every image silently failed.** `JobItem.attachmentName` is
`party_documents.filename` — the *display* name. Passing it to `readStoredFile`
finds nothing, so every photograph fell back to "could not be shown" while the
PDF still rendered and looked plausible. The stored name is now fetched
explicitly, and deliberately not added to `JobItem`: a stored name is a path
component and should travel as little as possible.

**A malformed PNG killed the whole node process.** pdfkit's decoder inflates the
pixel data on a *later tick* and rethrows from inside a zlib callback — so the
error arrives with no caller on the stack, escaping the try/catch at the draw
site, escaping the Promise, and taking the server down. `doc.image()` had already
returned successfully. `isDrawable()` now does the same inflate synchronously,
where a throw is catchable. A corrupt customer photograph must not be able to
stop the server.

Worth recording: **pdfkit sniffs content, not the extension** — a PNG saved as
`.pdf` is still decoded as a PNG, so checking the filename proves nothing.

**Raw values on a customer document.** The first render printed
`2026-08-12T18:00:17`, the enum `on_site`, and "Callout to Parow · qty 29" with
no unit. All three were invisible to assertions and obvious in a picture. Dates
are now formatted by hand (not `toLocaleString` — the server's locale is not the
customer's), the status uses the existing `APPOINTMENT_STATUS_LABEL`, and the
quantity carries `LINE_KIND_UNIT`, so it reads **"29 km"** and **"2 hours"**.

### The one I chased that was not a bug

The signature appeared to be missing for four rounds of investigation. The
layout was correct throughout — the test fixture was a **64×64 RGBA icon**
borrowed from `uploads/`, scaled into a 200×60 box and easy to miss. Rendering a
real 600×200 signature proved the path works. The lesson is the cheaper one:
when the code and the picture disagree four times, suspect the fixture.

### Verified

Typecheck, `check-ui-kit`, production build and `test:job-cards` /
`test:navigation` / `test:invoicing` all clean. Smoke crawl reports only the
pre-existing `/sales/[id]/bill` sampling failure.

Driven end to end in Chrome against a fixture carrying a real photo, a real
signature, a file whose bytes were deleted, and a file pdfkit cannot decode: the
first two embed, the last two fall back to *"The attached file could not be shown
here."*, a failed check prints red, results group by work phase, and the charges
table repeats its header across the page break. Fixture removed; site 1 verified
back to its prior state by query.

**Not built here:** the sign-off block is drawn but empty — phase 33 fills it.
Laid out now so the page is not designed twice.

---

## What phase 33 shipped

**Two-party sign-off.** `159_job_signoff.sql` puts six columns on `job_cards` —
`{customer,technician}_signed_{at,name,signature_id}` — plus the setting
`job_signoff_required` (`none` | `customer` | `both`, defaulting to `none`).
`src/lib/site/jobSignoff.ts` is the module; `JobSignoffCard` is the screen, on
the Checks tab beside the pad it reuses.

### Why columns and not two checklist items

It very nearly is two checklist items, and that is the honest starting point:
114 gives an item a `response_type` of `signature`, 119 attaches a real drawn
PNG, and a site can already make one mandatory before closing. Everything here
reuses that machinery — the same `SignaturePad`, the same `party_documents` row,
the same uploads directory.

What it cannot do is answer a question. Nothing in the schema knows *which*
signature item is the customer's: both are rows whose name somebody typed, and
the wording differs per site and per kind of work. So "completed jobs missing a
customer signature" — a report the PRD names — would mean matching on
configurable text. Two named pairs make it one indexed read.

### Three decisions worth keeping

- **`signed_name` is typed, not looked up.** The person holding the tablet is
  often not the person on the account — a foreman, a receptionist, a tenant. The
  technician side defaults to the actor because there the two nearly always
  agree; the customer side never does, because that name is not ours to give.
- **A closed job refuses a signature.** Without that, a job could close unsigned
  and be signed at leisure afterwards, which makes the whole rule decorative.
- **Withdrawing clears the claim, not the evidence.** The document row stays on
  the Files tab, exactly as `captureEvidence` leaves a replaced photo. A customer
  who re-signed because the first mark smudged has not made the first one untrue.

**Cancelling is never blocked**, deliberately — refusing to cancel a job because
nobody signed for work that never happened is how a job nobody wants stays open
forever. This is a *separate* rule from the checklist guard beside it, which asks
whether the STAGE demands its checks.

### Two bugs the probe caught

- **`missingSignoff` read `job_cards` through the pool while inside
  `setStatus`'s transaction** — a second connection waiting on a lock the caller
  itself holds, which would have surfaced as a hung close rather than an error.
  Now takes the `PoolConnection`, matching `outstandingRequiredTx`; the setting
  read stays on the pool, matching `itemsBlockClose`.
- **The fixture leaked a cancelled job**, which then failed the customer delete
  with a foreign key error and took the whole suite down at its last line.
  `TITLE_PATTERN` is `'JCT %'` with a space and matches **none** of this suite's
  titles — every fixture registers its own regexp, and mine had not.

A third was self-inflicted and worth recording: the drift assertion originally
checked only `Array.isArray`, which passes on an empty array. Tightened to name
the fixture, it immediately failed — the job was still `'both'`-blocked and had
never closed.

### Verified

Typecheck, `check-ui-kit`, production build, and `test:job-cards` (22 new J29
assertions) / `test:navigation` / `test:invoicing` all clean. Smoke crawl reports
only the pre-existing `/sales/[id]/bill` sampling failure.

Driven end to end in Chrome: a real pointer stroke on the pad, uploaded, filed,
and read back — the header narrowed from "customer and technician" to
"technician", the button became Withdraw, and the same mark then appeared **above
the rule** on the PDF beside "Mrs Adams" and its timestamp. Site 1 verified back
to its prior state by query, including the uploaded PNG removed from disk.

**Noticed, not fixed:** job 1222 on site 1 is `PORTAL PROBE other customer job`,
litter from the phase 29 probe. Left alone rather than swept blind — it is not
this phase's, and deleting somebody else's fixture is how a suite loses a row it
was relying on.

---

## What phase 34 shipped

**Expenses as a line kind.** `160_job_expenses.sql` widens
`job_card_lines.line_kind` to include `'expense'` and adds two nullable FKs:
`supplier_id` (who was paid) and `expense_category_id` (which bucket it lands in
on the P&L, reusing 042's categories). `'expense'` joins `LINE_KINDS`, so the
picker, the labels and the units all follow.

### Why not keep using `charge`

Because it works, which is the honest starting point — 104's own comment says a
subcontractor invoice is a `charge` with `product_id` NULL, and it is right: the
cost lands in the total and the margin is correct. What it cannot do is
*report*. A callout fee, a disposal fee and a R14,000 subcontractor invoice are
one undifferentiated bucket, and not one of them names who was paid.

**Existing `charge` rows are left alone.** Reclassifying them would rewrite
history to fit an enum value that did not exist when they were written, and a
callout fee genuinely is a charge. The cost is that the first quarter after this
ships has expenses in two places — visible and explicable, where rewritten
history is neither.

### The drift the compiler could not catch

The typed union means adding a value makes the compiler name every
`Record<JobLineKind, …>` — and it did, across `JobLineInput`, the drafts in
`JobDetail` and seventeen test fixtures. But it found **nothing** at
[catalog.ts:3575](src/lib/reportBuilder/catalog.ts#L3575), which spelled the four
values into a plain `string[]`. The field would have kept working, kept
filtering, and simply never offered or matched an expense — a report of
"everything except parts" quietly omitting the whole new category.

Fixed by spreading `LINE_KINDS` itself, so the next kind appears there by
construction rather than by somebody remembering. A J30 assertion now names all
five values, so this cannot regress silently.

### A supplier belongs to an expense, enforced in the action

`saveLines` clears `supplier_id` and `expense_category_id` on any kind but
`expense`. Not a UI concern: the kind can be changed on a row that already
carries them, and a create-time check would miss exactly that case. A labour
line that arrives carrying a supplier is a labour line with no supplier.

### What the browser caught that the tests could not

The supplier picker was silently wrong. `listSuppliers` **hard-caps at 500** and
this site has **844 active suppliers** — so the picker would have offered
whichever 500 sorted first with nothing on screen saying the rest existed. A cap
is right for a paged screen and wrong for a picker, which has to be able to name
anything. Now `supplierOptions()`, uncapped and active-only.

The same screenshot showed **four options reading "Adams Cash & Carry"** — real
distinct suppliers with different codes and different balances. The code is now
part of the label, because picking the wrong one puts a spend report against the
wrong account.

Both were invisible to every assertion: the data was correct, the query
succeeded, and the control rendered.

### Verified

Typecheck clean, `check-ui-kit` clean, `test:job-cards` (9 new J30 assertions),
`test:invoicing`, `test:report-columns` and `test:purchasing` all pass. Smoke
crawl reports only the pre-existing `/sales/[id]/bill` sampling failure.
Migration applied to sites 1 and 2, both confirmed carrying all five enum values
and the two FKs; site 1 verified free of fixtures by query.

Driven in Chrome: Expense appears as a fifth add button, the sub-row renders
"Paid to … for …" indented under the description — a sub-row rather than two
more columns, because only one kind of five uses them and two permanently-empty
columns would narrow the description on every part, hour and kilometre.

**Two failures that are not from this work**, both confirmed by reverting the
catalog to HEAD and re-running: `test:report-templates` fails
`jobs-open-by-stage` and `jobs-by-customer` on a `__rows` sort, which is a
synthetic row-count field unrelated to `line_kind`. Also, the production build's
type-check gate is currently blocked by another session's in-progress edits to
`TerminalsClient.tsx` and `LicencesPanel.tsx` — the build compiles, and every
file in this phase typechecks clean.

**Not changed:** `job_headline_parts.line_kind` keeps its four values. That table
requires a `product_id`, so it cannot hold an expense — offering the value on the
template screen would put a choice there that saving would refuse.

---

## What phase 35 shipped

**Multiple assets per job (§18.4).** `161_job_assets.sql` adds `job_card_assets`
plus a nullable `asset_id` on `job_card_lines` and `job_card_items`.
`job_cards.asset_id` **stays, and stays primary**.

### Why both, rather than migrating to a join table

115 argued the single column deliberately — "a join table would mean every cost,
every check and every warranty question needed to say WHICH asset it belonged
to" — and that argument still holds. So the existing data does not move: the
primary asset remains the answer whenever nothing says otherwise, and the join
table adds the *others* on the visit.

115 also said, in the same breath, that "a join table can be added later without
moving the ones already recorded". This is that, done the way it said.

A part or a check MAY name one of the others, and usually will not. `asset_id`
on those tables is nullable because NULL means the job's asset, which on the
overwhelming majority of jobs is the only possible answer — and on a four-unit
job it honestly records that the technician did not say, which beats forcing a
guess a warranty claim would later rely on.

### The read that had to keep working

This was the whole risk, and it was bigger than the plan estimated: `WHERE
asset_id = ?` appears **eleven** times in `jobAssets.ts`, not five. The history
query, three `job_count` subqueries, an open-job count, `recordServiceOnClose`,
the setter, the unlinker, and two drift checks.

Fixing only the history leaves an asset showing four jobs on its own screen and
six in the history below it — neither number obviously wrong. So every count
goes through one shared fragment, and the two most consequential reads were
changed deliberately:

- **`recordServiceOnClose`** now services *every* unit on the visit. Left as the
  primary alone, three of four would still show as due, and somebody would drive
  out to a unit serviced last week — the due list being the screen this whole
  feature exists to feed.
- **`assetHistory`** spans both and carries `isPrimary`, badged on the equipment
  page. "We came out for this" and "we checked it while we were there" are
  different facts about a warranty.

### The bug only a live query could find

The obvious shared fragment — `(SELECT COUNT(*) FROM (<union on a.id>) jc)` —
**MySQL will not run**. A derived table cannot see a column from the enclosing
query, so it fails with `Unknown column 'a.id' in 'WHERE'`. It typechecks, it
reads correctly, and it throws the first time a screen loads. Caught by running
the queries against site 1 before building any UI on them; replaced with a
correlated `COUNT(*) … WHERE primary OR EXISTS(join table)`, which also counts
each job once without needing DISTINCT.

### Verified

Typecheck and `check-ui-kit` clean; `test:job-cards` (12 new J31 assertions),
`test:navigation` and `test:invoicing` all pass. Smoke crawl reports only the
pre-existing `/sales/[id]/bill` sampling failure. Migration applied to sites 1
and 2, both confirmed carrying the table and both new columns.

Driven end to end in Chrome: the picker offered only the second unit (correctly
excluding the primary and anything already added), the note saved, the card
showed "Also on this visit (1)", and the secondary unit's own equipment page
showed the job badged "Also on this visit" — the read that would otherwise have
silently returned nothing. Site 1 verified back to its prior state by query.

**Guards, all asserted:** the primary is refused as one of the others (it is the
subject, not a member); adding the same unit twice says so; a closed job refuses
equipment changes; and removing a unit keeps the parts and checks, because
`fk_jcl_asset` and `fk_jci_asset` are `SET NULL` — the work happened, only the
claim about which unit is withdrawn.

---

## What phase 36 shipped

**Stock ordering (§28).** The largest genuine gap: today a technician who needs
a part that is not on the shelf gets *"BRK-PAD-01 has only 0 in Main Store —
cannot move 4"* and there is nowhere to go from it. Now they can ask.

`162_job_part_requests.sql` adds `job_part_requests`, modelled on
`leave_requests` (058) — the repo's one true requested-then-approved table.
`163_purchase_line_job_link.sql` adds `job_card_line_id` to
`purchase_document_lines`. `src/lib/site/jobPartRequests.ts` is the module,
`/jobs/part-requests` the buyer's queue, and a card on the job's Costs tab is
where the asking happens.

### Three rules that keep this safe

- **The job module raises no purchase order and writes no stock movement.**
  `linkToOrder` takes a purchase line id that somebody else created; nothing
  here calls `saveOrder` or `recordMovement`. Same discipline that kept
  `finaliseDocument()` the only posting engine.
- **A request reserves nothing**, and the screen says so in as many words.
  `jobParts.ts:23-41` records that a job reservation folded into
  `reservedQtyFor()` was designed and deliberately dropped, because the same
  unit would be deducted twice for every part in every van, permanently. A part
  that does not exist yet must certainly not reserve anything. Asserted by
  counting `stock_movements` across the request.
- **A request is not a document** — no sequence number burned on something
  usually declined, the doctrine `job_requests` (129) already set.

### The severing trap, and what closes it

`saveOrder` rewrites its lines wholesale — `DELETE FROM purchase_document_lines
WHERE document_id = ?` then re-INSERT. So a buyer editing an issued order to fix
one quantity would blank `job_card_line_id` on **every** line, and nothing would
report it: the order still exists, the parts still arrive, and no job knows they
were its.

Closed three ways: `jobCardLineId` is on `OrderLineInput` and re-supplied on
every save; it is read back onto `PurchaseLine` and carried through `GridLine`
and the edit page so it survives the round trip; and
`reconcileJobPartRequests()` has a bucket for "ordered, but the purchase line
has vanished" if it is ever got wrong anyway.

### The claim precedes the bell

`markReceivedForDocument` scopes its UPDATE `WHERE status = 'ordered'` and
notifies only what that UPDATE actually claimed — `lowStockAlert.ts:85`'s
pattern, so a dead channel means one missed message rather than one on every
receipt for ever. Asserted by running the receipt tail twice and counting one
notification.

It is also **the first producer of `notify()`'s `userId` field**, which migration
155 shipped with no producer: "your part has arrived" is a message for the person
who asked, not for the shop.

### Two bugs the live probe caught

- **`markReceivedForDocument` was being handed the GRV's document id.**
  `qty_received` is bumped on the **order** lines (`purchasePosting.ts:951` and
  `:1057`), which is what a request points at — so the GRV id matched nothing
  and would have notified nobody. A feature that silently does nothing looks
  exactly like a feature nobody uses.
- **The suite leaked a notification.** The sweep matched `%stamp%`, which caught
  "Part arrived" but not "Part needed" — the two are written at different
  moments and the requested one carries the *description*, not the job title.
  Now swept by event, and asserted in (J17).

### Verified

Typecheck and `check-ui-kit` clean; `test:job-cards` (14 new J32 assertions),
`test:purchasing`, `test:purchase-orders`, `test:invoicing` and
`test:navigation` all pass. Smoke crawl reports only the pre-existing
`/sales/[id]/bill` sampling failure, and the new route crawled clean. Migrations
applied to sites 1 and 2, both confirmed.

`test:navigation` caught a real thing: the nav keywords repeated "stock" (via
"out of stock"), which the suite refuses. Worth having — a synonym that appears
twice is a search result that ranks wrong.

Driven end to end in Chrome: asked for a part on the job, and it appeared on the
buyer's queue with quantity, the technician's reason, the job link and
Approve/Decline. Site 1 verified back to its prior state by query.

**Named, not built:** partial receipts, substitutions and backorders. A request
moves to `received` when its purchase line has received anything at all.
Splitting one request across two deliveries is a real thing that happens; saying
so beats silently marking a half-delivered request complete.

**A naming decision worth keeping:** the nav entry is "Parts asked for", not
"Requests" — `/jobs/requests` is already inbound *work* from outside the
business, and two menu entries a technician reads as the same word is how
somebody ends up on the wrong queue.

---

## What phase 37 shipped

**Per-customer SLA and escalation (§17.5).** `164_customer_sla.sql` adds a
nullable `customer_id` to `job_sla_policies`, swaps the unique key from
`(priority)` to `(customer_id, priority)`, adds `escalate_after_minutes` /
`escalate_to_user_id`, and creates `job_sla_escalations` as a claim table.

Selection is one query: this customer's policy for this priority, else the
business default. `deadlinesFor` takes an optional trailing `customerId`, so
every existing call keeps meaning exactly what it meant.

### The trap this phase is mostly about

113's own seed comment says, of its `INSERT IGNORE`:

> "The gl_mappings trap does not apply here: priority is NOT NULL, so the unique
> key actually dedupes."

**Adding `customer_id` made it apply.** In MySQL two rows of `(NULL, 'urgent')`
do not collide, because NULL is not equal to NULL — so
`uq_sla_customer_priority` cannot stop a second business default, and
`INSERT IGNORE` against it does nothing at all. That is the 083 `gl_mappings`
case exactly.

So `createPolicy` checks with an explicit read spelled `IS NULL` (never
`= NULL`, which matches nothing and lets every duplicate through), and the
migration seeds with `NOT EXISTS`. The key is still worth having: it dedupes
every per-customer row, which is the case a picker can actually produce twice.

**The old index had to be dropped**, and as a standalone `DROP INDEX IF EXISTS
… ON …` matching 092 — the `ALTER TABLE … DROP INDEX IF EXISTS` spelling is the
one to distrust, on the same evidence as the `ADD FOREIGN KEY` guard. Verified
by `SHOW INDEX` on both sites afterwards, because a silently-skipped drop would
have left the old constraint refusing every per-customer row.

### Escalation

Rides `/api/alerts/tick` as a **second job**, with its own try/catch so a site
whose sweep throws cannot stop the low-stock digest for every site after it —
rather than a third route and a third secret.

`job_sla_escalations` has `UNIQUE (job_card_id, kind)` with **both columns NOT
NULL**, so unlike the policy key this one really does dedupe. The row is
INSERTed before `notify()` is called, so a job breached on Monday escalates once
rather than every five minutes until somebody closes it. `INSERT IGNORE` is
correct *here*, precisely because there is no nullable column in the key — the
same test 113 applied, and the one 164 fails.

**Breach stays derived.** 113 argues a stored flag is wrong the minute after it
is written, and nothing here stores one: this table records that somebody was
*told*, which is a different fact and does not go stale.

Measured from **reported**, not from the breach — so a business wanting warning
*before* the deadline sets a figure below `respond_minutes`. Measuring from the
breach would make that inexpressible.

### Verified

Typecheck and `check-ui-kit` clean; `test:job-cards` (12 new J33 assertions),
`test:navigation` and `test:invoicing` all pass. Migration applied to sites 1
and 2, both confirmed carrying the new columns, the swapped index and the claim
table.

Driven in Chrome: the four defaults read "Everybody", a new per-customer row
appeared showing the customer, a 2h response and "after 1h" escalation, with a
delete button only on that row. A live probe proved the whole cycle — the second
business default refused, the second per-customer policy refused, the customer
measured against theirs and everybody else against the default, the default
undeletable, and escalation firing once (`pass1 1`, `pass2 0`) addressed to a
named user. Site 1 verified back to exactly four business defaults by query.

**Not run: the smoke crawl.** Its login step broke mid-phase —
*"Could not find the login fields — has the form changed?"* — because another
session is editing the sign-in page, `auth.ts` and `session.ts`. The screenshot
driver signed in successfully earlier in this same phase, and nothing here
touches auth. My three routes were checked directly instead and each returns 307
to login, which is the guard working.

**Deliberately out of scope**, per the plan: entitlement and coverage, which
overlap the contracts module and belong in a drawdown there rather than in an
SLA policy.

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
   that writes documents, movements and a ledger entry itself. Then VAT is
   computed in two places and **the divergence is silent** — `reconcileStock()`
   only checks quantities.

   The rule, stated precisely, because a loose version of it invites the wrong
   correction: **nothing in the job module imports `recordMovement`,
   `postTransaction` or `mirrorSale`.** Verified — `grep` finds only the comments
   naming the rule.

   `nextDocumentNumber` is **not** on that list and is used twice, in
   `jobCards.ts` (a `JC` number) and `jobQuotes.ts` (a `QUO` number). That is
   correct: allocating a number is not posting, `quotes.ts` does exactly the same,
   and a module that could not number its own documents would have to ask another
   one to, which is worse. The thing that must never happen is a job WRITING a
   movement, a transaction or a GL mirror.
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
