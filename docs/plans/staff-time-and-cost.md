# Staff: time, leave, and what a person costs

A plan, not an implementation. Scope agreed: **the inputs to payroll, not payroll
itself** — hours, leave, shifts and cost per head, ending in a figure someone
keys into Sage / SimplePay / PaySpace. No PAYE, UIF, SDL, tax tables or
payslips: those change with every budget speech, carry real compliance risk,
and are a product in their own right.

---

## What already exists, and what it means for this

The single most important finding: **`shifts` is not a clock-in and must not be
reused as one.**

`sql/site/016_shifts.sql` describes a *cash-drawer session*. Its unique key is
`uq_shift_open (open_terminal_id)` — one open shift per TILL, not per person.
That has three consequences that rule it out as a time record:

- A bookkeeper, a stock-room packer, a driver — anyone without a terminal — can
  never have a shift row at all.
- Shifts are optional. `salesPosting.ts:185` deliberately allows a sale with
  `shift_id = NULL`, because "a store that does not cash up still needs to
  trade". Hours would silently vanish for those stores.
- `closed_by_user_id` is a separate column precisely because a supervisor
  routinely closes someone else's drawer. `closed_at` is therefore not that
  person's clock-out.

So: new tables, named distinctly (`staff_*`), with an optional convenience that
offers a cash-up shift as a *prefill* when clocking out.

What we DO reuse, unchanged:

| Thing | Where | Why it fits |
|---|---|---|
| `users` as the person | 041 | Already the identity: role, PIN, `is_active`. 047 demoted `sales_reps` to an account label. |
| PIN sign-in | `signInWithPin`, `users.ts` | POS-only staff have no login; the PIN is already their credential. |
| Commission per person per period | `commission_entries`, indexed `(user_id, document_date)` | A ready-made cost component. |
| `salesByCashier(range)` | `salesReports.ts:213` | Per-employee revenue and gross profit for any date range. Extend, don't duplicate. |
| The lock pattern | `commission_runs`, 042 | Open = recalculable, locked = frozen. Copied wholesale for pay periods. |
| `PinPad` | `components/ui/PinPad.tsx` | Already built, already on the style guide, `submitLabel` is a prop. |

Not used, but worth knowing they are there for later: GL accounts `6030` /
`2300` (045, both postable) and the `gl_mappings` KV that takes new keys without
a migration. See the GL section below.

---

## The GL: deliberately not yet

**Decision: this feature does not post to the general ledger. It reports.**

That was reconsidered and reversed, and the reasoning is worth keeping because
it will come up again.

A payroll journal buys exactly one thing: wages land in the month they were
WORKED rather than the month they were PAID. Staff work through March, get paid
5 April — without a journal, March's income statement shows no wages and March
looks more profitable than it was. That is the correct accrual treatment and it
matters to anyone running monthly management accounts.

Against that, it introduces a **double-count hazard that does not exist today**.
Salaries already reach the GL exactly once: somebody captures an expense against
category `5030 Salaries and wages` and `mirrorExpense` posts `DR 6030 / CR bank`.
Post a payroll journal on top and the same cost is in the ledger twice, with
wages overstated by 100%.

The fix is not hard technically — the run posts `DR 6030 / CR 2300 Salaries
payable`, and the actual payment is then captured against **2300** rather than
6030. But that is a **workflow change for every store**: they must stop doing
something they do correctly today, and the first month somebody forgets, the
numbers are wrong in a way nobody notices until the accountant asks.

So the cost is not the code. It is changing a working habit, before anyone has
asked, for a benefit nobody has yet felt the absence of.

**The whole value of this feature is the cost-per-employee report**, and that
works without touching the ledger at all. Salaries keep reaching the GL exactly
as they do now.

### When to revisit

Add `mirrorPayroll` when somebody is running proper monthly management accounts
and notices the month-to-month comparison is off. They will ask; it will be
obvious.

Nothing here forecloses it. The accounts are already seeded and postable
(`6030 Salaries and wages`, `2300 Salaries payable`, 045 L314/L340, both
`is_postable` with no `control_type`), and `gl_mappings` takes new keys by
INSERT with no migration. When it is wanted:

