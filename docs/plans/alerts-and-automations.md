# Alerts & automations

Port of the legacy Odyssey "Alerts & Automations" feature onto OdysseyAI's own
foundations. The legacy version is `src/lib/alerts/*` + `src/app/(app)/setup/alerts/*`
in `C:\Users\tiaan\Documents\Github\Odyssey`; this plan keeps its architecture and
replaces every legacy primitive with the equivalent that already exists here.

## What it is

A rule is an **intent**: a CONDITION + a WHEN + a WHO + optionally an ACTION.

Nothing about the condition's data is stored. The check re-runs fresh on every
firing, recipients re-resolve out of `users` at send time, and the rule runs
under its stored owner's capabilities — because there is no session at 07:00.

Delivery fans out over four independent channels: the **bell** (the existing
notification centre), **email**, **WhatsApp** and **SMS**.

## Why it is shaped like the report scheduler

`report_schedules` / `report_schedule_runs` already solves the identical problem
— an unattended thing that must fire exactly once per occurrence across any
number of processes. Alerts reuse its vocabulary wholesale:

* `lastDueAt` / `nextDueAt` / `describeSchedule` from `src/lib/reportSchedules/due.ts`
  are **imported verbatim**, not copied. Two rules that both say "07:00 daily"
  must compute a byte-identical instant, and one function guarantees that.
* The run ledger's `UNIQUE (rule_id, due_at)` is the claim. Whoever wins the
  INSERT runs; everyone else gets `ER_DUP_ENTRY`, which means "someone has this",
  not an error.
* Time-of-day scheduling only (daily / weekly / monthly), never intervals. An
  interval invites "every 5 minutes", which races the tick and floods a mailbox.

## What is deliberately different from legacy

| Legacy | Here | Why |
|---|---|---|
| `tblbackoffice_notifications`, one row per recipient | the existing `notifications` + `notification_reads` tables | This project already has a notification centre with capability-scoped audiences resolved at READ time. Fanning out per user would go stale the day a role changes. |
| `tblsecurity.UserName` string recipients | `users.id` integer recipients | Matches `report_schedules.recipient_user_ids`. |
| `PERMISSIONS.ALERTS` permission row | capability `setup.edit` for managing rules; per-kind acting capability for rules that ACT | No new permission vocabulary; the capability list is already the boundary. |
| `ensureAlertTables()` at runtime | a numbered file in `sql/site/` | This project migrates by file, and migration files are recorded by name. |
| its own tick route + secret | rides the existing `/api/alerts/tick` | One heartbeat, one secret, one per-site try/catch — that route already exists and already sweeps every active site. |

## Scope of this implementation

The full engine, plus **eight** rule kinds whose data unambiguously exists here.
Each additional kind is one new file plus one `case` in the registry, so the
remaining twelve legacy kinds are additive work, not rework.

1. `low_stock` — at or below minimum, optionally **drafting one purchase order
   per supplier** (the automation half of the feature).
2. `negative_stock` — stock on hand below zero.
3. `price_below_cost` — selling price under cost, or under a minimum GP%.
4. `dead_stock` — holding stock that has not sold in N days.
5. `cashup_variance` — a drawer short (or over) by more than a threshold.
6. `missing_cashup` — a shift that traded but was never cashed up.
7. `credit_limit` — account customers at or over their limit.
8. `unprocessed_grvs` — deliveries received but never posted.

## Files

### Schema — `sql/site/184_alerts.sql`

```
alert_rules      id, kind, name, is_active,
                 frequency, send_time, days_of_week, day_of_month,
                 config_json,
                 notify_bell, notify_email, notify_whatsapp, notify_sms,
                 recipient_user_ids, recipient_emails, whatsapp_numbers, sms_numbers,
                 owner_user_id, created_by, created_by_name,
                 last_run_at, last_run_status, last_run_error

alert_rule_runs  id, rule_id, due_at, status, claimed_at, finished_at,
                 item_count, created_docs, recipients, attempts, error_text,
                 UNIQUE (rule_id, due_at)
```

