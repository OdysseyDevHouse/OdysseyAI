# Refer codes — two methods, a real chain, and a wizard to build one

> **Planned, not built.** Nothing in this document exists yet except the parts
> explicitly marked *(today)*. The migration number is reserved as
> `sql/site/103_refer_methods.sql`.

## Where this starts

A refer code links a pack to the thing inside it: a six-pack refers to a single,
a case refers to a six-pack. One table holds it *(today)* —
`product_refers(product_id → target_id, factor)`, `sql/site/020_recipes_refers.sql:64-77`,
one row per referring product, `PRIMARY KEY (product_id)`.

What the system does with that link *(today)* is a single behaviour:

- `stockDirectionFor('refer')` returns `0` (`stockMovements.ts:128`) — a refer
  product has no pile of its own.
- Selling one explodes it: `salesPosting.ts:344-360` resolves the chain before
  the transaction opens, `salesPosting.ts:494-517` writes a `sale` movement
  against each resolved component and `continue`s — **no movement for the pack
  itself**.
- `resolveComponents` (`productComposition.ts:154-178`) recurses into the target
  and multiplies `qtyPerUnit` by `factor`, so a case resolves all the way down
  to singles in one pass.

That behaviour has a name in the trade, and it is **subtract pack**: all stock
lives on the single, every pack is a view onto it that deducts `factor` singles.
It is already built and it is already correct.

The other method — **normal refers** — does not exist in any form. Under it each
pack size carries its *own* real stock on hand, and selling a smaller unit
**breaks down** a larger one on demand. Receive ten cases and you have ten cases,
not two hundred and forty singles. Sell one single and the system opens a case
into six-packs, opens a six-pack into singles, and sells one — leaving 9 cases,
3 six-packs, 5 singles.

Both methods must coexist, chosen per link. That is decision 1.

### Two things that are broken today, which this plan fixes on the way past

**Receiving ignores refers entirely.** There is no `resolveComponents` or
`explodingProducts` call anywhere in `purchasePosting.ts`, `purchaseReversal.ts`
or the receive screen. Put a refer product on a GRV line and
`recordMovement` (`purchasePosting.ts:829-838`) happily adds quantity to a
product whose `stockDirectionFor` is `0` — so nothing can ever sell it down. The
stock is stranded permanently, invisible to the till and excluded from stock
takes. Under normal refers that same GRV becomes *correct*; under subtract pack
it must explode. Either way the current silence is a bug.

**Voiding an exploded sale does not reverse the components.**
`salesPosting.ts:1168-1198` admits this in its own comment — the parent returns
`0` from `stockDirectionFor` and the component movements are never mirrored.
Every void of a refer or non-manufactured recipe line leaks stock today. This
plan cannot add a break-down cascade on top of a void path that already fails to
put things back, so it is in scope.

---

## The decisions

### 1. Method lives on the link, not the site or the product

`product_refers` gains `method ENUM('normal','subtract') NOT NULL DEFAULT 'subtract'`.

`'subtract'` is the default because it is what every existing row already does —
the migration must not change the behaviour of a single live product. A site can
then run beer as normal refers and cigarettes as subtract pack, which is real:
the difference is whether the shop physically breaks the outer, and that is a
property of the goods, not of the store.

Not a site setting, because no site is uniform. Not a product column, because a
product is only ever the *source* of one link and the method describes the link.

### 2. The chain is 1:1 upward, each factor relative to its immediate target

single ← six-pack ← case ← pallet. The case's `factor` is **4** (four six-packs),
not 24. The 24 falls out of walking the chain and multiplying, which is exactly
what `resolveComponents` already does at `productComposition.ts:175`.

This keeps the existing `PRIMARY KEY (product_id)` and needs no schema change to
the shape of the link. It also means the break-down cascade has one unambiguous
"next size up" at every level, which a flat star (every pack pointing straight at
the single) would not — with a star, breaking down to fill a single would have to
*choose* between opening a six-pack and opening a case, and any choice is a
guess.

**The wizard still asks for absolute pack sizes** — 1, 6, 12, as in the design —
and derives the relative factors when it writes the chain. What you type does not
change; 12 with a 6 below it stores `factor = 2`.

Depth stays capped at `MAX_DEPTH = 5` (`productComposition.ts:36`).

### 3. Normal refer products are stocked, and the two exclusion lists must learn it

This is the decision with the widest blast radius, and it is unavoidable: a case
that holds ten real cases must be countable and re-orderable, or the stock take
reconciles against a pile it cannot see.

Both lists are `product_type`-only today and must become type-plus-method:

- `stockTakes.ts:59` — `NON_STOCKED_TYPES = ['service','refer','buyout','recipe']`,
  a blacklist splatted into `p.product_type NOT IN (…)` at L363.
- `reorderSuggestions.ts:107` — `STOCKED_TYPES = ['normal','returnable','serial','calcqty']`,
  a whitelist at L134.