1. `mirrorPayroll` in `glPosting.ts`, following `mirrorExpense` — wrapped in
   `attempt()`, throwing inside the builder on a missing mapping so it degrades
   to `{ ok: false, reason }` and never fails its caller.
2. `gl_mappings` keys `payroll_expense` → 6030 and `payroll_liability` → 2300.
3. A `'payroll'` value on the `period_locks.scope` ENUM — a `MODIFY COLUMN`
   migration plus the `LockScope` union and `SCOPE_LABELS` in
   `src/lib/periodLockModel.ts`.
4. **The guardrail that makes it safe:** a warning on the expense form when
   category `5030` is chosen and a payroll run exists for that month, and a
   reconciliation check flagging `6030` movement that did not originate from a
   payroll run.

That is a day's work, not a rewrite. Waiting costs nothing.

---

## Schema

Five new tables, one ALTER, one ENUM widening.

### 1. `user_employment` — 1:1 with `users`

A separate table rather than columns on `users`, for two reasons: `users` is
read on **every request** by `requireSiteUser()`, and employment data is read on
a handful of screens; and pay rate is far more sensitive than name and role, so
a separate table makes "who may read this" a join rather than a column filter.

```
user_id            PK, FK users(id) ON DELETE CASCADE
employee_number    VARCHAR(32) NULL, UNIQUE
employment_type    ENUM('permanent','fixed_term','casual','contractor')
pay_basis          ENUM('hourly','salaried')
hourly_rate        DECIMAL(10,4)   -- gross, before any statutory anything
monthly_salary     DECIMAL(12,4)
ordinary_hours_pw  DECIMAL(5,2) DEFAULT 45.00   -- BCEA s9 maximum
hired_on           DATE NULL
terminated_on      DATE NULL
leave_cycle_start  DATE NULL   -- anniversary the annual cycle runs from
notes              VARCHAR(400)
```

`ordinary_hours_pw` defaults to 45: BCEA s9 caps ordinary hours at 45/week, and
overtime is calculated on the excess. Storing it per person allows part-timers.

### 2. `staff_time_entries` — one clock-in to clock-out

```
id                 PK
user_id            FK users(id)     -- no ON DELETE: a time record outlives employment
user_name          VARCHAR(120)     -- snapshot, per the house convention
started_at         DATETIME NOT NULL
ended_at           DATETIME NULL    -- NULL = still clocked in
source             ENUM('pin','manual','import') DEFAULT 'pin'
terminal_id        INT UNSIGNED NULL   -- where they clocked, if a till
shift_id           INT UNSIGNED NULL   -- the cash-up shift, when one lines up
break_minutes      INT DEFAULT 0
note               VARCHAR(400) NULL
edited_by_user_id  INT UNSIGNED NULL   -- set when a manager amended it
edited_reason      VARCHAR(400) NULL
approved_at        DATETIME NULL
approved_by_user_id INT UNSIGNED NULL
open_user_id       INT UNSIGNED GENERATED ALWAYS AS
                     (CASE WHEN ended_at IS NULL THEN user_id ELSE NULL END) STORED,
UNIQUE KEY uq_open_entry (open_user_id)
```

The generated column borrows the trick 016 already uses: MySQL permits any
number of NULLs in a unique index, so a plain `UNIQUE (user_id, ended_at)` would
allow a hundred simultaneous open entries. Nulling the column on close means the
index constrains exactly the open ones — **one person cannot be clocked in
twice.**

`edited_by_user_id` + `edited_reason` are not decoration. A time record that a
manager can change without trace is a time record staff will not trust, and the
BCEA requires an employer to keep accurate records (s31).

### 3. `leave_types` — seeded with the BCEA minimums

```
id, name, code, is_paid BOOL, accrual_method ENUM('none','monthly','annual_grant','cycle_36m'),
accrual_days DECIMAL(6,3), cycle_months INT, max_balance_days DECIMAL(6,2) NULL,
is_system BOOL, is_active BOOL, sort_order
```

