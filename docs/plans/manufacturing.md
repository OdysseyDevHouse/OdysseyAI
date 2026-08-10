# Manufacturing — turning a recipe into stock you can count

> **Built.** All six phases shipped. The migration is
> `sql/site/083_manufacturing.sql` (080–082 were taken by parallel branches
> between writing this and building it). `npm run test:manufacturing` covers it,
> and the notes below record what changed against the original plan.

## Where this starts

The recipe half of this is already built and correct. What is missing is the
verb: nothing in the system ever **makes** anything.

`sql/site/020_recipes_refers.sql` defines `product_recipes` — parent, component,
`qty` per ONE of the parent, `wastage_pct` on top. `productComposition.ts`
resolves it recursively with a depth cap, merges repeated components, and
already exports the two functions a build needs:

- `compositionCost()` (`productComposition.ts:252`) — what one costs to make.
- `buildableQty()` (`productComposition.ts:273`) — how many the binding
  ingredient allows.

**Neither is called from anywhere in `src/`.** A grep across the application
returns only `scripts/test-composition.ts`. They were written for this feature
and have been waiting for it.

The slot is pre-cut in the same way the stock-take slot was:

- `src/lib/nav.ts:123` — a **Manufacturing** entry pointing at `/manufacturing`,
  gated on `products.edit`, deliberately **without** `built: true` so it renders
  greyed. `src/app/(app)/manufacturing/` does not exist.
- `products.average_cost` has exactly one writer today, and
  `purchasePosting.ts` says so in its header: *"the ONLY thing in the system that
  writes products.average_cost"*. Manufacturing must become the second, and that
  is a decision, not an accident — see decision 3.
- GL account **5100 "Stock adjustments"** is seeded (`045_general_ledger.sql:331`)
  with **no `mapping_key`**, so `resolveAccount()` cannot reach it. Any
  stock-value movement outside a GRV currently has nowhere to post.

### What a recipe product does today, and why manufacturing is not it

Selling a recipe product **explodes it at the till**: `salesPosting.ts:255-266`
resolves the components before the transaction opens, then
`salesPosting.ts:321-347` writes one `sale` movement per component and
`continue`s — **no movement for the parent**. `stockDirectionFor('recipe')`
returns `0` (`stockMovements.ts:89`) because a burger has no pile.

That is right for a burger. It is wrong for a loaf of bread, a bottled sauce, or
a pre-packed hamper: those are made on Monday, counted on Tuesday, and sold on
Wednesday. You cannot answer *"how many finished loaves do I have"* in a model
where the loaf never exists as stock.

So the two models must coexist, and which one applies is a property of the
product — decision 1.

### A bug this plan fixes on the way past

`salesPosting.ts:602` computes cost of sales as
`line.qty * line.unitCostExcl`. For a recipe line that `unitCostExcl` comes from
`products.average_cost`, which for a recipe product is `0.0000` — nothing was
ever purchased called "burger". The **component movements carry real cost**
(`salesPosting.ts:335`), so `stock_control` is credited correctly, but
`cost_of_sales` is debited **zero**. Every recipe sale posts at 100% GP.

`compositionCost()` exists precisely to close this and is not wired in.
Phase 5 wires it.

## What already exists, and must be reused

The cheapest version of this work writes almost no new arithmetic.

