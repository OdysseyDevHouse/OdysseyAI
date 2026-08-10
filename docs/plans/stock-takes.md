# Stock takes — counting what is there, and making the books agree

## Where this starts

The slot for this feature was cut long before the feature. Five separate pieces
of the system already assume a stock take exists:

- `src/lib/nav.ts:118` — a **Stock Takes** entry pointing at `/stock-takes`,
  gated on `stock.adjust`, deliberately without `built: true` so it renders
  greyed. The route does not exist.
- `src/lib/site/permissions.ts:101` — the capability `stock.adjust`, whose own
  hint reads *"Adjust stock, write stock on or off, and count it."*
- `stock_movements.movement_type` has carried `'adjustment'` since
  `sql/site/015_sales_core.sql:376`. Today it is written **only** by document
  voids (`purchasePosting.ts:491`, `purchaseReversal.ts:295`). No human has ever
  written one.
- `products.last_adjust_date` (`sql/site/001_products.sql:116`) exists and is
  **written by no code path in the repo.** It was reserved for this.
- `product_location_stock`'s `ix_pls_location` index carries the comment that it
  was built for *"the picking and stock-take direction"*
  (`sql/site/025_stock_locations.sql:143`).

So the shape is pre-agreed. What is missing is the count sheet itself: a
document that snapshots what the system believes, records what a person found,
and posts the difference as adjustments.

There is one further gap the schema does not hint at. `glPosting.ts` has mirror
builders for sales and purchases only. An adjustment has **no GL mirror**, which
is fine while adjustments are just the reverse half of a voided document — the
document's own journal already reversed. A standalone write-off has no such
partner, and stock walking out of the building with no entry in the accounts is
the single biggest thing this module must not do.

## What already exists, and must be reused

The cheapest version of this work writes almost no new arithmetic.

| Need | Already in the repo |
|---|---|
| The only legal way to change stock | `recordMovement()` — `src/lib/site/stockMovements.ts:194` |
| Adjustment movement type | `'adjustment'` in `MOVEMENT_TYPES` (`stockMovements.ts:28`) |
| Per-location piles, upserted safely | `product_location_stock`, via `recordMovement` |
| Proof the figures add up | `reconcileStock()` — `stockMovements.ts:328` |
| Position at a past date | `stockAsAt()` — `stockMovements.ts:466` |
| Document numbering, transaction-scoped | `nextDocumentNumber()` — `sequences.ts:145` |
| Period locking | `isPeriodLocked()` — used at `stockTransfers.ts:235` |
| Weighted average cost | `weightedAverageCost()` in `pricing.ts` |
| Cost basis setting (last vs average) | `src/lib/pricing.ts:30` |
| GL mirror plumbing, fail-soft | `attempt()` / `mapped()` / `postTx()` in `glPosting.ts` |
| Serial state per unit | `product_serials.status`, `serial_movements` (`021`, `027`) |
| A document lifecycle to copy wholesale | `src/lib/site/stockTransfers.ts` + `src/app/(app)/transfers/` |
| Unsynced-sale count the cashier must see | `PosSyncState.pending` (`posOffline/types.ts:296`) |
| Capability | `stock.adjust` (write), `stock.view` (lookups) |

The module to imitate throughout is **transfers**. It is the closest existing
thing: a stock-moving document with draft/posted/cancelled, a pure validator
kept separate so the screen refuses the same things for the same reasons, a
`reconcile*()` drift report, and a void that writes compensating movements
rather than deleting history.

---

## The four decisions that shape everything else

These are the choices worth making deliberately, before any code. Each one, if
made carelessly, is expensive to unmake later.

### 1. A count sheet snapshots, and the snapshot is not the truth at post time

When a sheet is created, the system's believed quantity is copied onto every
line (`snapshot_qty`). Someone then walks the shelves — for an hour, or over a
weekend. Meanwhile the till keeps selling.

At post time there are two possible variances:

- **counted − snapshot** — what the counter would say the difference is
- **counted − current** — what actually has to be written to make the pile match