`config_json` is TEXT holding per-kind knobs, parsed sceptically with a default
for every key — a new kind must never mean an ALTER, and a malformed value must
degrade rather than throw inside a sweep over every site.

`created_docs` records what an automation CREATED ("PO-000031, PO-000032"), so
the ledger answers "what did this thing do in my name" without a second table.

### Pure model — `src/lib/alerts/types.ts` (client-safe)

`AlertKind` union, labels/descriptions/default names per kind, `AlertConfig`
with `readConfig()` clamping every knob, and `validateAlertRule()` — the one
validator the modal and the server both call.

### Store — `src/lib/site/alerts.ts`

`listRules` / `listActiveRules` / `getRule` / `createRule` / `updateRule` /
`setRuleActive` / `deleteRule`, plus the ledger: `claimRun`, `finishRun`,
`recordLastRun`, `reclaimStaleRuns`, `listRuns`. A direct structural sibling of
`src/lib/site/reportSchedules.ts`, including `siteQuery`/`siteExecute` usage.

### Channels — `src/lib/alerts/deliver.ts`

One message, four renderings:

* **bell** → `notify()` per recipient user id (`userId` targeting, so the row
  reaches exactly who the rule names).
* **email** → `send()` from `src/lib/mail.ts`; user ids resolve to addresses
  fresh from `users`, literals pass through validated.
* **WhatsApp** → new `src/lib/whatsapp.ts` (below).
* **SMS** → the existing `getSmsProvider(siteId)`.

Failure semantics per channel, chosen deliberately: bell and email failures fail
the run (it retries); WhatsApp and SMS failures become **notes on the run**, never
a failed run — a dead Meta token must not re-send every email three times.

### WhatsApp — `src/lib/whatsapp.ts` + settings

Port of the legacy Meta WhatsApp Business Cloud sender. Settings-driven, not
env-driven, so it works per site: three new `SETTING_DEFAULTS` keys
(`whatsapp_enabled`, `whatsapp_phone_id`, `whatsapp_token`) written by a new
panel on `/setup/sms` (renamed in the UI to cover both), with the same masked-
secret guard `saveSmsSettingsAction` already uses for the SMSPortal secret.
`sendWhatsAppText()` **never throws** — an unconfigured site resolves to
`{ sent: false, skipped: 'not-configured' }` and callers carry on.

### Evaluators — `src/lib/alerts/<kind>.ts`

Each exports `evaluate<Kind>(siteId, rule, now)` and `<kind>Message(rule, result)`
returning `{ kind, title, summary, lines, html, href }`. Shared table/HTML/format
helpers live in `src/lib/alerts/messageHtml.ts` (inline styles — this lands in
mail clients, where the design tokens do not apply).

Each evaluator reads through the domain lib that already exists rather than
writing its own SQL where one is available:

* low stock → `reorderSuggestions()`; drafting orders → the ordinary
  `purchaseDocuments` create path, so the result is a normal editable draft.
* cashup variance / missing cashup → `shifts.ts`.
* credit limit → `creditControl.listPositions()`.
* unprocessed GRVs → `purchaseDocuments.listPurchaseDocuments()`.

**The counting rule**: a kind that caps its read must COUNT separately. A cap
that lies ("500 products" when the truth is 3,000) is worse than a slow query.

### Engine — `src/lib/alerts/tick.ts`

Per site: reclaim stale claims, list active rules, and for each compute
`lastDueAt`. Then, in order:

1. **Staleness** — older than 12 hours is claimed and SKIPPED. A cash-up alert
   for last week landing this morning looks current, and somebody acts on it.
2. **Claim** — `ER_DUP_ENTRY` means someone else has it; do nothing.
3. **Owner check** — the owner must still exist, be active, and still hold
   `setup.edit`. A rule whose owner lost access deactivates itself with a reason
   on the card, rather than running with privileges nobody holds.
