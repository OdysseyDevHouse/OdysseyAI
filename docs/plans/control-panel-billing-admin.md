# Control Panel: Plan & Billing administration

A brief for the developer building the **control panel** (the v2 backend that owns
`odyssey_tickets`). The tables described here already exist and are already read
in production by the OdysseyAI app. What is missing is any way for a human to
**set them up, edit them, or correct them**.

Nothing in this document proposes a schema change. The point of the work is to
put a UI on tables that currently only migrations and the tenant-facing billing
screen can write.

---

## 1. Why this is needed

Today, the only writes to the billing tables come from two places:

| Writer | What it can do |
|---|---|
| Migration `008_module_entitlements.sql` | Created every account once, at deploy, and gave each site a Starter Pack row. Ran once and will never run again. |
| The tenant's own billing screen (`/setup/billing`) | A shop owner adds or removes their *own* modules, at book price. |

That leaves no way to do any of the following, all of which are ordinary
day-to-day operator work:

- **Set a price.** Every row in `cp2_module_prices` was seeded at `0.00` on
  purpose, with a note saying "Set the real price." That was a deliberate
  decision — a guessed price shipped in a migration gets invoiced — but the
  follow-up UPDATE has no home. Today it is a hand-written SQL statement.
- **Onboard a new site.** Migration 008 backfilled existing sites. A site
  created afterwards has no billing account, no account link and no Starter
  Pack row, so it appears to hold nothing.
- **Grandfather a customer.** `cp2_site_modules.agreed_price` is the mechanism
  for "this shop keeps R99 when the book moves to R149". Nothing can set it.
- **Fix a mistake.** A module added to the wrong site, a removal scheduled for
  the wrong date, a site billed to the wrong account.
- **Move a site between accounts**, which the schema explicitly allows and no
  screen offers.
- **Answer a billing dispute.** `cp2_module_change_log` exists precisely to be
  read during one, and nothing reads it.
- **Suspend or close an account.** `cp2_billing_accounts.status` has a
  `suspended` value the entitlement layer already honours, and no writer.

---

## 2. The data model as it stands

All tables live in **`odyssey_tickets`** — the shared control database — and are
`cp2_`-prefixed. Defined in
[`sql/tickets/008_module_entitlements.sql`](../../sql/tickets/008_module_entitlements.sql)
and [`sql/tickets/010_payfast_subscriptions.sql`](../../sql/tickets/010_payfast_subscriptions.sql).

```
cp2_billing_accounts ──┬── cp2_billing_account_sites ── (site_id → cp2_sites)
                       │        UNIQUE(site_id)
                       ├── cp2_billing_subscriptions   (1:1, the PayFast mandate)
                       ├── cp2_billing_payments        (every collection)
                       └── cp2_module_change_log       (decisions, by actor)

cp2_site_modules       (site_id, module_key) — what a site HOLDS
cp2_module_prices      (module_key, effective_from) — the price book
```

### `cp2_billing_accounts` — who pays
`name`, `billing_email`, `billing_contact`, `vat_number`, `billing_day`
(1–28, capped by the app), `status` (`trial` / `active` / `suspended` /
`closed`), `currency`. The `gateway` / `gateway_ref` columns are dead —
migration 010 says explicitly they stay NULL forever and must not be dropped.

### `cp2_billing_account_sites` — which sites it pays for
`UNIQUE KEY uq_bas_site (site_id)`. **A site bills to exactly one account.**
That constraint is what makes "what is this month's bill" answerable, so moving
a site is a delete-then-insert, not an insert.

### `cp2_module_prices` — the price book
`module_key`, `unit_price` DECIMAL(10,2), `effective_from` DATE,
`effective_to` DATE NULL (inclusive upper bound), `note`.
`UNIQUE (module_key, effective_from)`.

### `cp2_site_modules` — what a site holds
`site_id`, `module_key`, `quantity`, `starts_on`, `ends_on`, `agreed_price`,
`created_by`. **Live today** is:

```sql
starts_on <= :today AND (ends_on IS NULL OR ends_on >= :today)
```

Inclusive at both ends. This predicate is the entire access-control mechanism —
see §4.