**The movement must be `counted − current`.** Posting `counted − snapshot` would
leave the pile disagreeing with the count sheet the moment anything sold during
the count, which is the one outcome a stock take exists to prevent.

Both figures are stored on the line, because they answer different questions:
`snapshot_qty` is what the counter was working against and belongs on the
variance report; `posted_qty_before` is what the pile actually held at the
instant of posting, and `counted_qty − posted_qty_before` is the movement. When
they differ, the sheet says so plainly on screen — *"3 units sold during this
count"* — rather than silently reconciling.

The current quantity is read `FOR UPDATE` inside the posting transaction, in the
same way `postTransfer` locks its FROM piles (`stockTransfers.ts:261`), so two
people posting overlapping sheets cannot both write against the same stale
figure.

### 2. Top-up and set-to-level are the same document with two line modes

The request names two operations. They are not two documents:

- **Set** — `counted_qty` is the new absolute level. Movement = `counted − current`.
- **Top up** — the user enters a quantity to *add*. Movement = the entered
  quantity; `counted_qty` is derived as `current + entered`.

One `line_mode ENUM('count','topup')` column, resolved to a movement by the same
posting code. Storing which mode was used matters for the audit trail: "counted
14" and "added 6" are different claims about reality even when both land on 14.

A third mode, **`recount`**, is worth the column now rather than a migration
later — see phase 4.

### 3. Freezing is a flag on the sheet, not a lock on the products

"Freeze stock takes" can mean two different things, and the distinction decides
whether the feature is usable in a real shop:

- **Freeze the sheet** — the snapshot is taken and the lines are locked from
  editing. Counting proceeds against a fixed baseline.
- **Freeze the stock** — refuse to sell counted products until the sheet posts.

The second is what a warehouse means by it and what a shop cannot afford. A till
that refuses to sell during a Sunday count is a till that loses Sunday.

So: **freezing freezes the sheet, never the till.** A frozen sheet's
`snapshot_qty` values are immutable, no lines may be added, and the sheet
carries `frozen_at`. Sales continue, and decision 1 handles the consequence —
the variance report separates "the count was wrong" from "it sold while you
counted."

There is one legitimate hard freeze: an annual count where the doors are shut.
That is modelled as a **blocking sheet** — `is_blocking TINYINT` — which the
till availability path consults. It is deliberately phase 6, opt-in, and off by
default, because it is the setting that can stop a business trading.

### 4. Cost on a write-on, and the GL entry

`average_cost` is written by exactly one path today — GRV posting
(`purchasePosting.ts:300`) — and `purchaseReversal.ts:38` records the decision
that a reversal does *not* unwind it.

A stock take must not become a second writer of `average_cost`. Found stock is
valued at the **existing** `average_cost` (falling back to `last_cost`, then
zero), the figure is snapshotted onto `stock_movements.unit_cost_excl` as every
other movement does, and the product's average is left alone. A count is a
statement about quantity, not about what the goods cost. If a user needs to
restate cost, that is a GRV or a cost adjustment, not a count sheet.

The GL entry, mirrored per posted sheet as one journal (not one per line):

```
Write-off (counted less than expected):
  DEBIT   stock_adjustment      value of the shortfall
  CREDIT  stock_control         value of the shortfall

Write-on (counted more than expected):
  DEBIT   stock_control         value of the surplus
  CREDIT  stock_adjustment      value of the surplus
```

`stock_adjustment` is a **new mapped account key** — a cost-of-sales-adjacent
expense account, seeded in the migration alongside the existing ones in
`glModel.ts`. Net value is used, so a sheet with offsetting variances posts one
small entry rather than two large ones.

It follows the existing fail-soft contract (`glPosting.ts:10-35`): if the
account is unmapped, **the stock movements still stand** and the gap surfaces in
`ledgerHealth()`. Stock accuracy is never held hostage to a chart-of-accounts
mapping. This matches `mirrorSale`'s behaviour (`:183`, which skips when
unmapped) rather than `mirrorGrv`'s (`:247`, which throws).

---

## The shape of the work

Seven phases. Each ends with the tree green and something a user can do, so the
sequence can stop between any two without leaving a half-built screen.