| Need | Already in the repo |
|---|---|
| Resolve a recipe to real products and quantities | `resolveComponents()` — `productComposition.ts:141` |
| Cost of one made unit | `compositionCost()` — `productComposition.ts:252` |
| How many can be made | `buildableQty()` — `productComposition.ts:273` |
| Wastage, nesting, cycle cap, duplicate merge | all inside `resolveComponents` |
| The only legal way to change stock | `recordMovement()` — `stockMovements.ts:194` |
| Blending a new cost into the average | `weightedAverageCost()` — `documentMath.ts:250` |
| Spreading overhead across lines pro-rata | `apportionDiscount()` — `documentMath.ts:161` |
| Document numbering, transaction-scoped | `nextDocumentNumber()` — `sequences.ts:145` |
| Period locking | `isPeriodLocked()` — `settings.ts` |
| Per-location piles | `product_location_stock`, via `recordMovement` |
| Main location inside a transaction | `mainLocationIdTx()` — `stockLocations.ts:138` |
| Proof the figures add up | `reconcileStock()` — `stockMovements.ts:328` |
| GL mirror plumbing, fail-soft | `attempt()` / `mapped()` / `postTx()` — `glPosting.ts:41-73` |
| The ingredient editor, already built | `src/components/RecipePanel.tsx` |
| "What breaks if I delete this" | `usedInRecipes()` — `productComposition.ts:413` |
| Capability | `products.edit` (the nav entry already names it) |

**The module to imitate throughout is `stockTransfers.ts` + `src/app/(app)/transfers/`.**
It is the closest existing thing: a stock-moving document with
draft/posted/cancelled, a pure validator kept separate so the screen refuses the
same things for the same reasons, a `reconcile*()` drift report, and a void that
writes compensating movements rather than deleting history.

Manufacturing is structurally **a transfer between products instead of between
locations** — components out, finished goods in, in one transaction. That
framing is worth holding onto: it makes the invariant obvious.

---

## The four decisions that shape everything else

### 1. Manufactured is a flag on the product, not a new product type

Adding a `manufactured` entry to `ProductTypeId` would be the obvious move and
it is wrong. `product_type` decides **how a sale moves stock**
(`productTypes.ts:5-9`), and the type union is consumed by
`stockDirectionFor()`, `offlineBlockedProduct()`, `canSellNow()`, the POS tile
renderer and the product form's tab map. A ninth type means touching all of
them, and it would make "is this made from a recipe" and "does this carry stock"
two facts that can contradict each other.

Instead: **`products.is_manufactured TINYINT(1) NOT NULL DEFAULT 0`**, only
meaningful on a `recipe` product.

```
is_manufactured = 0   sell a burger  ->  -1 patty, -1 bun, -1 cheese   (today, unchanged)
is_manufactured = 1   build 50 loaves ->  -25kg flour, +50 loaves
                      sell a loaf     ->  -1 loaf
```

`DEFAULT 0` is the load-bearing part: **every recipe product that exists today
keeps behaving exactly as it does today.** Nothing in the field changes until
someone ticks the box.

Two functions learn the flag, and only two:

- `stockDirectionFor()` gains an optional second argument. A manufactured recipe
  returns `-1` like any stocked item. The signature becomes
  `stockDirectionFor(productType, isManufactured = false)`, so every existing
  call site keeps compiling and keeps its current behaviour.
- `salesPosting.ts:261` — the explode branch — skips manufactured recipes, so
  the line falls through to the ordinary `stockDirectionFor` path below it.
  `salesReversal.ts:224` takes the identical change, or a credit note will
  return ingredients that the sale never took.

**The flag is not freely editable.** Flipping it on a product with stock or
movement history changes the meaning of figures already recorded. So:
`is_manufactured` may be changed only while the product has zero
`stock_on_hand` and no `stock_movements` rows, and the form says why when it
refuses. This is enforced in `saveProduct`, not just disabled in the UI.

### 2. A build writes both halves, in one transaction, and never overdraws

Every posted Manufacturing Order writes:

```
per component      'manufacture_out'   -qty x buildQty   at the component average cost
for the product    'manufacture_in'    +buildQty         at the computed made cost
```

Two new `movement_type` ENUM values rather than reusing `adjustment`. The reason
is the one table people actually read to answer *"what happened to this
product"*: a baker looking at flour needs to see **"used in production"**, not
an adjustment indistinguishable from a stock-take correction or a voided GRV.
`stock_movements.movement_type` is already an ENUM with seven values and adding
two is a one-line `ALTER`.

Unlike a transfer, the site total **does** move — value is transformed, not
relocated. Invariants (A), (B) and (C) all still hold because every movement
goes through `recordMovement()`, which is the whole point of that function.

