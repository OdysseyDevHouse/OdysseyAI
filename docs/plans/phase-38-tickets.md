# Phase 38 — the ticket module (§3)

The last item on the job-card programme, and the only one that is a **second
product** rather than a gap in the first. Everything through phase 37 made job
cards more capable; this adds a thing that looks like a job card and is not one.

**Size 1.4** — the largest single phase of the programme.

---

## What a ticket is, and what it is not

> **Ticket** — "Works like a job card but is a separate module. A ticket can be
> linked to a jobcard." (PRD §3)

Your decisions, taken before the programme plan was written:

| Decision | Chosen |
|---|---|
| Scope | **Build it in full** — own table, own statuses, own boards, own SLA |
| Purpose | **Inbound support requests** |
| Navigation | **Its own top-level section** |
| Shares | **Comments, files, activity** — reuse `party_comments`, `party_documents`, `activity_log` |
| Money | **None.** No lines, no costing, no invoicing. A ticket that needs billing becomes a job |

The last row is the one that keeps this affordable. A ticket has no
`ticket_lines`, no billing state, no invoice link — because the moment it has
those it is a job card with a different name, and every costing rule in
`jobCards.ts` would need a second implementation.

---

## What is genuinely reusable — verified, not assumed

I checked each of these against the code rather than the notes, because the
whole size estimate rests on them.