**The module is complete.** Phases 1–5 and 7 are built; phase 6 was dropped
after reading the sell path, for reasons recorded under it. Usable end to end:
create a sheet, freeze it, count it (by quantity or by scanning serial units),
post it, re-count what you doubt, reverse it, and report on what it found.

Verified against the real dev database, not just fixtures: sheet STK000009
posted 2 movements from 6 counted lines and produced a balanced journal, with
`reconcileStock` at zero drift before and after, and both shrinkage templates
returning rows from it.

`recountStockTake` is the phase-4 addition worth naming. It takes a posted
sheet's variance lines into a fresh sheet in one click, marked `line_mode =
'recount'`. Two details make it correct rather than merely convenient: it
snapshots the pile **as it is now**, not as the first sheet left it — so a
re-count that confirms the original finds a variance of zero and writes nothing,
which is exactly what confirming a count should do — and it takes its lines from
`variance_qty` (what actually posted) rather than counted-vs-snapshot, because a
line that looked wrong against a stale snapshot may have posted zero once the
mid-count sale was accounted for.

What landed, and what changed on contact with the schema:

- `sql/site/081_stock_takes.sql` — applied to site 1. Not `080`: other sessions
  had already taken it, and the repo is now at `085`.
- `sql/site/085_stock_take_scope_brand.sql` — the scope enum shipped as
  `category`, which products do not have. Corrected in its own file rather than
  by editing `081`, because a migration is recorded by name once it has run and
  editing an applied file changes only what a *fresh* site gets.
- `src/lib/site/stockTakes.ts` — the full domain layer.
- `src/lib/site/glPosting.ts` — `mirrorStockTake`, the first adjustment journal
  the system has ever written. Fail-soft like `mirrorSale`, called after the
  stock transaction commits so a chart-of-accounts gap cannot roll back a
  completed count. Cancelling a posted sheet writes the reversing entry.
- `src/lib/site/sequences.ts` — `verifySequence` taught about doc types with
  their own table. Two bugs, both predicted by this plan and both real: it looked
  in `sales_documents` and reported every stock take number as missing, and its
  `doc_type = ?` predicate would have errored against a table that has no such
  column because the whole table is one type. `stock_transfer` was added to the
  same map — it had the identical latent bug.
- `scripts/test-stock-takes.ts` — 51 checks, all passing, including the
  sell-during-the-count case that the whole two-figure design exists for.
  Registered as `npm run test:stock-takes`.
- `src/app/(app)/stock-takes/` — seven files: the list, the new-sheet screen,
  the detail page, the counting grid, the action buttons, and `actions.ts`.
- `src/lib/nav.ts` — `built: true`, plus the `LEAF_LABELS` entry.
  `scripts/smoke-routes.mjs` and `test-navigation.ts`'s `UNLINKED` allowlist
  both know about the new routes.
- `src/components/ui/icons.tsx` — `ClipboardList`, the glyph the nav was already
  using for this entry and which the kit did not yet re-export.

**Two things the real database taught that fixtures could not.** A full-catalogue
sheet on the dev site came to **40,062 lines** — not a stock take, a two-week
job with no way to hand a section to anyone or post the finished part, and a
screen rendering 40,000 live inputs. Hence `MAX_SHEET_LINES = 5000`, refused at
creation rather than truncated, with the refusal naming a *narrower* scope than
the one that failed (a department here is itself 19,984 products, so "count a
department instead" would have been advice that also fails).

And the first posted sheet came out at **+38 units / −R30.40** — forty cheap
units found against two expensive ones missing. The list column was showing a
green `+38` on a sheet that had written money off. Both the column and the
detail Callout now lead with **value** and carry units underneath.

Two corrections to what this plan assumed, both cheap because they surfaced
before any UI existed: GL account **5100 "Stock adjustments" already exists** in
the seeded chart (`045`), so only the mapping key was new; and the offline guard
is narrower than first written — see phase 4.

---

### Phase 1 — Schema  ✅ built

New: `sql/site/080_stock_takes.sql`

Highest migration today is `079_offline_returns.sql`. Number collisions are
tolerated by the runner (it sorts by filename) but check for a parallel branch
holding 080 before committing.

**`stock_takes`**

| Column | Notes |
|---|---|
| `id` | PK |
| `document_number` VARCHAR(32) NULL | UNIQUE; allocated at **post**, not at create — a draft that is deleted must not burn a number |
| `document_date` DATE | The date the count is effective |
| `location_id` INT UNSIGNED | FK `stock_locations` RESTRICT. One sheet, one room |
| `status` ENUM | `'draft','counting','posted','cancelled'` |
| `scope` ENUM | `'full','department','category','supplier','manual'` — what the sheet was built from |
| `scope_ref_id` INT UNSIGNED NULL | The department/category/supplier id when scope is not manual |
| `reference` VARCHAR(60) NULL | |
| `note` VARCHAR(400) NULL | |
| `frozen_at` DATETIME NULL | Set when the sheet is frozen; snapshot immutable from here |
| `is_blocking` TINYINT DEFAULT 0 | Phase 6. Off by default |
| `posted_at`, `cancelled_at` DATETIME NULL | |
| `cancel_reason` VARCHAR(200) NULL | Use `cancel_*`, not `void_*` — see the `026`/`029` rename below |
| `variance_qty`, `variance_value` DECIMAL | Denormalised totals for the list, written at post |
| `user_id` INT UNSIGNED NULL, `user_name` VARCHAR(120) NOT NULL DEFAULT '' | Name snapshotted, no FK |
| `created_at`, `updated_at` | `ON UPDATE CURRENT_TIMESTAMP` |

**`stock_take_lines`**

| Column | Notes |
|---|---|
| `id` PK, `stock_take_id` | FK CASCADE |
| `line_number` INT | |
| `product_id` INT UNSIGNED | FK RESTRICT — history outlives the product, as `stock_movements` does (`015:406`) |
| `product_code`, `description` | Snapshotted |
| `line_mode` ENUM | `'count','topup','recount'` |
| `snapshot_qty` DECIMAL(12,3) | What the system believed when the sheet was made |
| `counted_qty` DECIMAL(12,3) NULL | NULL = **not yet counted**, distinct from counted-as-zero. This distinction is the whole reason the column is nullable |
| `entered_qty` DECIMAL(12,3) NULL | What the user typed on a topup line |
| `posted_qty_before` DECIMAL(12,3) NULL | The pile at the instant of posting |
| `variance_qty` DECIMAL(12,3) NULL | `counted − posted_qty_before`, written at post |
| `unit_cost_excl` DECIMAL(12,4) | Snapshotted at post |
| `serial_ids` JSON NULL | Phase 5 |
| `counted_at` DATETIME NULL, `counted_by` VARCHAR(120) NULL | Who found what, and when |
| `note` VARCHAR(190) NULL | |
| `movement_id` BIGINT NULL | The `stock_movements` row this line produced. Nullable — a zero-variance line writes no movement |

Keys: `UNIQUE (stock_take_id, product_id)` — a product cannot appear twice on one
sheet, which is the commonest source of a double-posted variance.
`ix_take_status_date`, `ix_line_product`.

Sequence row:
```sql
INSERT IGNORE INTO document_sequences (doc_type, prefix, next_number, padding, reset_period)
VALUES ('stock_take', 'STK', 1, 6, 'none');
```

GL account: seed `stock_adjustment` in the mapped-account set alongside the
existing keys in `src/lib/glModel.ts`.

Migration file rules, all of which this repo enforces the hard way:
`CREATE TABLE IF NOT EXISTS` throughout (DDL auto-commits; every step must be
re-runnable by hand), named constraints and indexes, explicit
`ON DELETE RESTRICT`/`CASCADE` with a comment saying why, `ENGINE=InnoDB DEFAULT
CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`, and **no apostrophes anywhere in a
comment** — the runner sends the file as one `multipleStatements` batch and
MariaDB reads a lone `'` inside a `--` comment as opening a string literal,
swallowing the rest of the file.