They are maintained independently and in opposite polarity, which is a trap: a
refer product must now be excluded when its link is `subtract` and included when
it is `normal`. The clean fix is one shared helper — `stockedReferIds(siteId)`
returning the ids of refer products on `normal` links — and both queries gain an
`OR p.id IN (…)` / `AND p.id NOT IN (…)` against it. One definition, two callers,
so the polarity mismatch cannot drift.

`stockDirectionFor` cannot make this decision. It takes a `ProductTypeId` and no
site, so it cannot read a link. Rather than widen a pure function into an async
one, the sale path decides before calling it — see phase 3.

### 4. The cascade writes paired movements, and cost travels with them

Breaking a case into six-packs is two movements in one transaction:

```
unpack_out   case      −1    at the case's average_cost
unpack_in    six-pack  +4    at average_cost / 4
```

Two new `movement_type` values, which means a migration: `movement_type` is a
MySQL `ENUM` (`sql/site/015_sales_core.sql:373-374`), currently 9 values, last
extended by `sql/site/083_manufacturing.sql:65-68`. That file is the precedent —
`MODIFY` restating the full list, appending at the end so existing ordinals are
untouched.

They are not `adjustment`. The one table people read to answer *"what happened to
this product"* has to distinguish a case being opened from a stock-take
correction, for the same reason `manufacture_in`/`manufacture_out` exist rather
than reusing `adjustment`.

Cost must travel or the six-pack's `average_cost` is garbage. This makes the
cascade the **fifth** writer of `products.average_cost`, after `purchasePosting`,
`manufacturing`, `storeTransfers` and `products`. That is a deliberate decision,
not an accident: a pack that appears on the shelf from nowhere with cost 0 would
poison every GP report that touches it. It blends via the existing
`weightedAverageCost` helper, exactly as receiving does.

The invariant survives: Σ`qty_change` = `stock_on_hand` at every level, because
each break-down is a balanced pair. `reconcileStock` (`stockMovements.ts:351`)
needs no change.

### 5. The cascade is authoritative, inside the transaction, under lock

`salesPosting.ts` takes **no `FOR UPDATE` anywhere** and never reads
`stock_on_hand` — stock is allowed to go negative and the sale never refuses on
quantity. That is a deliberate till behaviour and this plan does not change it.

But a break-down *reads to decide*: "are there singles? no — is there a
six-pack?". A read-then-write with no lock is a race, and two tills selling the
last single would both break the same case. So the cascade takes
`SELECT stock_on_hand … FOR UPDATE` on each level it touches, in the same
transaction as the sale, in a fixed order (smallest pack upward) so two tills
cannot deadlock against each other.

If the whole chain is empty, the single simply goes negative, as it does today.
The cascade never refuses a sale — it opens what it can and gets out of the way.

### 6. Normal-refer products stay online-only at the till

`offlineCapability.ts:84-89` already blocks refer and recipe products from
offline sale ("Made-up and linked items need the network"). That block must
stay for normal refers: the cascade needs live stock at every level to decide
what to break, and an offline till cannot know whether another till already
opened the last case.

Subtract-pack refers could in principle go offline — the explosion is pure
arithmetic on a fixed factor — but that is a separate piece of work and is not in
this plan.

---

## The phases

### Phase 1 — Schema and the link model

`sql/site/103_refer_methods.sql`:

```sql
ALTER TABLE product_refers
  ADD COLUMN IF NOT EXISTS method ENUM('normal','subtract') NOT NULL DEFAULT 'subtract' AFTER factor;

ALTER TABLE stock_movements
  MODIFY movement_type ENUM('sale','sale_return','opening','receipt','adjustment',
                            'transfer_in','transfer_out',
                            'manufacture_in','manufacture_out',
                            'unpack_in','unpack_out') NOT NULL;
```

Then `MOVEMENT_TYPES` (`stockMovements.ts:28-41`) gains the two values, and
`ReferLink` (`productComposition.ts:53-63`) gains `method`. `getRefer`,
`saveRefer` and `clearRefer` carry it through; `saveRefer`'s signature gains a
`method` parameter.

Per `[[odyssey-migrations-are-applied-not-suggested]]`, this runs on every active
site before the phase is called done, and the new column is verified with
`SHOW COLUMNS` — a `.sql` edit to an already-applied file does nothing.

### Phase 2 — The break-down engine

New module `src/lib/site/referBreakdown.ts`, because this does not belong in
`productComposition.ts` (which is pure resolution, no writes) or
`stockMovements.ts` (which is the single gate and must stay type-agnostic).

Two functions:

- `referParentOf(tx, productId)` — walks *up*: who refers to me with method
  `'normal'`? The `ix_refer_target` index already exists for exactly this
  lookup. Returns the parent and its factor, or null at the top of the chain.
- `ensureStock(tx, actor, productId, needed)` — the cascade. Locks the product,
  and while `stock_on_hand < needed` and a parent exists, recursively ensures one
  unit of the parent then writes the `unpack_out`/`unpack_in` pair and blends the
  child's average cost. Returns how many it opened, for the movement note.