**Refuse to overdraw.** A build locks every component pile `FOR UPDATE` in
`product_id` order (deadlock-free, the same ordering discipline as
`postTransfer` at `stockTransfers.ts:261`) and refuses if any component would go
negative. This is deliberately **stricter than a sale**, which is allowed to go
negative because *"a till that refuses to sell what is in the customer's hand is
worse than a stock figure that needs correcting"* (`stockTransfers.ts`). No such
argument applies here: nobody is standing at a counter, and you genuinely cannot
bake bread with flour you do not have. A build that overdraws is a data-entry
error, and catching it is the feature.

The lock is on the **pile**, not the product total, because a build consumes
from one named location.

### 3. Manufacturing becomes the second writer of `average_cost` — deliberately

Cost of one made unit:

```
  Σ (component qtyPerUnit x component average_cost)     the recipe
+ Σ (overhead lines on the order) / buildQty            labour, packaging, power
= unit cost of the finished item
```

That figure blends into the finished product's `average_cost` through the
**existing** `weightedAverageCost()` (`documentMath.ts:250`) — the same helper
the GRV uses, including its edge cases (a negative or zero existing pile lets
the new cost take over rather than producing nonsense).

This is the one place the plan deliberately breaks an existing rule.
`purchasePosting.ts` declares itself the only writer of `average_cost`, and that
comment must be **updated rather than quietly falsified** — a second writer
that leaves a stale "only writer" comment in the codebase is worse than the
coupling itself.

The justification is that a manufactured item has no purchase price by
definition. Nothing is ever bought called "loaf". If manufacturing does not set
its cost, `average_cost` stays at `0.0000` forever and every loaf sold shows
100% GP — the exact bug identified above, reintroduced by a different route.

Overhead lines are **not stock**. They are `manufacturing_order_costs` rows with
a description, an amount and an optional GL account. They roll into the unit
cost and into the journal, and they move no quantity.

`apportionDiscount()` is reused when an order builds more than one output in a
future phase; for the single-output order of phase 1 the division is plain.

### 4. The GL entry, and what happens when the accounts are not mapped

One journal per posted order, not one per line:

```
DEBIT   stock_control            value of finished goods received
CREDIT  stock_control            value of components consumed
CREDIT  manufacturing_overhead   overhead recovered (only when there are cost lines)
```

Both stock legs hit the same control account, so with no overhead the entry is a
**stock-to-stock reclassification that nets to zero** — which is exactly right:
converting flour into bread changes what the business owns, not how much it is
worth. Posting it anyway (rather than skipping) means the ledger carries a
traceable record of production volume.

Overhead is the only leg that changes the balance sheet total, and it must:
labour spent baking is real value added to inventory, and crediting it here is
what stops it being expensed twice when the bread sells.

`manufacturing_overhead` is a **new mapped account key**. Rather than seeding a
new account, it maps to the existing **5100 "Stock adjustments"**
(`045_general_ledger.sql:331`), which is seeded with no `mapping_key` and is
therefore currently unreachable. Giving it one is a one-row insert and puts an
orphaned account back in service. If the site's chart wants a dedicated
"Manufacturing overhead recovered" account, remapping is a settings change, not
a code change.

Fail-soft, following `mirrorSale` (`glPosting.ts:183`, which **skips** when
unmapped) rather than `mirrorGrv` (`glPosting.ts:247`, which **throws**):
**if the account is unmapped, the stock movements still stand** and the gap
surfaces in `ledgerHealth()`. Production accuracy is never held hostage to a
chart-of-accounts mapping. The whole mirror runs **after** commit, outside the
stock transaction, so a mapping gap cannot roll back a completed build.

---

## The shape of the work

Six phases. Each ends with the tree green and something a user can do, so the
sequence can stop between any two without leaving a half-built screen.

---

### Phase 1 — Schema

New: `sql/site/080_manufacturing.sql`