Vocabulary: `026_stock_transfers.sql` declared `void`/`void_reason` and then had
to be renamed by `029_rename_void_columns.sql` to `cancelled`/`cancel_reason`.
Pick `cancelled` here on day one.

**Ends with:** `node --env-file=.env scripts/site-migrate.mjs <siteId>` applies
cleanly, `SHOW COLUMNS` confirms the shape. Nothing visible yet.

---

### Phase 2 — The domain layer  ✅ built

New: `src/lib/site/stockTakes.ts`, `'server-only'`, shaped on
`stockTransfers.ts`.

```
createStockTake(siteId, actor, input)     — builds the sheet and snapshots lines
addLines / removeLine / saveCounts        — refused once frozen
freezeStockTake(siteId, actor, id)        — re-snapshots, stamps frozen_at
postStockTake(siteId, actor, id)          — the whole point; below
cancelStockTake(siteId, actor, id, reason)
listStockTakes / getStockTake / varianceReport
validateStockTake(sheet): string | null   — pure, so the screen refuses first
reconcileStockTakes(siteId)               — drift report, in the style of stockTransfers.ts:511
```

**The snapshot query** is the one piece of genuinely new SQL. It selects
products into a sheet by scope, joined to `product_location_stock` for the
sheet's location, `LEFT JOIN`ed so a product with no pile row appears with zero
rather than vanishing — a product that has drifted to a pile of nothing is
exactly what a count needs to surface. It must exclude variant **parents**
(`recordMovement` refuses them outright at `:203`) while including their
children, and exclude non-stocked product types (services, vouchers).

