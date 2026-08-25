# Product Screen — Implementation Plan

**Source:** Product Screen Change Notes, 24 August 2026
**Planned:** 24 August 2026
**Scope:** Create/Edit Product screen and related product functionality

This plan is written against the code as it stands today. Where the notes
assumed something that turned out not to be true, that is called out rather
than quietly worked around — three of the eleven items changed shape once the
current state is known, and one of them is a live bug rather than a feature.

---

## What the investigation changed

Four findings reshape the work. They are stated here because they change
sequencing and effort, not just detail.

**1. `last_sold_date` is never written by anything.** The column exists
(`sql/site/001_products.sql:114`), is read by the product screen, the product
list, the report catalog and the dead-stock alert — but no sale, POS or
otherwise, ever writes it. `salesPosting.ts` contains no `UPDATE products` at
all. So "Last sold" is permanently blank on every real store, and the dead-stock
alert silently treats every product as never-sold, falling back to `created_at`.

This is item 7's audit finding, and it is a **bug that exists today**,
independent of the new fields being asked for. It is the single highest-value
thing in these notes.

**2. `last_stock_take_date` already exists and is already maintained.**
Added by `sql/site/109_list_columns.sql:67`, written on every stock take post
(`stockTakes.ts:1240`), already mapped onto the `Product` type and already a
report field. Item 7 asks for it as new work; in fact only the *display* is
missing. That is a one-line change, not a migration.

**3. Item 6 was a discoverability problem, not a missing feature — now fixed.**
Linking a supplier already worked, but the only affordance was a bare search
box, which reads as "filter what is already linked" rather than "attach one".
Replaced with an **Add supplier to product** button and a picker dialog. Done.

**4. Item 2's "extra barcodes" is already a separate panel, not inline.**
`BarcodesPanel.tsx` is its own self-saving card, mounted via `generalExtras`.
The note says "rather than inline as it currently behaves", which does not match
what the code does. It is also **absent from the create screen entirely** — it
needs a saved product id to attach barcodes to.

---

## Item 1 — Quick adjust from the product screen

**Status: DONE.** Built 25 Aug 2026.

An **Adjust** button on each location row of the Inventory section, opening a
dialog scoped to that one product and location. It delegates to
`postNewAdjustment`, so the result is indistinguishable from capturing it on the
full screen.

**Verified by posting a real one**: stock moved −1.000 → 4.000, and it left
`ADJ000007` — status posted, reason "Found on the floor", one line linked to
stock movement 412, and GL batch #106 (`source=stock_adjustment`, 2 balanced
lines) referencing it. `reconcileStock` reports zero drift and
`test-adjustments.ts` still passes. That paperwork is the point: a shortcut that
only moved `stock_on_hand` would look identical on the product screen and have
none of it.

Decisions worth keeping:

- **Serial products are excluded**, both in the offer and in the action.
  `writeOffSerialsTx` returns ok on an empty serial list, so a quantity-only
  adjustment would post happily, move `stock_on_hand`, and leave every serial row
  untouched — breaking invariant (S1), `count(in_stock serials) = stock_on_hand`,
  with nothing on the document to explain it.
- **Gated module-first**, exactly as `/adjustments/new` is: `inventory_advanced`
  then `stock.adjust`. The page resolves it for the button; the action re-checks.
  Without that, the product screen would be a back door around the module.
- The button is `type="button"` — the panel sits inside the product form, and a
  bare button would submit it.
- Refusals (locked period, overdrawn pile, wrong reason direction) stay **in the
  dialog** rather than becoming a toast, so the captured figure is still on
  screen to correct.

**Note for later:** the reversal guard refuses to drive stock negative, so the
verification document could not be cancelled on a product already at −1. It is
left posted on the demo site; drift is zero.

*Original analysis below.*

**Effort:** Small–Medium. **Risk:** Low.

An **Adjust** button beside each location row on the product screen, opening a
modal scoped to that one product + location.

The important part is that this must **not** invent a second adjustment path.
`postNewAdjustment` (`stockAdjustments.ts:974`) already creates a draft and posts
it in one call, and deliberately keeps the draft if posting is refused so a
capture is never lost. It also carries the GL mirror and the reason-code
requirement. A quick adjust that wrote a stock movement directly would bypass
the document trail, the GL and the reversal path — the ledger would stop
reconciling and nobody would find out until a reconcile check failed.

So: a `Modal` from the kit, a quantity and a reason picker, calling a thin
server action that delegates to `postNewAdjustment` with a single line. The
modal is the only new logic.