Highest migration today is `079_offline_returns.sql`. The runner sorts by
filename and never re-reads an applied file, so check for a parallel branch
holding 080 before committing — the repo already carries collisions at 042, 043,
052, 054, 058, 061, 064, 070 and 071.

**`ALTER TABLE products ADD COLUMN is_manufactured TINYINT(1) NOT NULL DEFAULT 0`**
— decision 1. Default 0 so nothing in the field changes.

**`ALTER TABLE stock_movements MODIFY movement_type ENUM(...)`** adding
`'manufacture_in'` and `'manufacture_out'` to the existing seven — decision 2.
This is the one statement in the file that is not `IF NOT EXISTS`-guarded;
`MODIFY` with the full value list is naturally idempotent.

**`manufacturing_orders`**

| Column | Notes |
|---|---|
| `id` | PK |
| `document_number` VARCHAR(32) NULL | UNIQUE; allocated at **post**, so a deleted draft does not burn a number |
| `document_date` DATE | |
| `product_id` INT UNSIGNED | FK `products` RESTRICT — history outlives the product |
| `product_code`, `description` | Snapshotted at capture, as every document line does |
| `qty` DECIMAL(12,3) | How many to build |
| `status` ENUM | `'draft','posted','cancelled'` — `cancelled`, never `void` (see below) |
| `from_location_id` INT UNSIGNED | Where components are consumed. FK RESTRICT |
| `to_location_id` INT UNSIGNED | Where finished goods land. FK RESTRICT. May equal `from` |
| `component_cost` DECIMAL(12,4) | Σ components, written at post |
| `overhead_cost` DECIMAL(12,4) | Σ cost lines, written at post |
| `unit_cost_excl` DECIMAL(12,4) | `(component + overhead) / qty`, written at post |
| `reference` VARCHAR(60) NULL, `note` VARCHAR(400) NULL | |
| `posted_at`, `cancelled_at` DATETIME NULL | |
| `cancel_reason` VARCHAR(200) NULL | |
| `user_id` INT UNSIGNED NULL, `user_name` VARCHAR(120) NOT NULL DEFAULT '' | Snapshotted, no FK |
| `created_at`, `updated_at` | `ON UPDATE CURRENT_TIMESTAMP` |

**`manufacturing_order_lines`** — the components, **snapshotted at post**, not
read live from the recipe. A recipe edited after a build must not silently
restate what was consumed six weeks ago.

`id`, `order_id` (FK CASCADE), `line_number`, `product_id` (FK RESTRICT),
`product_code`, `description`, `qty_per_unit` DECIMAL(12,4),
`qty_consumed` DECIMAL(12,3), `unit_cost_excl` DECIMAL(12,4),
`line_cost_excl` DECIMAL(12,4), `movement_id` BIGINT NULL, `created_at`.
`UNIQUE (order_id, product_id)` — `resolveComponents` already merges duplicates,
so two rows for one component is always a bug.

**`manufacturing_order_costs`** — overhead. `id`, `order_id` (FK CASCADE),
`line_number`, `description` VARCHAR(190), `amount_excl` DECIMAL(12,4),
`account_id` INT UNSIGNED NULL (FK `gl_accounts` RESTRICT), `created_at`.

Sequence and mapping seeds:
```sql
INSERT IGNORE INTO document_sequences (doc_type, prefix, next_number, padding, reset_period)
VALUES ('manufacturing_order', 'MO', 1, 6, 'none');
```
plus a `gl_mappings` row giving key `manufacturing_overhead` the existing
account 5100 — decision 4.

Migration file rules this repo enforces the hard way: `CREATE TABLE IF NOT
EXISTS` throughout (DDL auto-commits; every statement must be re-runnable by
hand), `INSERT IGNORE` for seeds so a re-run cannot reset a live counter, named
constraints and indexes, explicit `ON DELETE RESTRICT`/`CASCADE` with a comment
saying why, `ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
**no `site_id` column** (sites are separate databases), and **no apostrophes
anywhere in a comment** — the runner sends the file as one `multipleStatements`
batch and MariaDB reads a lone `'` in a `--` comment as opening a string
literal, swallowing the rest of the file.