Seeded (editable upward, never silently below the statutory floor):

| Leave | Accrual | Statute |
|---|---|---|
| Annual | 1.25 days/month | BCEA s20 — 21 consecutive days per 12-month cycle |
| Sick | 30 days per 36-month cycle | BCEA s22 |
| Family responsibility | 3 days/year | BCEA s27 |
| Maternity | 4 consecutive months, unpaid here | BCEA s25 — UIF pays, not the employer |
| Unpaid | none | — |

Maternity is deliberately `is_paid = false`: the employer is not obliged to pay
it, UIF is. Marking it paid would silently commit a store to a cost the law does
not impose.

### 4. `leave_requests`

```
id, user_id, user_name (snapshot), leave_type_id,
from_date DATE, to_date DATE, days DECIMAL(6,2),
status ENUM('requested','approved','declined','cancelled') DEFAULT 'requested',
reason VARCHAR(400), decided_by_user_id, decided_at, decided_note,
created_at, updated_at
```

`days` is stored rather than derived: it is computed from the working days in
the range at the moment of request, and a later change to the store's working
week must not silently restate leave already taken.

### 5. `leave_ledger` — the balance, as movements not a number

```
id, user_id, leave_type_id,
entry_date DATE, days DECIMAL(6,2),          -- positive accrues, negative takes
source ENUM('accrual','taken','adjustment','opening','forfeit','payout'),
source_id INT UNSIGNED NULL,                 -- leave_requests.id where relevant
note VARCHAR(400), created_at
```

A balance column would be a number nobody can explain. A ledger answers "why do
I have 11.5 days" with a list, which is the only version that survives an
argument with an employee.

### ALTERs

**None.** Five new tables and nothing touched.

The `period_locks.scope` ENUM and the `gl_mappings` keys were only needed for
the payroll journal, which is deferred — see above. That leaves this whole
feature additive: no existing table altered, no existing behaviour changed, and
nothing to unpick if it is paused halfway.

Locking a pay period is handled by `staff_pay_periods` (below) rather than by
the accounting period lock, which is the right separation anyway: closing March
for VAT and closing March for wages are different decisions made by different
people at different times.

### 6. `staff_pay_periods` — so a figure that was paid stays paid

```
id, period_start DATE, period_end DATE,
status ENUM('open','locked') DEFAULT 'open',
calculated_at DATETIME NULL, locked_at DATETIME NULL,
locked_by_user_id INT UNSIGNED NULL, locked_by_name VARCHAR(120) NULL,
total_cost DECIMAL(12,4) DEFAULT 0, note VARCHAR(400) NULL,
UNIQUE KEY uq_pay_period (period_start, period_end)
```

Exactly the shape `commission_runs` already uses, for exactly the same reason:
**open means recalculable, locked means frozen.** Once somebody has been paid on
a figure, an amended time entry must not silently restate it. A time entry dated
inside a locked period is refused; the correction lands in the open one.

---

## Capabilities

A new `staff` group, following `commission` — the existing precedent for
"may see their own, may see everyone's":

```
staff.view_own      See their own hours and leave
staff.view_all      See everyone's
staff.clock         Clock in and out           (Cashier gets this)
staff.edit          Amend a time entry, add or correct leave
staff.approve       Approve leave and timesheets
staff.cost          See pay rates and what people cost   ← mirrors products.cost
staff.run           Run and lock a pay period
```

`staff.cost` split from `staff.view_all` deliberately: a supervisor checking who
worked Saturday should not thereby learn what everyone earns. Deny-by-default
and owner-implicit both come free from `permissions.ts`.

---

## Phases

Each ends somewhere shippable. Estimates assume the pattern is already known.

### Phase 1 — Employment data and capabilities
`user_employment`, the `staff` capability group, employment fields on the
existing Setup → Users form behind `staff.cost`.
*Nothing user-visible changes for anyone without the capability.*