**`postStockTake` — the ordering matters, and it is the same order transfers uses:**

1. `validateStockTake` — pure refusals first, no transaction.
2. `isPeriodLocked(siteId, docDate)` — refuse a locked VAT period.
3. Open `siteTransaction`.
4. Lock and read every line's current pile `FOR UPDATE`, in `product_id` order
   so two concurrent sheets deadlock-free. Write `posted_qty_before`.
5. Compute each line's movement: `counted − posted_qty_before` for `count` and
   `recount`, `entered_qty` for `topup`.
6. **Skip zero-variance lines entirely.** A movement of 0 is noise in the one
   table people read to answer "what happened to this product". A full-store
   count of 4,000 products with 12 discrepancies should write 12 movement rows.
7. `recordMovement(tx, actor, { movementType: 'adjustment', source: 'stock_take',
   sourceDocId, sourceLineId, locationId, unitCostExcl, note })` per varying line.
   Store the returned `movement_id` on the line.
8. Update `products.last_adjust_date` — the column reserved for this, currently
   written by nothing.
9. `nextDocumentNumber(tx, 'stock_take')` — **last write before commit.** It
   takes an exclusive row lock held until COMMIT, so allocating it early
   serialises every other posting behind a count that may touch 4,000 rows.
10. Stamp `status='posted'`, `posted_at`, and the denormalised variance totals.
11. Commit.
12. **After** commit, mirror to the GL via `mirrorStockTake` — fail-soft, outside
    the stock transaction, so a mapping gap cannot roll back a completed count.

**`cancelStockTake`** on a *posted* sheet writes compensating `adjustment`
movements (the exact inverse, at the same snapshotted cost) and a reversing
journal. It never deletes movement rows. On a draft it simply stamps the status.

New in `src/lib/site/glPosting.ts`: `mirrorStockTake(siteId, actor, input)`,
following `mirrorSale`'s fail-soft pattern — `mapped(siteId, 'stock_adjustment')`
returning null skips the entry rather than throwing.

**Ends with:** `scripts/test-stock-takes.ts` posting a sheet against seeded
products and proving `reconcileStock()` is clean afterwards. No UI.

---

### Phase 3 — The screens  ✅ built

Follows the transfers layout exactly. Server `page.tsx` guarded by
`requireCapability('stock.adjust')`, client `*Table.tsx` owning the
`Column<T>[]` array, `actions.ts` using `actorFor('stock.adjust')` for mutations
and `actorForOrThrow('stock.view')` for lookups.