Vocabulary: `026_stock_transfers.sql` shipped `void`/`void_reason` and had to be
renamed by `029_rename_void_columns.sql`. Use `cancelled`/`cancel_reason` on day
one.

**Ends with:** `node --env-file=.env scripts/site-migrate.mjs <siteId>` applies
cleanly for **every active site**, `SHOW COLUMNS` confirms the shape. Nothing
visible yet.

---

### Phase 2 — The domain layer

New: `src/lib/site/manufacturing.ts`, `'server-only'`, shaped on
`stockTransfers.ts`.

```
listManufacturingOrders(siteId, filter)
getManufacturingOrder(siteId, id)
previewBuild(siteId, productId, qty, fromLocationId)   — what it needs, what is short
saveManufacturingOrder(siteId, actor, input)           — draft
postManufacturingOrder(siteId, actor, id)              — the whole point; below
cancelManufacturingOrder(siteId, actor, id, reason)    — phase 4
validateManufacturingOrder(input): string | null       — pure, so the screen refuses first
reconcileManufacturing(siteId)                         — drift report, per stockTransfers.ts:511
```

`previewBuild` is the screen's live feedback and the validator's data source. It
calls `resolveComponents()` unchanged, multiplies each `qtyPerUnit` by the build
quantity, and joins `product_location_stock` for `fromLocationId` — `LEFT JOIN`,
so a component with no pile row shows as zero short rather than vanishing.

**`postManufacturingOrder` — the ordering matters:**

1. `validateManufacturingOrder` — pure refusals first, no transaction.
2. `resolveComponents()` **before** the transaction opens, so a half-built recipe
   is refused while nothing has moved. This is exactly what `salesPosting.ts:255`
   does and for exactly the same reason.
3. Refuse if the product is not `recipe` + `is_manufactured`.
4. `isPeriodLocked(siteId, docDate)` — refuse a locked VAT period.
5. Open `siteTransaction`.
6. Lock every component pile `FOR UPDATE` in `product_id` order. Refuse the
   whole build if any would go negative — decision 2.
7. `recordMovement(tx, actor, { movementType: 'manufacture_out', qtyChange: -qty,
   locationId: fromLocationId, source: 'manufacture', sourceDocId, ... })` per
   component. Store `movement_id` on the line.
8. Compute the made unit cost — decision 3.
9. `recordMovement(... 'manufacture_in', +qty, locationId: toLocationId,
   unitCostExcl: madeUnitCost)` for the finished product.
10. Read the finished product's pre-movement position `FOR UPDATE`, blend with
    `weightedAverageCost()`, `UPDATE products SET average_cost = ?, last_cost = ?`.
11. `nextDocumentNumber(tx, 'manufacturing_order')` — **last write before
    commit.** It takes an exclusive row lock held until COMMIT, so allocating it
    early serialises every other posting behind this build. This follows the GRV
    (`purchasePosting.ts`), not the transfer, which claims it early.
12. Stamp `status='posted'`, `posted_at`, and the denormalised cost totals.
13. Commit.
14. **After** commit, `mirrorManufacture()` — fail-soft, outside the transaction.

New in `glPosting.ts`: `mirrorManufacture(siteId, actor, input)`, following
`mirrorSale`'s fail-soft pattern — `mapped(siteId, 'manufacturing_overhead')`
returning null skips the overhead leg rather than throwing.

**Ends with:** `scripts/test-manufacturing.ts` posting a build against seeded
products and proving `reconcileStock()` is clean afterwards. No UI.

---

### Phase 3 — The screens

Follows the transfers layout exactly. Server `page.tsx` guarded by
`requireCapability('products.edit')`, client `*Table.tsx` owning the
`Column<T>[]` array, `actions.ts` using `actorFor('products.edit')` for
mutations and `actorForOrThrow('products.view')` for lookups.