Depth-capped like `resolveComponents`, and it never throws for want of stock — it
opens what it can.

### Phase 3 — Sale, void and credit

`salesPosting.ts`, the decision point at the top of the in-transaction loop
(around L494). The line's link method now selects the branch:

- **subtract** — unchanged. `composed.get(line.id)` explodes to components,
  movements against the target, `continue`. Zero behavioural change, which the
  existing `test:composition` suite must prove.
- **normal** — the pack is a real stocked product. Call
  `ensureStock(tx, actor, line.productId, line.qty)` first, then fall through to
  the ordinary `stockDirectionFor` path so the pack itself takes the `sale`
  movement. `stockDirectionFor` must return `-1` for it, which is why the method
  is resolved before the call rather than inside it.

The refer method must therefore reach the posting path. It joins the existing
pre-transaction resolve at L344-360, which already loads exactly these products —
one extra column on a query that is already running, not a new round trip.

`salesReversal.ts:274-286` mirrors it: a credit of a normal-refer pack returns
the pack, not its components. It does **not** re-close a broken case — once
opened, it stays open, which is the physical truth.

`voidDocument` (`salesPosting.ts:1168-1198`) gets its missing component reversal
at the same time, since the void path must handle both methods and currently
handles neither correctly.

### Phase 4 — Purchasing

`purchasePosting.ts`, the receive loop at L820-844, immediately after the
`FOR UPDATE` read at L825 which is already the right hook:

- **normal** — the pack is stocked. `recordMovement` against the pack itself, at
  `landedUnitCost`, and `weightedAverageCost` blends the pack's own average. This
  is the current code path and it becomes correct simply by no longer being
  accidental.
- **subtract** — explode. `resolveComponents` gives the chain factor, so ten
  cases become 240 singles: `qtyChange = qtyArriving × chainFactor`, and
  critically `unitCostExcl = landedUnitCost / chainFactor` or the single's average
  cost is inflated 24×. The document line still records what was ordered and
  received — the pack — because a GRV must print what the supplier delivered.

`purchaseReversal.ts:295` mirrors both. `refreshOrderFulfilment` needs no change:
it counts document lines, not stock.

Ordering (`OrderScreen.tsx`, `reorderSuggestions.ts`) follows from decision 3 —
a normal-refer pack becomes orderable, a subtract-pack refer does not.

### Phase 5 — The wizard

**This is greenfield.** The screenshot is from the old system; nothing matching
it exists here. What exists is `src/components/ReferPanel.tsx` — a strictly 1:1
editor whose own header says so, submitting two hidden fields
(`referTarget`, `referFactor`) consumed at `products/actions.ts:382-392`.

The wizard is a modal launched from the product type panel:

- **Number of refers** (2–5) and **Refer method**, then a row per pack size:
  description, product code, pack size, pack description, excl cost, markup %,
  incl selling.
- Pack descriptions come from the existing `PACK_DESCRIPTIONS`
  (`productProperties.ts:60`).
- The price fill-down in the design — *"type a price on one line and the empty
  lines fill in by pack size, any price already entered is left as-is"* — is
  client-side arithmetic in the modal.
- On Create: one server action, one transaction, `createProduct` per row
  (`products.ts:670+`) then `saveRefer` per adjacent pair, ascending, with the
  chosen method. Relative factors are derived from the absolute pack sizes
  (12 over 6 stores `factor = 2`).

Per `[[odyssey-datatable-columns-are-client-only]]` the modal is a client
component throughout. Per the design system rules it is built from
`@/components/ui` and added to the style guide.

### Phase 6 — Tests and verification

`scripts/test-refers.ts`, following the shape of `test-composition.ts`:

- Subtract pack unchanged — the regression guard for phase 3.
- The beer case: receive 10 cases normal, sell 1 single, assert **9 / 3 / 5**.
- Cascade through two levels in one sale; cascade when the chain is empty
  (single goes negative, nothing breaks).
- `reconcileStock` clean after every case — the paired movements must balance.
- Cost: a case at R240 broken down leaves six-packs at R60 and singles at R10.
- Void and credit of both methods.
- GRV both methods, and the reversal of each.

Per `[[odyssey-tests-must-clean-up-sequences]]` and
`[[odyssey-test-litter-fakes-failures]]`, every fixture is torn down —
a leaked product code will fail an unrelated suite before its first assertion.
Per `[[odyssey-global-invariant-tests-need-solo-runs]]`, the `reconcileStock`
assertions run solo.

---

## What this plan does not do

- **No unit-of-measure system.** `refer.factor` stays the only multi-unit
  concept. `product_suppliers.pack_size` remains supplier-facing order rounding
  and is untouched.
- **No re-packing.** Once a case is opened it stays open. Putting six-packs back
  into a case is a manual stock adjustment, and a screen for it is separate work.
- **No offline normal refers** — decision 6.
- **No change to negative stock at the till.** The sale still never refuses.