```
src/app/(app)/stock-takes/
  page.tsx                    list — StatStrip (open sheets, lines to count, last posted, variance value)
  StockTakesTable.tsx         client, columns + row-click nav
  actions.ts                  'use server'
  new/page.tsx  NewStockTakeScreen.tsx     scope picker → snapshot → draft
  [id]/page.tsx                            detail, status-driven Callout
  [id]/CountSheet.tsx                      the counting grid
  [id]/PostStockTakeButton.tsx             modal + variance summary before commit
  [id]/CancelStockTakeButton.tsx           reason in a modal, not a bare confirm
```

**The counting grid is the screen that decides whether this module gets used.**
It is not a form; it is a data-entry instrument that someone uses standing up,
on a tablet, in a stockroom, for two hours. What that requires:

- **Scan to jump.** A barcode scan focuses that product's row and puts the
  cursor in its quantity field. This is the primary interaction, not a
  convenience — a counter holds a scanner, not a mouse.
- **Enter commits and advances** to the next uncounted line.
- **Uncounted is visibly distinct from zero.** An empty field and a typed `0`
  are different claims, and the grid must never let them look alike.
- **Progress is always on screen** — *"312 of 480 counted"* — because the
  question a counter asks every few minutes is "how much is left."
- **Autosave per line**, debounced, with a per-row saved indicator. A two-hour
  count that loses an hour to a closed tab is a module nobody uses twice.
- **Filter to uncounted / to variances.** The second pass over a sheet only ever
  looks at the lines that disagree.
- **Variance is shown live**, in qty and value, coloured by direction using
  tokens (`text-danger`, `text-success`) — never a raw colour.

Before writing any of it, invoke the `odyssey-ui` and `odyssey-craft` skills, as
`AGENTS.md` requires: import only from `@/components/ui`, tokens only, icons
from `@/components/ui/icons`.

Wiring: `src/lib/nav.ts:118` gets `built: true`; a `LEAF_LABELS` entry at `:338`
so breadcrumbs read `New stock take` / `Stock take`; and
`scripts/smoke-routes.mjs` `DYNAMIC` gets
`'/stock-takes/[id]': 'SELECT id FROM stock_takes ORDER BY id DESC LIMIT 1'`.

**Ends with:** a user can create, count, post and cancel a sheet.

---

### Phase 4 — Freeze, recount, and the offline-sales guard  ✅ built

**Freeze** re-snapshots against the current pile and stamps `frozen_at`. From
then on lines are read-only in structure — quantities are still enterable, but
no product may be added or removed and `snapshot_qty` is immutable. The sheet
shows *"Frozen at 14:32. 3 items have sold since."*

**Recount** promotes a posted sheet's variance lines into a new sheet with
`line_mode='recount'`. The realistic workflow is: count, look at the variances,
disbelieve half of them, count those again. Building this as a first-class action
(rather than making someone hand-build a second sheet) is the difference between
a module that gets used properly and one where people post a bad count because
re-counting was tedious.

**The offline-sales guard**, and it is narrower than it first looks.

The sync engine posts every offline sale it possibly can — `offlineSync.ts`
refuses nothing it can write, because a refused sale is lost revenue rather than
an undone one. So the ordinary case of "the shop traded offline this morning"
has already moved stock by the time anyone counts, and needs no guard at all.

Two slices on `/sales/offline` have **not** reached the books
(`offlineExceptions.ts:17-25`):

- **Quarantined** — not posted, because posting would have written into a locked
  VAT period.
- **Stuck** — claimed but never posted; a till still retrying, or a payload
  nothing will accept.

Both mean goods have physically left the building while `stock_on_hand` still
counts them. A variance posted against that writes off stock that was sold, and
double-counts it when the sale finally posts.

So `postStockTake` refuses on **quarantined or stuck sales only** — not on the
exceptions list, which is on the books and merely awaiting a judgement call. The
message names the count and links to `/sales/offline`. Scoping it this tightly
matters: guarding on "any offline activity" would refuse most Monday mornings in
a shop with flaky internet, and a guard that fires constantly is one people learn
to work around.