```
src/app/(app)/manufacturing/
  page.tsx                     list — StatStrip (open orders, built this month, value produced)
  ManufacturingTable.tsx       client, columns + row-click nav
  actions.ts                   'use server'
  new/page.tsx  NewBuildScreen.tsx    pick product -> qty -> live shortfall panel
  [id]/page.tsx                       detail, status-driven Callout
  [id]/BuildLinesTable.tsx            client
  [id]/PostBuildButton.tsx            modal showing the cost breakdown before commit
  [id]/CancelBuildButton.tsx          reason in a modal, not a bare confirm
```

**The capture screen is what decides whether this gets used.** The sequence is:
choose the manufactured product, type a quantity, and the ingredient panel
answers three questions at once — what it will consume, whether there is enough,
and what the finished item will cost. `buildableQty()` supplies the "you can
make at most N" line; components short of requirement carry a `danger` Badge, as
`RecipePanel.tsx:125-129` already does client-side.

The **Build maximum** button — set the quantity to `buildableQty()` — is worth
building now. "Make as much bread as the flour allows" is the actual instruction
in a bakery, and making someone compute it by hand is how the module gets
bypassed.

The `DataTable` client-wrapper rule is a hard one here: a `Column` carries `cell`
and `sortValue`, which are functions and cannot cross the server/client
boundary. Defining them on the page fails the render, and the failure **hides
until there is at least one row** because an empty list early-returns an
`EmptyState`. The page maps to a plain-data row type exported by the table.

Before writing any of it, invoke the `odyssey-ui` and `odyssey-craft` skills as
`AGENTS.md` requires: import only from `@/components/ui`, tokens only
(`text-danger`, `bg-success-soft`, never a raw colour), icons from
`@/components/ui/icons`.

Wiring: `src/lib/nav.ts:123` gets `built: true`; a `LEAF_LABELS` entry so
breadcrumbs read `New build` / `Build`; and `scripts/smoke-routes.mjs` `DYNAMIC`
gets `'/manufacturing/[id]': 'SELECT id FROM manufacturing_orders ORDER BY id DESC LIMIT 1'`.

**Ends with:** a user can create, post and view a build.

---

### Phase 4 — Unbuild, and the product-form flag

**Unbuild** is `cancelManufacturingOrder` on a posted order: exact compensating
movements at the **snapshotted** cost — components back in, finished goods out —
plus a reversing journal. It never deletes movement rows, matching
`voidTransfer` (`stockTransfers.ts:396`).

It refuses when the finished goods are no longer there to take back. Unbuilding
50 loaves after 30 have sold would drive the pile to -30 and silently reverse a
sale's worth of stock. The refusal names the number: *"20 of 50 remain — 30 have
already sold."*

Like the GRV void (`purchasePosting.ts:428`), an unbuild **does not unwind
`average_cost`**. Reversing a weighted blend needs the position at the time, and
later movements have already moved past it. That rule is not weakened here.

**The product form** gains the `is_manufactured` toggle in the existing recipe
tab (`ProductForm.tsx:540`), visible only for `product_type = 'recipe'`, with
the guard from decision 1 enforced in `saveProduct` and explained in the UI:
*"This cannot be changed once the product has stock or movement history."*

The copy on the toggle has to carry the whole distinction, because it is the one
thing a user must understand:

> **Made in batches** — build this item ahead of time and carry stock of it.
> Off: the ingredients come off the shelf at the moment of sale.

**Ends with:** the flag is settable and a build is reversible.

---

### Phase 5 — Wiring the cost that was already computed

The bug from the opening section, fixed in three places.

1. **`salesPosting.ts:602`** — for a non-manufactured recipe line, use
   `compositionCost()` instead of `line.unitCostExcl`. Resolved in the same
   pre-transaction pass that already resolves components
   (`salesPosting.ts:255-266`), so it costs no extra queries. `salesReversal.ts`
   takes the matching change.