### Phase 2 — Clock in / out
`staff_time_entries`, a PIN-driven Clock in / Clock out screen reusing `PinPad`
and `signInWithPin`, and a "who is on the clock" list. The till gate gains a
Clock in button beside Use till.
**Ships alone and is useful alone** — a store gets attendance without any of
what follows.

### Phase 3 — Timesheets
Weekly and monthly views, manager correction with `edited_reason` recorded,
approval. Overtime derived from `ordinary_hours_pw` — BCEA s10 is 1.5×, and 2×
on a Sunday (s16), which the calculation should surface rather than silently
apply, since many stores have agreements that differ.

### Phase 4 — Leave
`leave_types` seeded, `leave_requests`, `leave_ledger`, a monthly accrual job,
request and approval screens, per-person balance. Approved leave writes both a
`leave_ledger` movement and (for paid types) the hours that feed cost.

### Phase 5 — Cost per employee
The point of the whole feature. `staff_pay_periods`, and the report joining,
for a date range:

```
hours worked × rate      (staff_time_entries × user_employment)
+ paid leave             (leave_ledger, source = 'taken', is_paid types)
+ commission             (commission_entries by document_date)
= cost per head
vs revenue and GP        (salesByCashier — extend, do not duplicate)
= contribution per head
```

Ends in a figure per person that somebody exports or keys into payroll, and a
period they can lock so it stops moving afterwards. **No GL posting** — see the
section above for why, and for what to do when it is eventually wanted.

**Done.** `059_staff_pay_periods.sql` (both sites), `src/lib/site/staffCost.ts`,
`/staff/cost`, `test:staff-cost` — 40 checks.

Two things worth knowing that only came out in the building:

*Overtime is costed at the rate frozen on the line, not the rate on the
employment record.* A raise between working the hours and paying them would
otherwise restate a locked period, which is the one thing locking exists to
prevent. The test that proves it raises R100 → R250 and asserts the locked
figure does not move while the live report does.

*Somebody with no employment row is flagged, never costed at zero.* A missing
rate is a data problem to fix, and a R0.00 line reads as free labour — so the
line shows a "No rate" badge and the page carries a warning naming who is
affected. `calculatePayPeriod` skips them rather than freezing a zero.

---

## Things I would decide now rather than discover later

**Which `user_id` means "revenue generated".** `salesByCashier` groups on
`sales_documents.user_id` (who rang it up). Commission uses
`sales_document_lines.sales_rep_user_id` (who sold it). 047 exists precisely
because these differ. The cost report should show both and label them, not pick
one silently.

**`user_id = 0` is not a person.** The online-store pseudo-actor has no `users`
row. Every per-employee query must exclude it or it appears as an employee who
never clocked in.

**Commission by run vs by date.** A clawback for a locked period lands in the
current open run. Summing `commission_entries` by `document_date` and by
`run_id` therefore give different answers. The cost report should use
`document_date` (it is indexed for this) and say so on the screen.

**Rounding.** Hours are `DECIMAL(6,2)`; money stays `DECIMAL(12,4)` per the
house convention, rounded once at the end through `round()`.

**Terminated staff.** Every report defaults to people employed during the range,
not people active today — otherwise last month's figures change the day somebody
leaves.

---

## What this deliberately does not do

- PAYE, UIF, SDL, tax tables, payslips, EMP201.
- **Post to the general ledger.** Deferred on purpose — see the GL section.
  Salaries keep reaching the ledger exactly as they do today.
- Rostering or shift scheduling (who is *meant* to work). This records what
  happened, not what was planned. It is the obvious next thing.
- Biometric or hardware clock integration.
- Anything that deducts from pay. BCEA s34 forbids deductions without written
  consent and caps loss-recovery at 25% of remuneration — the same constraint
  already noted on the commission clawback screen.

---

## Where it stops being additive

Phases 1–4 touch nothing that exists: new tables, a new capability group, new
screens. If the work is paused after any of them, nothing has to be unpicked.

Phase 5 is the first phase that reads across into commission and sales
reporting, and it still only reads. The moment that changes is `mirrorPayroll`,
which is exactly why it sits outside the plan rather than at the end of it.