### `cp2_module_change_log` — what was decided, and by whom
`account_id`, `site_id`, `module_key`, `action`
(`added` / `scheduled_removal` / `removal_cancelled` / `quantity_changed` /
`removed`), `effective_on`, `quantity`, `unit_price`, `actor_name`,
`actor_email`. State and history are separate on purpose: once a module has
been added, removed and re-added, the state rows no longer say who chose what.

### The module keys
These strings are **persisted, therefore permanent**. The authority for the
application is `MODULE_KEYS` in
[`src/lib/control/modules.ts`](../../src/lib/control/modules.ts):

```
starter              the base package — always on, never sold separately
inventory_advanced   counting, correcting, moving and tracing stock
multi_branch         one product file and consolidated reporting across stores
customers            accounts, statements, credit
online_store         the public shop front
loyalty              points, tiers and cards
job_cards            jobs from request to invoice
accounting           the general ledger and the financial statements
pos_device           a QUANTITY, not a feature — see cp2_devices
```

The control panel must treat this list as **closed**. Adding a key is a code
change in the app repo (both `MODULE_KEYS` and `MODULE_CARDS` in
`src/lib/billing/catalogue.ts`), not something an admin types into a form. A
free-text module field would let an operator create `loyality` and silently
grant nothing.

---

## 3. Rules the control panel must not break

These are the constraints the app already relies on. Each one has a failure
mode that is invisible until it costs somebody money.

**1. A downgrade stamps `ends_on`; it never deletes the row.**
`ends_on` is set to the last day of the period the customer has already paid
for. The row keeps matching the live predicate until that date passes and then
stops. There is deliberately **no cron job** — a scheduled job is a thing that
can fail silently, and its failure here means a customer still holding, and
still being charged for, a module they cancelled weeks ago. A control panel
that implements "remove" as a `DELETE` takes away access the customer has paid
for, today.

**2. Re-adding before the end date is `ends_on = NULL` on the same row.**
Not a second row. The customer never lost access, so there is nothing to
restart — and a grandfathered `agreed_price` survives untouched. Opening a
second row loses the pinned rate.

**3. `agreed_price` is a snapshot, not a foreign key.**
NULL means "charge today's book price", which is what a new sale should do.
A value **pins** the rate and must survive the book price row being deleted.
Never resolve it to a price-book id.

**4. Never write two overlapping live rows.**
MySQL has no exclusion constraint, so `UNIQUE (site_id, module_key, starts_on)`
cannot catch this — two open-ended rows with different start dates are
expressible. Close the previous row before opening a new one, inside a
transaction, with `SELECT ... FOR UPDATE` on the existing row. The app's
`addModule()` shows the shape.

**5. `billing_day` is capped at 28 by the app, not by the schema.**
A billing day of the 31st skips February, and a downgrade scheduled for a date
that never arrives is a module the customer keeps being charged for. The
control panel must apply the same cap — see `safeBillingDay()` in
[`src/lib/billing/period.ts`](../../src/lib/billing/period.ts).

**6. The Starter Pack cannot be removed and cannot be added twice.**
`BASE_MODULE = 'starter'`. Both write paths in the app reject it explicitly.

**7. Prices are DECIMAL and must stay strings until converted once.**
The pool sets `decimalNumbers: false`. Reading a DECIMAL into a float and back
accumulates rounding error across a ten-store total.

**8. Every write goes in `cp2_module_change_log`, in the same transaction.**
Including admin writes — arguably *especially* admin writes. The log's whole
job is answering "who turned Loyalty off, and when?" during a dispute, and an
operator acting on a customer's behalf is exactly the case where the state rows
will not say.

**9. Two prices for one module on the same day is unanswerable.**
`UNIQUE (module_key, effective_from)` enforces it. When resolving today's
price, the app takes the **latest `effective_from`** among matching rows and
ignores the rest — it does not trust the optimiser's ordering. Match that.

---

## 4. What breaks downstream if this is got wrong

The billing tables are not a reporting sidecar. **`cp2_site_modules` is the
access-control layer for the entire back office.** Every module-gated screen in
the app asks `entitlementsForSite(siteId)`, which reads that table.

Two behaviours the control panel developer should know about:

- **Entitlement reads fail OPEN.** If the control database cannot be read,
  every module is treated as held and a `degraded` flag is set. That is
  deliberate: a blip that hid Customers, Job Cards and the Online Store would
  not look like a licence problem to the person it happened to — it would look
  like the application had eaten half of itself. Note the consequence for
  testing: *removing a module and seeing the feature still work may mean the
  control DB was unreachable, not that the write failed.*

- **Desktop installs cache a lease.** A desktop build writes what it was told
  into a local lease (migration `178_licence_lease.sql`) and reads it when the
  control database is unreachable. So a module removed in the control panel may
  keep working on a desktop till until its lease expires. This is by design; do
  not "fix" it by shortening the lease.

Also worth knowing: **modules are not permissions.** A `loyalty` row says the
business pays for Loyalty, not that every cashier may read member balances.
The app asks both questions, in that order, via `requireModuleCapability()`.
The control panel administers only the first. It must never write to a site
database's roles or permissions tables as a side effect of a module change.

---

## 5. The screens to build

### 5.1 Accounts list
Every `cp2_billing_accounts` row: name, status, site count, monthly total,
subscription status, next billing date. Filter by status; search by name,
billing email and VAT number. Flag the two conditions that are always wrong:

- an account with **no sites** (orphaned by a site move)
- a site with **no account** (created after the 008 backfill) — this is a
  `LEFT JOIN cp2_sites` finding nothing in `cp2_billing_account_sites`, and it
  is the single most valuable row on the screen because that site's owner is
  currently getting a free ride or a broken menu.

### 5.2 Account detail
The main working screen.

- **Header** — name, status, billing day, next billing date, monthly total
  (excl. and incl. VAT), and the multi-store discount rate actually applied.
- **Details form** — name, billing email, billing contact, VAT number,
  billing day (1–28), status, currency.
- **Sites** — the sites this account pays for, each with its live modules and
  its line total. Actions: **add a site** (must not already be on another
  account — surface the conflict, and offer "move it here" as an explicit
  choice), and **remove a site** (which orphans it; warn, do not silently
  leave it unbilled).
- **Subscription** — read the `cp2_billing_subscriptions` row: status,
  `amount_incl`, `synced_at`, `next_billing_on`, `escalation_percent`,
  `anniversary_on`, `last_escalated_on`. Editing `escalation_percent` and
  `anniversary_on` is in scope. **Pushing changes to PayFast is not** — the app
  owns that path, including the local-first ordering that stops a double
  increase. Show `synced_at` as a plain "PayFast may still be collecting the
  old figure" warning when it lags `updated_at`.
- **Payments** — `cp2_billing_payments`, newest first, read-only.
- **Change log** — `cp2_module_change_log` for every site on the account,
  newest first, read-only. This is the dispute screen.

### 5.3 Site modules editor
Per site. One row per module in `MODULE_KEYS`, showing: held / not held,
`starts_on`, `ends_on` (with "ends 31 August 2026" rendered, not the raw date),
`agreed_price` vs today's book price, and `quantity` for `pos_device`.

Actions, each writing a change-log row:

| Action | Effect |
|---|---|
| **Add** | New row, `starts_on = today`, `agreed_price = NULL`. Immediate. If a row exists that is merely scheduled to end, clear `ends_on` instead. |
| **Schedule removal** | `ends_on = periodEnd(today, billing_day)`. Never a DELETE. |
| **Cancel removal** | `ends_on = NULL` on the same row. |
| **Set agreed price** | Grandfather this site at a rate. NULL to return it to the book. |
| **Change quantity** | `pos_device` only. |

Two admin-only powers the tenant screen deliberately does not have, and which
are most of the reason this project exists:

- **Backdate `starts_on`** — for a customer who has been using something since
  before it was recorded.
- **Set an explicit `ends_on`** — including one in the past, to correct a
  removal that should already have landed.

Both must warn clearly, both must be logged, and both are the reason §3's
"never write two overlapping live rows" rule needs a real check rather than a
comment: a backdated start is exactly what creates an overlap.

### 5.4 Price book
`cp2_module_prices`, grouped by `module_key`, showing each module's price
history and which row is live today.

- **Change a price** = insert a new row with a future `effective_from` and
  close the current one with `effective_to = effective_from - 1 day`. Do not
  UPDATE a live row — the history is the point, and an in-place edit
  retroactively changes what a customer was told they agreed to.