2. **`RecipePanel.tsx`** — the footer already shows "Cost to make one" and "Can
   be made from stock", computed client-side. Point them at the server figures
   so the recipe screen and the build screen cannot disagree.
3. **The stale comments.** `stockMovements.ts:84-87` still says *"there is no
   recipe table yet"* and that `serial` returns 0 — both untrue since 020.
   `canSellNow()` (`stockMovements.ts:115`) is a permanent `{ ok: true }` stub.
   Correct them while the reasoning is in hand.

A manufactured recipe needs none of this: it has a real `average_cost` written
by the build, so the ordinary sales path already costs it correctly. That is the
strongest argument that decision 3 is right.

**Ends with:** recipe sales stop reporting 100% GP.

---

### Phase 6 — Reports and proof

- **Production history** per product: what was built, when, at what cost.
- **Cost drift** — the made cost of each order against the current
  `compositionCost()`. Rising ingredient prices are invisible until someone puts
  the two figures side by side, and this is the report a manager acts on.
- **Ingredient usage** — a report-builder template over
  `stock_movements WHERE movement_type = 'manufacture_out'`. `templates.ts:490`
  already has a movement-filtering template to copy.
- **`reconcileManufacturing()`** on `/setup/reconciliation` alongside the
  existing reports: every posted order's line quantities must equal the sum of
  the movements it produced, and `component_cost + overhead_cost` must equal
  `unit_cost_excl * qty`. Reports, never repairs — the same stance as
  `reconcileStock()` (`stockMovements.ts:328`).

---

## Testing

New: `scripts/test-manufacturing.ts`, registered in `package.json` as
`test:manufacturing` and appended to the aggregate `test` chain.

Both established hygiene patterns apply. `sweepStrays()` runs at the **start**
of `main()`, not only at the end, so a crashed prior run does not poison the
next — deleting cost lines → order lines → orders → movements →
`product_location_stock` → `product_recipes` → products, matched on a stamped
code pattern (`test-composition.ts:35` is the model). And the sequence is
**baselined, not reset**: these tests share a live dev database and a real
doc-type row must never be deleted.

`verifySequence` (`sequences.ts:541`) decides where to look via
`PURCHASE_TYPES`, which knows only `purchase_documents` and `sales_documents`. A
`manufacturing_order` in its own table reports as every number missing unless
that function is taught about it — worth doing in phase 2 rather than
discovering it in phase 6.

Cases worth writing, roughly in the order they catch real bugs:

1. A build consumes components and receives finished goods; `reconcileStock()`
   is clean afterwards (baseline-relative, not absolute).
2. Wastage is honoured — 10% on 1kg consumes 1.100 per unit built.
3. A nested recipe (a component that is itself manufactured) resolves through.
4. `average_cost` blends correctly, including a build onto a zero pile and onto
   a negative one.
5. Overhead lines raise the unit cost and appear in the journal.
6. A build that would overdraw a component is **refused**, and nothing moved.
7. Selling a manufactured item deducts the **item**, not its ingredients.
8. Selling a non-manufactured recipe still deducts ingredients — the regression
   guard for decision 1.
9. Post refuses on a locked VAT period.
10. Unbuild restores both sides exactly and leaves the movements in place.
11. Unbuild refuses once the finished goods have sold.
12. GL: a no-overhead build nets to zero; an unmapped `manufacturing_overhead`
    leaves the stock movements standing.
13. `is_manufactured` cannot be flipped on a product with movement history.
14. Two concurrent builds on one component cannot both post against a stale pile.

Global-invariant tests run **solo** — a `reconcile*()` failure is usually
another suite's litter, not the ledger.

Then the standard gate: `node --env-file=.env --env-file=.env.local
scripts/pre-publish.mjs`, or the `pre-publish` skill.

## Verification, end to end

1. `node --env-file=.env scripts/site-migrate.mjs <siteId>` for every active
   site; confirm with `SHOW COLUMNS FROM manufacturing_orders` and
   `SHOW COLUMNS FROM products LIKE 'is_manufactured'`. Editing an
   already-applied `.sql` does nothing — the runner records by filename.