4. **Acting capability** — a rule that CREATES something answers to that
   module's capability too (`low_stock` + `createOrders` → `purchasing.edit`).
   Checked at SAVE time as well, so it fails in front of the person configuring
   it rather than silently at 07:00.
5. **Evaluate**. `itemCount === 0` is a **successful run, not a notification** —
   a clean bill of health must not interrupt anyone nightly.
6. **Deliver**, then record recipients, item count and created documents.

Rules run sequentially within a site: drafting an order draws a document number
from the sequence table, and there is no reason to make rules race each other.

The registry `switch` has **no `default`** on purpose. TypeScript then fails the
build when a kind is added to the union without an evaluator, and a row written
by a newer build fails that one occurrence loudly instead of quietly running
some other rule's check under the wrong name.

### Cron — `src/app/api/alerts/tick/route.ts` (edit)

Add the alert sweep as a third job alongside the low-stock digest and SLA
escalation, in its own per-site `try/catch`, reporting `{ considered, fired,
skipped, failed }` in the JSON. The route already has the secret, the timing-safe
compare, the `activeSiteIds()` loop and the `PUBLIC_PREFIXES` entry.

`buildLowStockDigest` stays where it is — the standalone digest keeps working
for sites that have configured it, and the new `low_stock` rule kind is the
richer, per-recipient successor. No behaviour is removed under anyone's feet.

### Screen — `src/app/(app)/setup/alerts/`

`page.tsx` (server, `requireCapability('setup.edit')`, flattens rules to a
serializable row shape and computes `nextDueAt` server-side so it cannot drift
from the scheduler), `AlertsClient.tsx` (a `DataTable` in a `Card` — On /
Alert / When / Next / To / Last run — with row actions Run now, Edit, Delete,
matching `SchedulesClient`), `AlertModal.tsx` (kind picker with its one-line
description, per-kind config panel, frequency/time/day controls, channel
switches, recipient checkbox list + free-text addresses/numbers), `RunsModal.tsx`
(the ledger for one rule), `actions.ts` (`actorFor('setup.edit')`, re-validating
every field server-side).

Everything from `@/components/ui`; a `Callout tone="warning"` when a chosen
channel is not configured for the site, exactly as the schedules page warns
about SMTP.

### Registration

* `src/lib/nav.ts` — `SUBPAGE_LABELS['/setup/alerts'] = 'Alerts & automations'`,
  a `SUBPAGE_OWNER` entry pointing at `/setup`, and search keywords.
* `src/app/(app)/setup/catalogue.ts` — a tile with `capability: 'setup.edit'`.
* `src/lib/site/notifications.ts` — extend `NotificationEvent` with the eight
  new kinds so the bell can label and icon them.

## Verification

* `scripts/test-alerts.ts` — the engine's invariants, run against a real site:
  a rule claims exactly one run per occurrence (two ticks in a row → one row);
  a stale occurrence is skipped, not sent; `itemCount === 0` records `sent` and
  notifies nobody; an owner without the capability deactivates the rule with a
  reason; `readConfig` degrades every malformed knob to its default; and each of
  the eight evaluators runs without throwing and reports a count that matches an
  independent COUNT(*).
* Migration applied to every active site with `site-migrate.mjs`, verified with
  `SHOW COLUMNS`.
* The screen driven in a browser over CDP: create a rule, Run now, read the run
  history, confirm the bell row lands for the named recipient only.
* `npm run build` + `tsc`.

## Order of work

1. `184_alerts.sql`, applied and verified.
2. `types.ts` (pure model) and `src/lib/site/alerts.ts` (store + ledger).
3. `messageHtml.ts`, `deliver.ts`, `whatsapp.ts` + settings keys.
4. `tick.ts` with `negative_stock` only — proves claim, ledger, delivery.
5. The remaining seven evaluators, `low_stock` (with order drafting) last.
6. The screen, then nav/catalogue registration.
7. `test-alerts.ts`, browser verification, build.
