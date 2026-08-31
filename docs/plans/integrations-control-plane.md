# Integrations — the control-plane addendum

Addendum to the **Integration Landscape** research memo (26 August 2026,
<https://claude.ai/code/artifact/837a9dae-4613-4a9e-ba27-0c5e8595085e>).

That memo designs four tables — `integration_connections`, `integration_links`,
`integration_events`, `integration_runs`/`integration_failures` — and sequences
the adapters: Yoco online, then Xero, then WooCommerce, then Sage Business Cloud.
It never says which **database** those tables live in, and it never mentions the
control plane at all. This file closes both gaps.

Nothing here changes the memo's sequencing or its four-table design. It adds the
entitlement work that has to happen alongside them, and it writes down one
placement decision that would otherwise get made by accident.

---

## 1 · Which database — the site DB, all four tables

**All four integration tables go in the per-site trading database
(`sql/site/`), not in `odyssey_tickets`.**

The memo is silent on this and the answer is not quite obvious, because
integrations feel like a platform concern. They are not. The test that settles
it is *whose row is it*:

- A Xero connection belongs to **one shop's books**. Two stores that both
  connect to Xero connect to two different Xero organisations.
- `integration_links` records "**our** product 412 is Xero item `a3f9…`" — and
  "our product 412" is a `products.id`, which only exists in a site database.
- `integration_events` holds an inbound Shopify order that will become **that
  site's** sale.

It also puts the new tables beside the two things they generalise, both of which
are already per-site: `tender_integrations` (038_payments.sql) and
`job_calendar_accounts` (226_calendar_sync.sql).

**The constraint this avoids.** `odyssey_tickets` is shared with the v2 backend,
so every `sql/tickets/` migration must be additive — new `cp2_*` tables only,
never an `ALTER` against what is already there. Because nothing in the four-table
design needs to join across to the control DB, that constraint never binds. The
integration migrations are ordinary `sql/site/` files with no special handling.

> **A note for whoever writes the migration.** `integration_links.local_id` is a
> plain `INT UNSIGNED` with no foreign key, deliberately — it points at
> `products`, `customers` or `sales_documents` depending on `entity_type`, so
> there is no single table to reference. A deleted product therefore leaves an
> orphan link row. Sweep them in the sync run rather than trying to cascade.
> Note also that a hybrid till box has **no `products` table at all**, so nothing
> in the sync path may assume the join exists on every machine.

### What does go in `odyssey_tickets`

One migration, `sql/tickets/021_integration_modules.sql`, and it does nothing but
add two module keys and their price rows. Sections 2 and 3.

---

## 2 · The entitlement gap

`MODULE_KEYS` in [moduleCatalogue.ts:30](../../src/lib/control/moduleCatalogue.ts#L30)
holds eight keys today:

```
starter · inventory_advanced · multi_branch · customers
online_store · loyalty · job_cards · accounting
```

**None of them covers "this shop may connect to Xero."** The memo says the
accounting integrations are "a genuine daily labour saving for every customer and
an obvious thing to charge for" — but charging means a `cp2_site_modules` row,
which means a key in that list. It does not exist, and the memo does not budget
for creating it.

### The decision: two keys, not one

Add **`accounting_sync`** and **`ecommerce_sync`**.

This mirrors the split the memo itself draws. The two are not variations on one
feature; they are different products with different risk profiles:

| | Accounting sync | E-commerce sync |
|---|---|---|
| Direction | One-way, push only | Two-way, continuous |
| Cadence | One daily summary document | Per-order, webhook-driven |
| Failure shows up | In a month-end report | In front of a paying customer, as an oversell |
| Buyer's reason | Stop re-typing takings into Xero | Sell the same stock in two places |

A shop with a web store and a bookkeeper who is happy with a CSV wants one and
not the other. Pricing them as one line forces that shop to buy both, and there
is no way to separate them later without a migration that splits a key already
persisted on live rows.

Two keys also lets the storefront question stay open. The memo's closing
paragraph flags that e-commerce sync **competes with your own storefront** — a
retailer on Woo is a retailer not using `online_store`. Whether `ecommerce_sync`
is priced as a peer of `online_store`, a discount against it, or a bundle is a
commercial call, and a separate key is what leaves it available.

### Why not the alternatives

- **One `integrations` key.** Simplest, and wrong for the reason above: it
  welds two different products together permanently.
- **Reuse the existing `accounting` key.** Zero control-plane work, but it hands
  the sync free to every current Accounting customer and still leaves e-commerce
  with no home.
- **Per-provider keys (`xero`, `woocommerce`, …).** Directly contradicts the
  memo's own first rule — *provider stays a string so adding one is a row, not a
  migration*. Per-provider keys make every new integration a deploy.

### Catalogue edits

Three files, all additive:

**[moduleCatalogue.ts](../../src/lib/control/moduleCatalogue.ts)** — add both keys
to `MODULE_KEYS` and both labels to `MODULE_LABELS`. The keys are **persisted, so
they are permanent**; that file's own comment is explicit that renaming one
orphans every row carrying it. No dots, matching the existing convention that
keeps a module (`loyalty`) visually distinct from a capability (`loyalty.view`).

**[moduleMessages.ts](../../src/lib/control/moduleMessages.ts)** — add a
`MODULE_DESCRIPTIONS` entry for each. Follow the pattern the `accounting` entry
set, which deliberately says what it is *not*, because the obvious reading of the
name is too broad:

- `accounting_sync` — "Posts your daily takings straight into Xero, Sage or
  QuickBooks: one summary document per store per day, with revenue by department,
  VAT and a line per tender. Your own books, reports and VAT return are part of
  the base package."
- `ecommerce_sync` — "Keeps your products, prices and stock in step with a
  WooCommerce or Shopify store, and brings its orders to the till for
  acceptance. Odyssey's own online store is a separate module."

Both sentences name the thing the module is easily confused with. The first
stops a shop believing it must buy this to get a VAT return; the second stops it
believing this *is* the storefront.

**`ModuleKey` is a union of `MODULE_KEYS`**, so both additions typecheck
everywhere the moment they land. `MODULE_LABELS` and `MODULE_DESCRIPTIONS` are
`Record<ModuleKey, string>` — miss either and `tsc` says so, which is the intended
behaviour and the reason those types are written that way.

---

## 3 · The migration

`sql/tickets/021_integration_modules.sql`. Additive, `cp2_*` only, no `ALTER`.

```sql
-- Two keys, not one: accounting sync is a one-way daily push whose failures
-- surface at month end, e-commerce sync is two-way and continuous and fails in
-- front of a paying customer. Different products, priced separately.
--
-- Prices are 0.00 for the same reason every other row in cp2_module_prices is:
-- a blank is visibly unfinished on screen, a plausible guess gets invoiced.
--   UPDATE cp2_module_prices SET unit_price = 249.00
--    WHERE module_key = 'accounting_sync';
--
-- effective_from sits far in the past so `starts_on <= today` holds on the
-- first read. ON DUPLICATE KEY UPDATE touches only the note, so re-running this
-- by hand -- which the runner's contract requires -- never resets a price
-- somebody has since set.
INSERT INTO cp2_module_prices (module_key, unit_price, effective_from, note) VALUES
  ('accounting_sync', 0.00, '2020-01-01',
   'Daily takings pushed to Xero / Sage / QuickBooks. Set the real price.'),
  ('ecommerce_sync',  0.00, '2020-01-01',
   'Two-way product, stock and order sync with WooCommerce / Shopify. Set the real price.')
ON DUPLICATE KEY UPDATE note = VALUES(note);
```

### There is deliberately no backfill

008_module_entitlements.sql spends its longest comment on backfill, because
introducing a module that gates *existing* screens without granting it to
existing sites takes half the menu away overnight and looks exactly like a bug.

That reasoning does not apply here, and inverting it would be a mistake. These
two modules gate **nothing that exists yet** — the first screen either one guards
has not been written. Granting them to every site now would hand out a paid
feature for free and, worse, make the eventual launch invisible: a customer who
already "has" the module never sees it appear.

So: no `cp2_site_modules` rows. Sites get one when somebody buys one.

> Consequence worth stating plainly, because it will look like a bug during
> development: with no rows granted, `has(e, 'accounting_sync')` is **false on
> every site**, including yours. Provision a row against your own dev site before
> testing the screens, or every gate will refuse you and the refusal will look
> like broken code.
>
> The one exception is a control-DB outage. `modules.ts` **fails open** — every
> module reads as held and `degraded` is set — so during an outage the
> integration screens appear on sites that never bought them. That is the
> existing, deliberate trade for the back office, and it is safe here for the
> same reason it is safe elsewhere: a customer cannot provision a module for
> themselves, and the write path fails closed.

Apply it with `scripts/tickets-migrate.mjs`, whose ledger is `cp2_ai_migrations`.
The migration runner records files **by name**, so editing this file after it has
been applied does nothing — verify with a `SELECT` against `cp2_module_prices`
rather than assuming.

---

## 4 · Where the gates go

Both keys are asked the same way every other module is: **module first, then
capability**, via `requireModuleCapability()` on pages and `actorForModule()` in
server actions. The order matters because "your shop has not bought this" and
"your role does not include this" send the reader to two different people.

| Surface | Gate |
|---|---|
| Setup → Integrations hub page | `requireModuleCapability(<either>, 'setup.edit')` — see note |
| Connect / disconnect / re-auth actions | `actorForModule('accounting_sync' \| 'ecommerce_sync', 'setup.edit')` |
| Manual "sync now" | `actorForModule(…, 'setup.edit')` |
| Run history and failure list | `actorForModule(…, 'reports.financial')` for accounting; `'setup.edit'` for e-commerce |
| Scheduled sync job | **No user gate** — see below |

**The hub page** is reachable by either module, so it takes `hasAny()` rather
than `has()` — the same shape the existing hub catalogues use for a screen that
more than one module can reach. Each provider *card* on it is then gated
individually, so a shop with only `ecommerce_sync` sees Woo and Shopify and not
Xero.

**The scheduled job has no capability gate** because there is no actor — nobody
is signed in. It must still check the module, and it must check it **per site, at
the moment it runs**, not when the schedule was created: a site that cancelled
last month must stop syncing without anyone rebuilding the schedule. Read the
entitlement inside the per-site loop.

> `cache()` from React is **request-scoped**, so the memoised entitlement read
> gives no memo at all in a standalone script or a cron process. Each site's read
> is a real query. That is correct here — you want the live answer per site — but
> it means a stale result in a batch job is stale **data**, not a cache artefact.
> Print the row before blaming the cache.

**The till is never gated on either module.** A failing or unbought integration
must not stop a sale — the same rule the GL already follows as a derived mirror.
Sales enqueue; the sync drains the queue later or reports a failure. Nothing on
the sale path asks a module question about integrations.

---

## 5 · Payments need nothing from the control plane

Yoco — the memo's first build, at 1–2 weeks — requires **no control-plane work at
all**. This was worth confirming rather than assuming, because the memo leans on
the PayFast precedent throughout.

[setup/payments/page.tsx](<../../src/app/(app)/setup/payments/page.tsx>) gates on
`requireCapability('setup.edit')` — a capability alone, **no module**. That is
deliberate and the file explains why at length: the screen used to sit behind the
`online_store` module, and a shop that had never bought the storefront then could
not reach the screen, could not connect a gateway, and so its invoice pay links
silently never appeared — a setting that simply looked broken. A gateway is not a
storefront feature: a pay link on an emailed invoice, a QR on a printed statement
and a lay-by instalment all need the same connected account and none involves a
storefront.

Yoco inherits that unchanged. It is a `tender_types.provider` string and a
`tender_integrations` row, both per-site, both already built. **Do not add a
module key for payments** — doing so would reintroduce exactly the bug that
comment records.

Keep the per-store credential rule absolutely intact, for the regulatory reason
already written into `038_payments.sql`: money moves shopper → store directly,
and routing store takings through one platform account would make this a payment
aggregator, which is a regulated activity.

---

## 6 · Revised sequence

The memo's order, with the control-plane work slotted in:

1. **The four site tables** — a week or less, and the only item that gets more
   expensive the longer it waits. `sql/site/`.
2. **`sql/tickets/021` + the three catalogue files** — under a day, and it can
   run in parallel with step 1 since they touch different databases. Doing it
   *now* rather than at Xero time means the billing screen is right from the
   first adapter, and it is cheap precisely because nothing is gated on the keys
   yet.
3. **Yoco online** (1–2 weeks) — needs neither of the above strictly, but proves
   the new tables against a real provider. No module key.
4. **Xero** (4–6 weeks) — first consumer of `accounting_sync`. Start the
   certification paperwork the day the code starts; uncertified caps you at 25
   connected organisations, which is a pilot and not a customer base.
5. **WooCommerce** (4–6 weeks) — first consumer of `ecommerce_sync`.
6. **Sage Business Cloud** — highest commercial value in South Africa, third
   accounting adapter against machinery that already works.

Hold QuickBooks and Shopify until a real customer asks. For Shopify, get the
commercial answer on custom distribution **before** writing anything: App Store
requirement 1.1.8 refuses apps connecting to an external POS, so a listed app is
not available and per-merchant custom distribution is the only route. Decline
desktop Pastel and offer a CSV/journal export.

---

## Open questions

1. **Is `ecommerce_sync` priced against `online_store` or beside it?** A retailer
   on WooCommerce is a retailer not buying the storefront. Two keys keep every
   option available; the commercial answer is still owed.
2. **Does Sage 200 Evolution get its own key?** The memo prices it as a separate
   project — on-premise, materially harder. If it is sold separately it probably
   wants its own key rather than riding `accounting_sync`.
3. **Card-present Yoco** needs the Yoco Neo, local pairing and a device-level
   agreement. Scoped separately per the memo, and it may need a
   `pos_device`-shaped quantity rather than a feature key. Talk to Yoco's partner
   team before quoting.