2. `npm run test:manufacturing`, then `npm run test:composition` and
   `npm run test:posting` to prove the sale path is unbroken.
3. In the browser (screens are auth-gated; drive Chrome over CDP on :4100):
   create a recipe product, tick **Made in batches**, give it ingredients with
   stock, build 10 from `/manufacturing/new`, and check the product record now
   shows a real `stock_on_hand` and a non-zero `average_cost`.
4. Sell one at the till and confirm the movement history shows the **finished
   item** leaving, not the ingredients.
5. Unbuild the order and confirm both piles return to where they started.
6. `/setup/reconciliation` — `reconcileStock()` and `reconcileManufacturing()`
   both clean.

## What changed while building it

Five things the plan did not foresee, each worth recording because each is the
kind of thing the next module will hit too.

1. **The migration is 083, not 080.** Parallel branches took 080, 081 and 082
   between the plan being written and the work starting. The runner sorts by
   filename and records by name, so the number only has to be unique and later
   than what it depends on.

2. **`INSERT IGNORE` does not protect the GL mapping.** `uq_mapping` is
   `(mapping_key, ref_id)` and MySQL treats NULLs as **distinct** in a unique
   index, so a re-run would have inserted a second default row. The seed uses a
   `NOT EXISTS` guard instead. `046_fixed_assets.sql` has the same latent
   problem with `asset_disposal`.

3. **`explodingProducts()` is one shared definition, not two flags.** Sales
   posting, the void path and the credit note all need the same answer to "does
   this product explode into components". Three copies of
   `productType === 'recipe' && !isManufactured` would eventually disagree, and
   the failure mode — a credit note returning ingredients a sale never took — is
   silent. It lives in `productComposition.ts` beside `resolveComponents`.

4. **The void path never reversed recipe components, and still does not.**
   `voidDocument` only ever wrote a movement when `stockDirectionFor` was
   non-zero, which for an exploding recipe is 0, so voiding a burger sale left
   the patty written off. That is a pre-existing gap, deliberately left alone —
   it is a bug in the void path rather than in manufacturing, and fixing it
   inside this work would have hidden it. **A manufactured recipe IS now
   reversed correctly**, because it has a real pile.

5. **`verifySequence` needed the new doc type, exactly as predicted** —
   `OWN_TABLE_TYPES` in `sequences.ts:551`. Without it every MO number ever
   issued reports as missing. The test asserts it **baseline-relative**: the
   suite sweeps its own orders while the sequence keeps counting, so the numbers
   it leaves behind are expected and only a *new* gap is a failure.

## What this plan deliberately does not do

- **No units of measure.** There is no `uom` table anywhere in `sql/`, and
  recipe quantities are unitless numbers in the component's own stocking unit —
  200g of something stocked in kg is entered as `0.200`. Real UoM conversion
  reaches purchasing, sales, recipes and reporting; it is a separate plan, not a
  rider on this one.
- **No work-in-progress account.** A build is instantaneous: components in,
  finished goods out, one transaction. Modelling a partially-complete batch
  needs a WIP control account and a two-stage document, and no shop or kitchen
  asks for it before it asks for this.
- **No batch/lot/expiry on the output.** `products.expires_in_days` exists
  (`006_product_properties.sql`) but nothing tracks a made-on date per batch. It
  is the natural successor for a bakery and it needs the same schema work that
  serials would need.
- **No co-products or by-products.** One order builds one product. Splitting a
  carcass into cuts is a genuinely different document with a value-apportionment
  problem of its own — `apportionDiscount()` is the helper it would reuse.
- **No offline builds.** `offlineCapability.ts:84` already blocks recipe and
  refer products at the till. Back-office documents stay online, as purchasing
  and transfers both do.
- **No production scheduling or routing.** Phase 6's cost-drift report tells a
  user what is worth building; a works-order calendar with capacity is a
  different product.