**Watch:** the reason code is required by `validateAdjustment`; the modal must
offer it, not default it. Posting can legitimately be refused (locked period,
overdrawn pile) — surface that error in the modal rather than closing on it.

**Files:** `ProductForm.tsx` (button + modal), a new action in
`products/actions.ts`, reusing `stockAdjustments.ts` untouched.

---

## Item 2 — Barcodes: action dropdown

**Effort:** Small. **Risk:** Low. **Has an open question.**

Asked for: remove the extra-barcodes section, add a `Menu` beside the barcode
field with **Rename Stock Code** and **Multiple Barcodes** (the latter opening a
modal).

The dropdown and the modal are straightforward — `Menu` and `Modal` are both in
the kit, and `BarcodesPanel` can be moved into a modal largely as-is since it
already self-saves through its own actions.

Two things need deciding first:

- **"Rename Stock Code"** is new behaviour, not a move. The product code is the
  identity products are looked up by; barcodes, supplier codes, sales history and
  offline till catalogues all key off the product. Renaming it needs its own
  think — is it a true rename (update in place, history follows) or an alias?
  This is a bigger question than the one line in the notes suggests, and I would
  rather ask than guess.
- **The create screen has no barcodes panel at all** and cannot have one until
  the product is saved. Decide whether the menu is hidden on create, or shown
  with the barcodes entry disabled and a "save first" hint. The second is
  friendlier and is what I would default to.

**Files:** `ProductForm.tsx:456-463`, `BarcodesPanel.tsx`,
`[id]/page.tsx:284`.

---

## Item 3 — Reporting tab with 11 product reports

**Status: DONE — 10 of 11.** Built 25 Aug 2026.

A **Reporting** tab after Linked stores, holding Price history (moved off the
General tab, which was long) and ten report tiles. Each opens in a dialog over
the product; nothing navigates away, so unsaved edits survive.

As predicted, these are builder specs run by the ordinary engine
(`lib/reportBuilder/productReports.ts`) — no new SQL. The only thing that makes
them product reports is a pinned filter.

**"Product Undos" was NOT built.** `pos_void_events` records
`void_type ENUM('item','line','sale')` and nothing resembling an undo, so it
would have been either a second Voids report under a different name or an empty
table with no explanation. The question below stands.

Decisions worth keeping:

- **The browser sends a report id, never a spec.** The builder's own preview
  action takes a whole spec back from the client and must re-validate it against
  the catalog; here the spec is composed server-side from an id, so a tampered
  request can only name a report that exists or none.
- **The capability is checked twice** — once to decide which tiles to offer, and
  again inside `runBuilderSpec` against the source's own permission. Being
  allowed to edit a product is not being allowed to see sales or purchasing data.
- **`entityId` added to the activity catalog.** `activity_log` keys on
  `(entity, entity_id)`, so the Activity Log pins on that pair — the same pair
  `ix_activity_entity` indexes. Every other report pins on `productCode`, which
  the lines carry denormalised.
- The tab is **hidden while creating** a product: there is no history yet, and
  every spec reads a saved code or id.

**Verified**: all ten specs run and return columns
(`scripts/test-product-reports.ts`), and — the check that matters — adjustments,
GRVs, voids and the activity log each **find** their history when run against a
product that has it. A spec that returned nothing everywhere would have looked
identical to a working one, so an empty result was never accepted as a pass.
`test-report-catalog-fields.ts` still resolves all 1,246 fields across 48
sources against the live schema.

*Original analysis below.*

**Effort:** Medium. **Risk:** Low–Medium. **This is much cheaper than it looks.**

The notes read as eleven new reports. They are not. **The report builder is the
report engine** — every built-in is a builder spec, not hand-written SQL
(`reportBuilder/templates.ts`), and the catalog already carries a filterable
product field on almost every source these reports need:

| Requested report | Source | Product field | Notes |
|---|---|---|---|
| Product Performance | `SALE_LINES` | `productCode` | `performance` template exists |
| Product Movement | `STOCK_MOVEMENTS` | `productCode` | `product-movement` template exists |
| Product Adjustments | `ADJUSTMENT_LINES` | `productCode` | `stock-adjustments` exists |
| Product Voids | `POS_VOIDS` | `productCode` | |
| Product Refunds | `SALE_LINES` | `productCode` | credit notes / returns |
| Product Undos | `POS_VOIDS` | `productCode` | see question below |
| Product Discount | `SALE_LINES` | `productCode` | `discounts-and-voids` exists |
| Product Activity Log | `ACTIVITY` | **missing** | see below |
| Product Stock Take List | `STOCK_TAKE_LINES` | `productCode` | |
| Product Invoice List | `SALE_LINES` | `productCode` | |
| GRV List | `PURCHASE_LINES` | `productCode` | `goods-received` exists |