**Ends with:** freeze, recount, and a post path that cannot be tricked by an
offline till.

---

### Phase 5 — Serial-tracked products  ✅ built

Invariant (S1), stated at `sql/site/027_serial_locations.sql:17`:
`count(serials WHERE status='in_stock') = products.stock_on_hand`.

A quantity-only count breaks it. If a serial product counts 9 against a believed
10, posting `−1` leaves ten serial rows claiming `in_stock` against a pile of
nine, which is precisely the drift the invariant exists to catch. `postTransfer`
already refuses this class of thing outright (`stockTransfers.ts:286`).

So a serial line **counts serial numbers, not a quantity**. The grid renders a
scan list for those lines; `counted_qty` is derived as the length of that list.
At post:

- Scanned and `in_stock` → present, no change.
- Believed `in_stock` but not scanned → **missing.** Status moves to
  `written_off`, a `serial_movements` row is written, quantity moves by −1.
- Scanned but not on file → **found.** A new `product_serials` row at the
  sheet's location, `in_stock`, valued at `average_cost`, quantity +1.
- Scanned but marked `sold` → the count is right and the sale record is wrong.
  This is a data problem a count cannot fix, so it is reported on the sheet and
  refused at post rather than silently resurrected.

**Built as `countSerialsTx` in `serials.ts`** — beside its siblings rather than
in `stockTakes.ts`, because it is a serial operation that a count happens to
call. It takes the caller's transaction, so a refusal rolls back the movements
with it.