- Warn loudly on any module still sitting at `0.00`. On first login after this
  ships, that will be **all nine of them**.
- Show, per module, how many sites currently hold it and how many of those are
  grandfathered — that is the blast radius of a price change, and it is the
  number the person setting the price actually wants.

### 5.5 New-site onboarding
The gap migration 008 left behind. For a site with no billing account:
create or pick an account, link the site, insert the Starter Pack row
(`starts_on = today`), and optionally tick further modules. One screen, one
transaction.

---

## 6. Reusing the app's logic

Do not reimplement the arithmetic. Three files in the app repo are pure — no
server imports, no database — and exist specifically so that both sides compute
the same number:

- [`src/lib/billing/period.ts`](../../src/lib/billing/period.ts) —
  `periodEnd()`, `nextBillingDate()`, `safeBillingDay()`. If the control panel
  computes an end-of-period date differently from the app, a customer loses a
  day they paid for and nobody finds out for months.
- [`src/lib/billing/pricing.ts`](../../src/lib/billing/pricing.ts) —
  `quoteFor()`, `storeLines()`, `changePreview()`. Handles the resolution order
  (agreed rate → book → zero), the per-line rounding, the multi-store discount
  and the free-first-device rule.
- [`src/lib/billing/catalogue.ts`](../../src/lib/billing/catalogue.ts) —
  the module names, descriptions and feature bullets, plus
  `multiStoreDiscountRate()` and `FREE_DEVICES_PER_STORE`.

If the control panel is a separate codebase, port these **verbatim** and add a
test that pins the outputs against the app's, rather than paraphrasing them.
The rounding in particular is per-line-then-sum, not sum-then-round; the two
diverge by a cent on some inputs and finding out why costs an afternoon.

Two rules from `pricing.ts` worth restating because they are security
properties, not conveniences:

- **The client posts a selection, never a price.** Anything that lets the
  browser name its own amount is a discount coupon anyone can mint.
- **An unknown module prices at R0 rather than throwing.** A missing price row
  must not take the screen down, and an R0 line is visibly wrong to the person
  looking at it in a way an exception on a blank page is not.

---

## 7. Access and audit

- The whole area is **operator-only**. It sets what tenants are charged and
  what they can open; a tenant must never reach it.
- Every write records the acting operator in `actor_name` / `actor_email` on
  the change-log row. These are snapshotted strings with no foreign key behind
  them, deliberately — the row has to still make sense to a support person
  after the operator who made the change has left.
- Setting an `agreed_price`, backdating a `starts_on`, and changing an account
  `status` are the three actions most likely to be questioned later. Consider
  requiring a short free-text reason on each, stored in the change log.

---

## 8. Suggested order of work

1. **Read-only first** — accounts list, account detail, change log, payments.
   This is immediately useful for support and it cannot break anything.
2. **Price book.** Highest value per unit of effort: every price is currently
   `0.00`, so until this exists the product bills nothing.
3. **Site modules editor**, add / schedule-removal / cancel-removal only —
   the same three operations the app already performs, so the semantics are
   proven before anything novel is added.
4. **Account details and site membership** — edit, link, move.
5. **New-site onboarding.**
6. **Admin overrides** — `agreed_price`, backdating, explicit `ends_on`. Last,
   because these are the ones that can create states the app has never seen.

---

## 9. Open questions for the product owner

1. **Should `pos_device` be editable here at all?** The billable count comes
   from `cp2_devices` and the quantity on `cp2_site_modules` is a second
   number for the same thing. Recommendation: show it, don't let anyone type
   into it.
2. **Does closing an account revoke modules?** `status = 'closed'` is read by
   the entitlement layer, but the `cp2_site_modules` rows survive. Confirm the
   intended behaviour — and note that today the fail-open means a closed
   account with an unreachable control DB still gets everything.
3. **Who may set an `agreed_price`?** Discounting is a commercial decision, not
   a support one. This may deserve its own permission.
4. **Should a price change offer to grandfather existing holders?** A single
   "pin every current holder at the old rate" action at the moment of a price
   rise is far safer than expecting someone to remember afterwards.