| Need | What exists | Verified |
|---|---|---|
| Comments | `party_comments.entity` is **`varchar(40)`**, not an enum | `SHOW COLUMNS` on site 1 |
| Files | `party_documents.entity` is **`varchar(40)`** | same |
| Activity | `activity_log.entity` is `VARCHAR(40)`, commented "'customer' \| 'supplier' \| 'product' \| …" | [011_activity_log.sql:21](sql/site/011_activity_log.sql#L21) |
| Portal visibility | `is_customer` / `is_visible` on both party tables, both `DEFAULT 0` | 131 |
| Configurable statuses | `job_statuses` — code, tone, sort, role, `is_closed_stage`, `audience`, `blocks_on_incomplete` | [104_job_cards.sql:102](sql/site/104_job_cards.sql#L102) |
| Boards as views over statuses | `job_boards` + `job_board_statuses` (board_id, status_id) | [104_job_cards.sql:184](sql/site/104_job_cards.sql#L184) |
| SLA policies + escalation | `job_sla_policies` with `customer_id`, `escalate_*`; `escalateOverdue()` on the alerts tick | 164, phase 37 |
| Numbering | `document_sequences` — one row per (terminal, doc_type) with prefix and padding | live: `asset=FA contract=CON grv=GRV …` |

**Three migrations are NOT needed**, which the programme plan assumed would be:
widening the entity columns on `party_comments`, `party_documents` and
`activity_log`. All three are already free-text.

### The one type that must change

`PartyKind` is declared `'customer' | 'supplier'`
([partyContacts.ts:23](src/lib/site/partyContacts.ts#L23)) and is the parameter
type on every `partyComments` / `partyDocuments` helper — 24 references.

**It is already lying.** The job card passes `entity="job_card"`
([page.tsx:556](src/app/(app)/jobs/[id]/page.tsx#L556)) and `entity="job"`
([:464](src/app/(app)/jobs/[id]/page.tsx#L464)) through those same helpers today.
So this is not "widen a union for tickets" — it is "make the union tell the
truth", and adding `'ticket'` is one line of a fix that was owed anyway.

Worth doing carefully: those two job values differ (`job` vs `job_card`), which
is either deliberate or an existing bug. **Find out before adding a third.**

---

## Migration 165 — `165_tickets.sql`

Next free number confirmed: 164 is the highest applied.

### `tickets`

```
id, document_number
customer_id (SET NULL)          contact_id (SET NULL)
subject, description
priority   ENUM  — the SAME four as job_cards
status_id  → ticket_statuses    status ENUM('open','closed','cancelled')
owner_user_id, owner_name       — snapshotted name, house convention
source     ENUM('phone','email','portal','walk_in','internal','form')
reported_at, closed_at, close_reason, cancelled_at, cancel_reason
job_card_id (SET NULL)          — the ticket that became a site visit
sla_policy_id, respond_by, resolve_by, responded_at, responded_by_user_id
```

**`status` must be a real column.** `verifySequence` hard-codes
`SUM(CASE WHEN status = 'cancelled' …)` against whatever table `OWN_TABLE_TYPES`
names — [sequences.ts:648](src/lib/site/sequences.ts#L648). A `tickets` table
without it reports **every number ever issued as missing**. This is the sharpest
edge in the phase and it is a schema requirement, not a code one.

**`job_card_id` is `SET NULL`, not CASCADE.** A ticket that produced a job is
evidence that somebody asked; deleting the job must not delete the record of the
request. Same reasoning as `job_requests` (129).

**The two-column status shape is copied deliberately** from `job_cards`:
`status_id` is the configurable stage, `status` is the derived open/closed/
cancelled state. Phase 33's close guard and every report depend on that split
existing, and re-deriving it per read is what 104 argues against.

### The lane owns the clock

**This is the biggest departure from the job module, and it comes from the
system this replaces.**

A job card times work with a *manual* timer: `startJobTimer` / `stopJobTimer`,
tapped by a technician ([jobTime.ts:235](src/lib/site/jobTime.ts#L235)). It works
because a technician on site is already holding the phone.

A support desk does not work that way. The current system drives the clock from
the **lane**: each column carries up to three flags, and dragging a ticket into
it does that thing to the ticket's clock.

```
▶  start   the clock runs while a ticket sits in this lane
⏸  pause   the clock stops, and the ticket stays open
⏹  end     the clock stops for good
```

So "In Progress" holds ▶, "On Hold" holds ⏸, "Resolved" holds ⏹ — and moving the
card *is* the timing action. Nobody has to remember to tap a timer, which is
precisely why the manual one would not survive contact with a support queue.

**Each flag belongs to exactly one lane.** Setting ▶ on a lane takes it off
whichever lane had it. That is the same single-holder constraint
`job_statuses.role` already enforces — "each role is held by at most one status
at a time" ([104_job_cards.sql:114](sql/site/104_job_cards.sql#L114)) — so the
mechanism is copied rather than invented. A lane may hold **none** of the three,
and most will.

Three more rules visible on the current screen, each a different cardinality and
each worth getting right:

| Marker | Cardinality | Meaning |
|---|---|---|
| ★ landing | **exactly one** | where a new ticket arrives |
| ▶ / ⏸ / ⏹ | **at most one lane each** | what dragging here does to the clock |
| ✓ closed | **one or more, at least one** | counts as done; stops the SLA resolution clock |

The closed flag being plural is the one that differs from job cards, where
`is_closed_stage` is per-status but nothing requires at least one. Here the
board is refused if every closed lane is unflagged, because a board with no
"done" column is a queue nothing can leave.

#### What this means for the schema

`ticket_statuses` carries the flags:

```
is_landing     TINYINT(1)  — exactly one per board
clock          ENUM('','start','pause','end')  — at most one lane per value
is_closed_stage TINYINT(1) — one or more
```

`clock` as a **single enum column, not three booleans**, for the same reason
`role` is one: three booleans allow `start` and `end` on the same lane, which is
a shape the screen cannot render and the arithmetic cannot resolve.

And a ledger, because a running total is not enough:

```
CREATE TABLE ticket_time_entries (
  ticket_id, started_at, ended_at NULL,
  started_by_user_id, started_by_name,   -- snapshotted, house convention
  from_status_id, to_status_id           -- which move opened and closed it
)
```

**A ledger, not a `minutes_worked` column.** The same argument 113 makes about
breach and 104 makes about open/closed: a stored total is a figure nobody can
audit and that goes wrong silently. A ledger answers "how long did this take"
*and* "who had it, and when" — which is the question a support manager actually
asks. `jobTime` already works this way, so the reporting shape is familiar.

**One open entry per ticket**, enforced by a unique key on
`(ticket_id, ended_at)` where `ended_at IS NULL` — or by the same
lock-then-insert `startJobTimer` uses, since MySQL will not index a NULL that
way. Two drags a hundred milliseconds apart must not both open a segment.

#### Decided

| Question | Answer |
|---|---|
| Overnight | **Business hours**, the same clock the SLA runs on |
| Whose time | **The assignee's**, not the mover's |
| Billable | **Never** |
| Concurrency | **A per-user cap, set in settings** |

**Business hours** means reusing `addBusinessMinutes` / `businessMinutesBetween`
from `jobStatusModel` and `tradingHours()` from `jobSla` — already written,
already tested, already holiday-aware. A ticket left In Progress over a weekend
reads as the hours the doors were open, and the work clock and the SLA clock on
the same screen agree. That agreement is the whole reason for the answer.

Storage is unaffected: a segment still stores real `started_at` / `ended_at`
timestamps, and business minutes are computed on read. Same argument 113 makes
for storing deadlines and deriving breach — the raw fact is what an argument is
about, and the derived figure must restate itself when the trading week changes.

**The assignee's time**, so `ticket_time_entries` records `assignee_user_id`,
not the mover. Two consequences worth stating now:

- A ticket **with no assignee** cannot accrue time. Dragging an unassigned
  ticket into a ▶ lane either refuses, or moves it and opens no segment. I would
  refuse, with a message naming the reason — silently not timing is the failure
  people discover a month later in a report.
- **Reassigning mid-flight closes the open segment and opens a new one** against
  the new person. Otherwise the whole stretch lands on whoever happens to hold
  the ticket at the end, which is exactly backwards.

#### The concurrency cap

`ticket_max_running_per_user`, an integer setting. A user already running that
many tickets is refused a third.

**Why this can be enforced in code, where the job timer could not.**
`jobTime.ts:27` puts a hard database constraint on job timers — `uq_open_entry`,
a generated column holding the user id while an entry is open — and its header
says why relaxing it can never be undone:

> "once two overlapping rows exist, no migration can restore the constraint
> without choosing which of somebody's hours to delete. And the failure it
> prevents is the one that matters most — an hour paid twice, or billed to two
> customers."

**Ticket time is never billed.** So the failure that justified an unrelaxable
index does not exist here, and a *configurable* cap is safe — which is
fortunate, because a generated column cannot express "at most N".

That makes the enforcement a real check rather than a schema guarantee, so:

- The count and the insert go in **one transaction**, with the user's open rows
  locked first. Two drags a hundred milliseconds apart must not both count one
  and both insert. `startJobTimer` already does exactly this lock-then-insert;
  copy it.
- `0` means **no cap**, and the setting's default should be `0`. A cap
  that switched itself on at some arbitrary number the morning after a migration
  would start refusing work nobody asked it to refuse.
- The refusal must **name the tickets already running**, not just the number.
  "You already have 2 running: CT-00014, CT-00021" tells somebody what to stop;
  "limit reached" sends them hunting.
- `reconcileTickets()` reports anybody **over** the cap, because lowering the
  setting from 3 to 2 cannot retroactively stop a running clock — and the
  alternative, closing somebody's segments when a setting changes, destroys a
  record of work that really happened.

### `ticket_statuses`, `ticket_boards`, `ticket_board_statuses`

Copies of the job shapes, **not** shared tables.

The argument for copying: a ticket's stages (Open → Waiting on customer →
Resolved) are not a job's (New → Assigned → In Progress → Work Completed).
Sharing one table would mean every job board showed ticket stages and every
ticket board showed job stages, and the `role` enum — which code looks statuses
up by — would have to carry both vocabularies.

The honest cost: two status editors, two board editors, two sets of seeds. That
is the price of §3 asking for a separate module.

### Sequence seed

```sql
INSERT INTO document_sequences (terminal_id, doc_type, prefix, next_number, padding)
SELECT … 'ticket', 'TK', 1, 6 WHERE NOT EXISTS (…)
```

`NOT EXISTS`, never `INSERT IGNORE` — and check whether `terminal_id` is
nullable first. If it is, this is exactly the 083 trap again (phase 37's
lesson): a nullable column in a unique key cannot dedupe.

### SLA: one flag, not a second policy table

`job_sla_policies` gains `for_tickets TINYINT(1) NOT NULL DEFAULT 0` so a
support promise can differ from a site-visit promise while reusing:

- the business-hours arithmetic in `jobStatusModel`
- per-customer selection from 164
- `escalateOverdue()` and its claim table

`escalateOverdue` currently reads `job_cards` directly. It needs a second sweep
over `tickets`, and `job_sla_escalations` needs to say *which kind of record* it
claimed — its unique key is `(job_card_id, kind)` today, and ticket 5 must not
collide with job 5. **Widen the claim table before writing the sweep.**

---

## The screens, from the system this replaces

You supplied three reference screenshots: the **lane settings**, the **Kanban
board**, and the **ticket detail**. They are the design brief — the layout is
proven in daily use, so this rebuilds it in the OdysseyAI kit rather than
designing something new.

**Everything below is built from `@/components/ui` with tokens only.** The
reference is a different product with a different palette; what is being copied
is the *arrangement and the behaviour*, never the raw colours. `check-ui-kit`
enforces that, and it is also the point: a ticket board that did not look like
the rest of Odyssey would read as a bolted-on second product.

### Board (Kanban)

Columns are lanes, cards are tickets, dragging moves a ticket and drives its
clock. From the reference:

- A **count per lane** in the header (`New 11`, `In Progress 5`).
- Each card shows: number, title, a two-line description clamp, priority,
  type/tag chips, an **age** (`8d`), created date and author, and an assignee
  avatar. That is a lot on one card and it works because everything but the
  title is one line of small muted text.
- **Filters across the top**: assignee, creator, type, priority, module, tag,
  and a sort. These are saved-view shaped, and `job_saved_views` already exists
  as the model.
- A **Kanban / List toggle**, mirroring the job list exactly.

`job_boards` + `job_board_statuses` and the existing job board screen are the
closest thing already built; the drag behaviour, the permission checks and the
audit on a drag all have to match the job board, because the PRD is explicit
that dragging a card triggers the same validation as editing the field.

**One thing the reference does that this must too:** an empty lane still shows
its header and its zero (`Resolved Not Published 0`). A lane that vanished when
empty would make the board's shape change under people.

### Ticket detail

A **two-column layout**, not tabs:

- **Left**: description with an inline edit pencil, a rich-text comment box with
  @-mention, then `Comments (2)` / `Activity (14)` as tabs beneath it, then
  attachments with drag-and-drop at the bottom.
- **Right rail**: technician, priority, category, tags, due date, time tracking,
  watchers, customer.
- **Header**: number, board, customer chip, title, then state chips —
  `Archived`, priority, status — and who logged it, when.

Two things to carry across deliberately:

- **Comments and Activity are tabs on the same panel**, not separate places.
  That is the PRD's requirement that both stay reachable from anywhere, solved
  with less screen than the job card's approach.
- **Watchers are the PRD's followers** (§13) — `job_people` already implements
  exactly this with an `assignee`/`follower` split, so the data shape exists.

The **time tracking** block in the right rail is where the clock surfaces: total
business time, and the segments behind it. On the reference it is a header with
nothing under it; here it should show the ledger, because that is the thing this
whole design is for.

### Lane settings

Per lane: reorder, colour, the three clock flags, the closed flag, the landing
star, delete. The explanatory paragraph above the list is doing real work — it
says what each flag means and that a flag belongs to one lane only — and that
copy should survive into the rebuild rather than being replaced with a tooltip.

---

## Build order

Each step is separately verifiable, and each leaves the tree working.

1. **165** — tables, seeds, `OWN_TABLE_TYPES` entry. Apply to sites 1 and 2,
   `SHOW COLUMNS` both.
2. **`src/lib/site/tickets.ts`** — CRUD, status transitions, the open/closed
   derivation, `reconcileTickets()`. **The clock rides the status change**: one
   function moves a ticket and closes or opens a time segment in the same
   transaction, so a move can never be recorded without its timing consequence.
3. **`PartyKind` widened** to include `'ticket'` (and the `job`/`job_card`
   discrepancy resolved), so comments and files work with no new tables.
4. **Statuses and boards** — data layer plus the setup screens.
5. **`/tickets`** — list, board, detail, following the reference layouts above.
   Its own nav section.
6. **SLA** — `for_tickets`, selection, the second escalation sweep.
7. **Job link** — convert a ticket to a job, navigable both ways.
8. **Reports** — a ticket source in the report builder, gated `tickets.view`.

Steps 1–3 are the risky ones; 4–8 are largely shaped by what already exists.

---

## Risks, most consequential first

1. **`verifySequence` reports every ticket number missing** if `tickets` has no
   `status` column, or if `OWN_TABLE_TYPES` names the table before the column
   exists. Schema requirement — get it right in 165, not in a fix-up.
2. **`job_sla_escalations` collides across record types.** `(job_card_id, kind)`
   with a ticket id in the same column silently suppresses a real escalation —
   the worst failure mode, because it fails *quietly* and *elsewhere*. Widen the
   key to include a record type.
3. **`PartyKind` has 24 references** and already carries two undeclared values.
   Widening it will surface existing casts; expect the compiler to name places
   that were quietly wrong.
4. **A drag that times out mid-move leaves a segment open or a move unrecorded.**
   The status change and the clock segment must be **one transaction** — a
   ticket in "On Hold" with a running clock, or in "In Progress" with none, is
   drift nothing on screen explains. `reconcileTickets()` gets a bucket for
   exactly that: a ticket whose open segment disagrees with its lane's flag.
5. **Two drags in quick succession opening two segments.** Same race
   `startJobTimer` guards with a lock-then-insert; copy that, do not invent.
6. **The cap is a check, not a constraint.** Unlike `uq_open_entry` on job time,
   nothing in the schema can express "at most N", so two simultaneous drags
   could both pass the count. The count and the insert must share one
   transaction with the user's open rows locked — the same lock-then-insert
   `startJobTimer` uses. This is safe only because ticket time is never billed;
   if that ever changes, this decision has to be revisited first.
7. **An unassigned ticket cannot accrue time**, because time belongs to the
   assignee. Dragging one into a ▶ lane must refuse and say why. Moving it and
   silently timing nothing is the failure somebody finds a month later in a
   report they cannot reconcile.
8. **Every future feature must now ask "does this apply to tickets too."**
   Statuses, boards, reports, portal, notifications, custom fields. This is the
   recorded price of §3, not a defect — but it is why this phase is last.
9. **Permissions are a new group.** `tickets.view` / `edit` / `close` / `setup`
   in `CAPABILITY_GROUPS`, and every page, action and API route guarded — pages,
   actions and `api/` routes each take a different helper.
10. **The smoke crawl and screenshot driver are currently blocked** by another
   session's login change. Browser verification has caught a real bug in most
   phases of this programme; if that is still broken when this starts, say so
   rather than skipping it silently.

---

## What is deliberately NOT in scope

- **Costing, lines, invoicing.** A ticket needing money becomes a job.
- **A second portal.** Tickets appear in the existing customer portal or not at
  all; a parallel portal is a second place for an internal note to leak.
- **Merging tickets**, ticket-to-ticket links, canned replies, email ingestion.
  Each is a real support-desk feature and none is in §3.

---

## Verification, per the standard the programme has held

1. A live probe asserting the **refusals**, not the happy path.
2. Driven in Chrome over CDP on :4100 — assuming the login form is fixed.
3. `npx tsc --noEmit`, `node scripts/check-ui-kit.mjs`, `npx next build`.
4. Migrations applied to sites 1 **and** 2, confirmed by `SHOW COLUMNS`.
5. `npm run test:tickets` (new) plus `test:job-cards`, `test:sequences`,
   `test:navigation`. **`test:sequences` is not optional here** — it is what
   proves risk 1 did not happen.
6. Smoke crawl, and `reconcileTickets()` clean.
7. Site 1 restored to its prior state, verified by query rather than assumed.

**Two pre-existing failures are not from this work:** `test:serials` fails on
leaked `INS*` fixtures, and the smoke crawl's `/sales/[id]/bill` 404s because it
samples a finalised invoice.