So the work is: a `Reporting` tab beside Linked stores, a modal that runs a spec
and renders the result, and a small table of eleven spec definitions each
pinned with a product filter. Five already have a template to start from.

**The one real gap:** `ACTIVITY_SOURCE` has no product field — `activity_log`
keys on `(entity, entity_id)`, not a product code. The column exists and is
indexed (`ix_activity_entity`), so this is **adding one `entityId` field to the
catalog**, not a schema change.

**Behavioural requirement:** each report opens in a modal over the product and
must not navigate away. Worth noting the product screen is a form with unsaved
state — navigating away would lose edits, which is presumably exactly why the
notes specify a modal. The modal must not submit or reset the surrounding form.

**Watch:** `Modal`'s body scrolls at 60vh; a report table inside it needs its
own scroll container rather than fighting that.

**Files:** `ProductForm.tsx` (tab + panel), new report-modal component,
`reportBuilder/templates.ts` or a product-scoped spec table,
`reportBuilder/catalog.ts` (the `entityId` field).

---

## Item 4 — Department and Brand: caption size and layout

**Status: DONE.** Built 25 Aug 2026.

`DepartmentPicker` now uses the kit's `Field` instead of its hand-rolled span,
so both captions measure 14px in the same colour — verified in the browser.

The duplicated label string is gone too: it existed in three places (Field
itself, the till-tile panel, and the picker's drifted copy). It is now
`FIELD_LABEL` in `styles.ts`, which all three point at.

**Brand moved INTO the picker's grid** via a `trailing` slot rather than the
caller placing it. How many selects are showing is the picker's own state and
changes as someone drills down, so a caller deciding the layout would be reading
a number it cannot see. On a shallow tree Brand fills the spare column; at three
levels it wraps underneath, which is where it used to live.

*Original analysis below.*

The caption mismatch is real and the cause is exact:

- **Department** hand-rolls its caption in `DepartmentPicker.tsx:82-83` —
  `text-xs font-medium text-muted`
- **Brand** uses the kit's `Field`, whose label is `Field.tsx:83` —
  `text-sm font-medium text-ink-2`

Different size *and* different colour. The fix is to make `DepartmentPicker` use
the kit `Field` rather than restyling Brand down to match — the kit is the
correct answer and the hand-rolled span is the deviation.

Worth fixing at the same time: `TillTilePanel.tsx:41` copies the Field label
string into a local const. That is a third place the same styling is duplicated
and will drift again.

**The layout half** (Brand inline when only Major + Sub 1 are present, beneath
when Sub 2 exists) is conditional on the department tree's depth, which the
picker already knows. Straightforward, but note departments nest arbitrarily
deep in this app — "Major + Sub 1 + Sub 2" is not a schema, it is just the first
three levels. The rule should be "Brand goes inline when the picker is showing
fewer than 3 levels", so a 4-level tree does not fall through it.

**Files:** `DepartmentPicker.tsx`, `ProductForm.tsx:509-535`,
`TillTilePanel.tsx:41`.

---

## Item 5 — Move Product Type into Product Overview

**Status: DONE.** Built 25 Aug 2026.

Now sits directly under the till tile, so the choice that decides whether the
Recipe, Refer and Serials tabs exist at all comes before the things it governs
rather than after them.

**One thing the plan missed:** the panel renders the type's NAME ("Normal
product"), never the words "Product type" — that heading came from the `Card`
being removed, so the straight move left the control unlabelled. It now carries
its own `FIELD_LABEL` caption.

*Original analysis below.*

Product Type is currently dead last in the General tab
(`ProductForm.tsx:609-619`); Product Overview is `:413-506` with `TillTilePanel`
(the colour picker / icon generator) at `:466-477`.

A straight move of `ProductTypePanel` into the Overview card, placed near the
till tile. `ProductTypePanel` is a readout row plus a Drawer, so it is
self-contained and moves cleanly.

**Watch:** the hidden `productType` input must stay inside the form element, and
`SETUP_TAB` (`ProductForm.tsx:72-76`) jumps to the recipe/refer/serials tabs off
the product type — that wiring must survive the move.

---

## Item 6 — Link supplier from the product

**Status: DONE.** Built 24 Aug 2026.

The underlying capability already existed — a supplier could be linked from the
Suppliers tab, and driving it in a browser confirmed the whole flow worked. The
problem was that it did not *look* like it existed: the only affordance was a
bare search box, which reads as "filter the suppliers already linked below"
rather than "attach a new one". The one action the panel exists for appeared to
be missing.

**What changed:** the Combobox is replaced by an **Add supplier to product**
button opening a picker dialog, matching the shape of attaching a customer to a
sale at the till — it opens with suppliers already listed rather than an empty
field, and typing narrows them.

Details worth keeping:

- One action serves both jobs: `searchSuppliersAction` with an empty term
  already returns the first page, so "what is there" and "what matches" are the
  same question asked of the same place. No new server action.
- An already-linked supplier stays visible but disabled, badged *Linked*.
  Filtering it out would look like the record is missing and someone would go
  and create a duplicate.
- Already-linked and on-hold are badged differently — one is a state of this
  product, the other a state of the supplier.
- The empty state distinguishes "nothing matches your search" from "no suppliers
  yet", which point at different fixes.

**The hazard was avoided, not encountered:** `saveProductSuppliers`
(`productSuppliers.ts:96`) deletes every row for the product and re-inserts from
what it is given. The dialog adds to the existing form state and nothing else,
so the whole set is still submitted together — no side-channel write, and no
partial save that could wipe the siblings.

**Still open:** the link is added to the form, not saved on the spot — the user
must still press **Save product**. If someone adds a supplier and navigates away,
it is silently lost. Worth deciding whether this should save immediately.

**Not built:** creating a *brand-new* supplier without leaving the screen. That
was the other reading of this item and is a separate piece of work.

---

## Item 7 — Last-activity dates

**Effort:** Medium. **Risk:** Medium.
**Contains the most valuable finding in these notes.**

Current state, verified:

| Field | Column | Written by | Status |
|---|---|---|---|
| Last edit | `last_edit_date` | `products.ts`, `productFanout.ts` | works |
| Last purchase | `last_purchase_date` | `purchasePosting.ts:1036,1131` | works |
| Last adjusted | `last_adjust_date` | `stockAdjustments.ts:912`, `stockTakes.ts:1267` | works |
| Last sold | `last_sold_date` | **nothing** | **broken** |
| Last stock take | `last_stock_take_date` | `stockTakes.ts:1240` | **column + writer already exist; only the UI is missing** |
| Last transfer | — | — | genuinely absent |

### 7a. Fix `last_sold_date` — **DONE**, 25 Aug 2026

Stamped in `recordMovement` (`stockMovements.ts`) rather than in the posting
paths: that is the one chokepoint every sale already goes through — till,
invoicing and online orders all land there — so no path can move stock for a
sale and forget to say so. It rides the caller's transaction, so a rolled-back
sale takes the date back with it.

`'sale'` only, NOT `'sale_return'`. A return is stock coming back; stamping it
would make a product that has only ever been refunded look freshly sold, which
is the exact line dead stock exists to catch.

Covered by `scripts/test-last-sold-date.ts`: a sale stamps it, a second sale
moves it forward, and a void (which writes the `sale_return`) leaves it alone.
`npm run test:posting` still passes with zero stock and balance drift.

**Worth knowing:** the first version of that test asserted the return case with a
negative invoice line, which the engine refuses outright — so it "passed" by
comparing a date against itself and proved nothing. It now goes through
`voidDocument`, which is what actually writes a `sale_return`.

*Original analysis below.*

Nothing writes it. This is not part of the new-fields work; it is a standing bug
whose blast radius reaches past this screen into the **dead-stock alert**, which
currently cannot distinguish "never sold" from "sold yesterday". Fixing it makes
"Last sold" start working on the product screen, the product list and every
report that exposes the field.

The write belongs where the sale posts stock, alongside the existing
`stock_on_hand` movement, so a sale through any path stamps it once.

**Decide:** whether to backfill from sales history. Without a backfill the field
reads NULL until each product next sells, which will look like the bug is still
there. `seed-stress.mjs:759` already does exactly this backfill for test data,
so the query shape is known.

### 7b. Show `last_stock_take_date` — **DONE**, 25 Aug 2026

Shown beside Last adjusted. The grid moved from `sm:grid-cols-4` to
`sm:grid-cols-2 lg:grid-cols-3` at the same time — at five and six entries a
four-column grid leaves a ragged orphan row, so 7c's transfer date will drop in
without a second re-layout.

*Original analysis below.*

The column and the writer exist. This is adding the tuple to the grid at
`ProductForm.tsx:489-495` and the mapping in `products.ts`. Near-zero work.

Doing this also resolves a real confusion: a stock take currently stamps
`last_adjust_date` too (when variance ≠ 0), so today a count looks like an
adjustment. Showing both separates them.

### 7c. Add `last_transfer_date` — **DONE**, 25 Aug 2026

Migration **236** (not 234 — another session had taken 234 and 235 by the time
this was written). Stamped in `recordMovement` on `transfer_in` or
`transfer_out`, which is the one chokepoint BOTH transfer paths already go
through: location-to-location (`stockTransfers.ts`) and inter-store
(`storeTransfers.ts`). Both directions stamp it — a product only ever received
into a room has moved just as much as one only ever sent out, and stamping the
out leg alone would leave the receiving store reading "never".

The date grid is now six fields in a 3×2 layout, which is why 7b re-laid it out
at the time rather than twice.

**Applied to all 23 active sites, not 2.** The obvious assumption — that this
machine has the two sites the screenshots use — was wrong: `cp2_site_databases`
lists 23 active masters. Missing the other 21 would not have failed quietly
either, because `last_transfer_date` is in the product SELECT, so every product
screen on those sites would have 500'd on the missing column. Verified with
`SHOW COLUMNS` on a sample afterwards.

**Verified by posting a real transfer** (`scripts/test-last-transfer-date.ts`):
`TRF000052`, both legs recorded, the date stamped, zero reconcile drift.

Two things the backfill could not tell me:

- It reported success against **zero rows** — no site on this machine has ever
  posted a transfer, so the backfill query proved nothing about the writer. That
  is why the test posts one.
- The first version of that test seeded stock by writing `stock_on_hand`
  directly, which left Σ movements ≠ stock_on_hand and failed the reconcile
  check **on a row it had created itself**. It reads as a transfer bug and is
  not one; the seed now goes through an `opening` movement.

*Original analysis below.*

Genuinely new: migration `234`, plus a writer in `stockTransfers.ts:284`
(`postTransfer`) and `storeTransfers.ts:734` (inter-store), neither of which
touches `products` today.

**Note:** the grid at `ProductForm.tsx:487-504` is `sm:grid-cols-4` for exactly
four dates. Six needs a re-layout, not just two more entries.

### 7d. The audit

The notes ask to confirm each date updates in practice. The table above is that
audit for the write path. Worth a scratch script that performs one of each event
against a test product and reads the columns back — that is what would catch the
next `last_sold_date`.

**Stale comments to correct while here:** `stockTakes.ts:1264` claims nothing
has ever written `last_adjust_date` (`stockAdjustments.ts:912` does), and both
`stockAdjustments.ts:911` and `stockTakes.ts:1266` cite `last_sold_date` as a
maintained sibling column. Both mislead the next reader.

---

## Suggested sequence

1. ~~**7a — fix `last_sold_date`**~~ — **DONE.**
   Standing bug, widest blast radius, independent of everything else.
2. ~~**4, 5, 7b**~~ — **DONE.** Captions, Product Type move, stock-take date.
   Item 6 also done, out of order, when it came up in conversation.
3. ~~**Item 1**~~ — **DONE.** Quick adjust dialog over the existing `postNewAdjustment`.
4. ~~**Item 3**~~ — **DONE** (10 of 11). Reporting tab; "Product Undos" held pending the question below.
5. ~~**7c**~~ — **DONE.** Migration 236, writers in recordMovement, applied to all
   23 active sites. The date grid is now six fields.
6. **Item 2** — held until the Rename Stock Code question below is answered.

---

## Questions

1. **Rename Stock Code (item 2)** — is this a true rename of the product code in
   place, or an alias? The code is the identity used by barcodes, supplier codes,
   sales history and the offline till catalogue, so the two readings differ a lot
   in cost and risk.
2. ~~**Link Supplier (item 6)**~~ — **answered and built.** The ask was a button
   and a picker dialog rather than a search box. Remaining sub-question: should
   adding a supplier save immediately, instead of waiting for Save product?
3. **`last_sold_date` backfill (item 7a)** — backfill from sales history, or let
   it populate from the next sale onward? Without a backfill it will look
   unfixed for a while.
4. **"Product Undos" (item 3)** — **now the blocking question for the last
   report.** The other ten are built. `pos_void_events` records
   `void_type ENUM('item','line','sale')` and nothing else that resembles an
   undo, so there is no event in this system to point a report at. What did the
   old system record when a cashier "undid" something — and is it different from
   a void?
5. **Barcodes on the create screen (item 2)** — hide the menu entry until the
   product is saved, or show it disabled with a hint? I would default to
   disabled-with-a-hint.