One correction to what this plan assumed: the column holds serial **strings, not
ids**. A counter holds a scanner pointed at a label, and a unit that turns up
which the system has never heard of has no id to record — "not on file" is a
legitimate outcome of a count, not a lookup failure. Resolving each scanned
string to a row (or deciding there isn't one) is `countSerialsTx`'s job at post
time. The column is still `stock_take_lines.serial_ids` JSON; only its contents
changed.

The grid gives each serial line its own scan box and a removable chip per unit,
and its quantity is **shown, never typed** — derived from the scanned list, so
the two can never disagree. The top-level scan box deliberately does *not* guess
that an unmatched code is a serial number: with several serial lines on a sheet
that would attach a unit to whichever product happened to be the only candidate.

**Ends with:** a serial product can be counted, and `reconcileSerials()` stays
clean afterwards.

---

### Phase 6 — Blocking counts and multi-location  ❌ dropped, deliberately

**Blocking cannot be built honestly, so it was removed** — `092` drops
`is_blocking` and `blocking_until`, and `081` no longer creates them.

The plan assumed `availableToSell()` gates the sell path. It does not. Reading
the actual code:

- `canSellNow()` (`stockMovements.ts:138`) **always returns ok** — every product
  type sells now.
- `salesPosting.ts` never refuses a line on quantity. Stock is allowed to go
  negative on purpose: a till that refuses to sell what is already in the
  customer's hand loses the revenue without preventing anything.
- An offline till sells from **its own catalogue in browser storage** and
  decrements it locally. `decrementStock()` in `posOffline/catalog.ts:407` states
  the policy outright, and no server flag is consulted.
- `availableToSell()` is read by exactly one screen — a sales order — not by the
  till.

So a blocking flag would refuse an online sale and be invisible to an offline
one: the same shop, product and moment, with a different answer depending on
whether the network happened to be up. A control that appears to guarantee
something it cannot guarantee is worse than no control, because somebody will
plan a weekend stock take around it.

The columns are dropped rather than left unused — a column named `is_blocking`
is a feature the next person wires up without finding this reasoning. What makes
counting a trading shop safe is decision 1, not a freeze: the variance posted is
counted-minus-*current*, so anything sold mid-count is accounted for rather than
counted as missing.

**Multi-location** stays deliberately one-sheet-one-location. A sheet spanning
rooms cannot express "counted in the stockroom, not yet in the shop," and the
variance would be unattributable. Counting a whole business is *n* sheets, and
the list screen groups them.

**Multi-location** stays as planned and needs no work: a sheet is already one
location, and counting a whole business is *n* sheets that the list groups.

**Ends with:** an annual stock take is possible — by counting section by section
while the shop trades, which is what the two-figure design was for all along.

---

### Phase 7 — Reports and proof  ✅ built

- **Variance report** per sheet: qty and value, sorted by absolute value
  descending, exportable. The list of shrinkage by product is the output a
  business actually acts on.
- **Shrinkage by product** and **shrinkage by department** — two report-builder
  templates filtered to `source = 'stock_take'`, sorted by value ascending so
  the worst write-off is the first row. Filtering by source rather than by
  `movement_type='adjustment'` is the point: the existing "Stock adjustments"
  template also catches the adjustments a document VOID writes, and those are
  corrections to paperwork rather than stock that walked. Mixing them makes a
  shrinkage figure impossible to act on.

  Building these surfaced a gap: `PRODUCT_DEPT_JOIN` and `PRODUCT_BRAND_JOIN`
  were declared on three sources with **no field exposing them**, so the join
  existed and was unreachable. `productDepartment` and `productBrand` now do,
  which is what lets a movement be grouped by aisle at all.
- **`reconcileStockTakes()`** on `/setup/reconciliation` alongside the existing
  reports: every posted sheet's line variances must equal the sum of the
  movements it produced. Reports, never repairs — the same stance as
  `reconcileStock()` (`stockMovements.ts:313`).
- **Coverage** — when each product was last counted, from `last_adjust_date`
  plus the sheet history. "Not counted in 14 months" is the report that drives
  the next count.

---

## Testing

New: `scripts/test-stock-takes.ts`, registered in `package.json` as
`test:stock-takes` and appended to the `test` chain.

The two established hygiene patterns both apply. `sweepStrays()` runs at the
**start** of `main()`, not only at the end, so a crashed prior run does not
poison the next — deleting lines → sheets → movements → `product_location_stock`
→ products, matched on a stamped code pattern. And the sequence is **baselined,
not reset**: `verifySequence(SITE, 'stock_take')` before and after, because the
tests share a live dev database and a real doc-type row must never be deleted.

Note that `verifySequence` decides where to look via `PURCHASE_TYPES`
(`sequences.ts:541`), which knows only about `purchase_documents` and
`sales_documents`. A `stock_take` living in its own table will be reported as
every number missing unless that function is taught about it — worth doing in
phase 2 rather than discovering it in phase 7.

Cases worth writing, roughly in the order they catch real bugs:

1. Snapshot excludes variant parents, includes children, includes zero piles.
2. Zero-variance lines write **no** movement row.
3. `counted − current`, not `counted − snapshot`: sell during the count and
   assert the pile equals the count afterwards.
4. `reconcileStock()` clean after posting.
5. Topup and set produce the same pile from different inputs.
6. Cancel-after-post restores the pile exactly and leaves the movements in place.
7. Post refuses on a locked VAT period.
8. Post refuses with pending offline sales.
9. GL: net write-off produces a balanced journal; an unmapped
   `stock_adjustment` account leaves the stock movements standing.
10. Serials: missing, found, and already-sold.
11. Two concurrent sheets on one product do not both post against a stale pile.

Then the standard gate: `node --env-file=.env --env-file=.env.local
scripts/pre-publish.mjs`, or the `pre-publish` skill.

---

## What this plan deliberately does not do

- **No batch/lot/expiry.** No `batch`, `lot_number` or `expiry_date` column
  exists anywhere in the schema. For grocery or pharma this is a genuine gap,
  but it is a product-model change that reaches purchasing, sales and serials —
  a separate plan, not a rider on this one.
- **No mobile counting app.** The grid is built to work on a tablet browser with
  a scanner. A native offline counting client is its own project, and
  `posOffline/types.ts` carries no stock-document types today — transfers and
  purchasing set the precedent that back-office documents stay online.
- **No cost restatement.** Decision 4. A count states quantity.
- **No cycle-count scheduler.** Phase 7's coverage report tells a user what to
  count next; automating the rota is worth doing only once the module has been
  used enough to know what the rota should be.
