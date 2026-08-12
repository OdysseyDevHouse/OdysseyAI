# Purchasing — ordering, and a GRV that carries its own arithmetic

## Where this starts

The purchasing module posts receipts correctly and has done since 017. What it
cannot do is *order*. That is not a missing feature at the edges — it is the
front half of the module, and its absence shapes everything else in this plan.

The evidence, gathered before writing any of this:

- `purchase_documents.doc_type` has had `'purchase_order'` since the first
  purchasing migration. `purchase_order_details` exists for order-only facts.
  The `PO` sequence is seeded and padded to six digits.
- `saveOrder()`, `issueOrder()` and `cancelOrder()` in
  `src/lib/site/purchaseDocuments.ts` are complete and correct.
- `saveOrderAction()` in `src/app/(app)/purchasing/actions.ts` wraps them with a
  `purchasing.edit` check.
- **Nothing calls `saveOrderAction`.** A grep across `src/` and `scripts/`
  returns no callers. There is no `/purchasing/new` and no
  `/purchasing/[id]/edit`.

So a draft order cannot come into existence. `PurchaseActions.tsx` renders an
"Issue order" button that no user can ever reach, the "Against an order"
dropdown on the receive screen is permanently empty, and the "On order" tile on
the purchasing list permanently reads R0.00. The list page carries a comment
admitting the old "New order" link pointed at `/purchasing/new`, "which never
existed as a screen."

This plan builds the ordering screen, gives both purchase grids the full column
set with visibility toggles, and adds the three posting-level features —
shipping, bonus quantities, document discount — plus suggested ordering.

## What already exists, and must be reused

Listed because the cheapest version of this work is the one that writes the
least new arithmetic. Every item here is load-bearing.

| Need | Already in the repo |
|---|---|
| Markup, GP, sell-from-markup, sell-from-GP, add/remove VAT | `src/lib/pricing.ts` |
| Cross-computing price inputs, live, in a table | `src/components/PricingPanel.tsx` |
| Pro-rata apportionment, remainder on the largest line | `apportionDiscount()` in `documentMath.ts` |
| Weighted average cost, with the negative-stock edge cases | `weightedAverageCost()` |
| Min / max levels, **per location** | `product_location_stock.min_stock` / `.max_stock` |
| Supplier lead time, minimum order value | `suppliers.lead_time_days`, `.minimum_order` |
| Their code, their pack size, last cost from them | `product_suppliers` |
| Sales history for demand | `stock_movements`, `ix_move_type_date` |
| Device-scoped UI preference | `src/lib/posOffline/useTileSize.ts` |
| Freight-in expense account | `4000 — Cost of sales, freight in` (042) |

`suppliers.lead_time_days` carries this comment, written before purchasing
landed: *"what a reorder suggestion needs once purchasing lands."* Phase 6 is
that reorder suggestion. The schema has been waiting for it.

## The shape of the work

Six phases. Each ends with the tree green and something a user can actually do,
so the sequence can be stopped between any two phases without leaving a
half-built screen behind.

---

### Phase 1 — The line grid, with the full column set

**The decision that makes the rest cheap:** one shared grid component, used by
both the ordering screen and the receive screen, rather than two grids whose
columns drift apart within a month.

New: `src/app/(app)/purchasing/PurchaseLineGrid.tsx`

Columns, every one toggleable except Item and the remove button:

| Column | Source | Editable |
|---|---|---|
| Item (code, description, their code) | line | — |
| Ordered | line | ordering only |
| Received | line | receiving only |
| Bonus qty | line (phase 4) | yes |
| Unit cost excl. | line | yes |
| Unit cost incl. | `addVat(cost, vatRate)` | yes, back-computes |
| Discount % | line | yes |
| Discount value | derived, see the note below | yes |
| Net cost excl. | after discount | — |
| Landed / new cost | `landed_cost_excl` | — |
| Current avg cost | product | — |
| Avg cost after | `weightedAverageCost()` | — |
| Selling price incl. | product | yes |
| Selling price excl. | `removeVat()` | yes |
| Markup % | `markupPercent()` | yes, back-computes |
| GP % | `gpPercent()` | yes, back-computes |
| VAT rate | line | yes |
| Line total excl. / incl. | derived | — |
| Location | line | yes, multi-location only |
| Stock on hand | product | — |

The editable derived columns cross-compute exactly as `PricingPanel` already
does: type a markup, the selling price moves; type a selling price, the markup
moves. That component is the working precedent — same pattern, same helpers from
`src/lib/pricing.ts`, no new maths.

**Discount value needs a schema change.** `purchase_document_lines.discount_pct`
is `DECIMAL(6,3)` — a percentage. Entering "R37.50 off" and storing it as a
percentage means storing 12.497% and rendering R37.49 back. If the value is
authoritative it has to be stored:

```sql
-- 078_purchase_line_discount_value.sql
ALTER TABLE purchase_document_lines
  ADD COLUMN discount_amount DECIMAL(12,4) NOT NULL DEFAULT 0.0000 AFTER discount_pct;
```

Same rule as `lineTotals()` in `documentMath.ts`: when both are present the
absolute amount wins. That precedent already exists on the sales side.

Column visibility persists per device via `localStorage`, following
`useTileSize.ts` — a buyer's chosen layout survives a reload. Per device rather
than per user because it is a screen preference, not a business fact, and the
same reasoning `useTileSize` sets out applies unchanged.

The kit has no column picker. One gets added — `src/components/ui/ColumnPicker.tsx`,
a `Menu` of checkboxes — exported from `index.ts` and shown on
`/setup/style-guide`, per AGENTS.md rule 5.

**Ends with:** the receive screen using the new grid with every column
available. Nothing else changes yet.

---

### Phase 2 — The ordering screen

New: `src/app/(app)/purchasing/new/page.tsx`, `/[id]/edit/page.tsx`, and
`OrderScreen.tsx` sharing the phase-1 grid.

Both pages `requireCapability('purchasing.edit')` — the URL is typeable, and
AGENTS-adjacent practice in this repo is that the page guard and the action
guard are both real boundaries.

Header: supplier, order date, expected date, their order number, reference,
notes. Ordering does not touch stock or the ledger, so this screen is far
simpler than receiving — no serials, no cost preview.

**Superseded — the location column now appears on ordering too.** The original
rule was that only a GRV names a location, on the reasoning that only a GRV
moves anything. That reasoning still holds for the *movement* — `receiveGoods()`
remains the only thing that puts stock in a pile — but it was the wrong rule for
the *intent*. A buyer ordering ten cases for the warehouse and two for the shop
knows the split when they raise the order; making the receiver rebuild it at the
door from a delivery note that never carried it is guesswork.

So `purchase_document_lines.location_id` is written by `saveOrder()` as well,
receiving inherits it per line and may override it, and a line left null still
means "wherever main is when it lands" — resolved at receipt, never pinned at
order time. No schema change: the column has existed since 025.

Save → draft. Issue → `issueOrder()`, which claims the PO number. Both actions
exist and are tested at the library level.

Wiring, all of it currently dead:

- "New order" on the purchasing list, beside "Receive goods"
- Edit on a draft order from `/purchasing/[id]`
- `PurchaseActions.tsx`'s Issue button becomes reachable
- The receive screen's "Against an order" dropdown starts having contents
- The "On order" tile starts showing a real figure

`saveOrder()` needs one extension: it does not currently persist
`supplier_order_no`, though the column exists on `purchase_order_details`. Add
it to `OrderInput` and the upsert.

**Ends with:** a PO can be raised, issued, and received against. The module's
front half exists.

---

### Phase 3 — Shipping with a supplier

Today `charges_excl` is apportioned into `charge_excl` and `landed_cost_excl`,
so landed costing is already right. What is missing is *who was paid*. A freight
company that invoices separately is currently buried inside the goods supplier's
invoice, which means their account is wrong and the freight-in expense is
invisible.

```sql
-- 079_purchase_shipping.sql
CREATE TABLE purchase_document_charges (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  document_id   INT UNSIGNED NOT NULL,
  -- NULL = charged by the goods supplier on the same invoice, which is the
  -- behaviour charges_excl has always had. A supplier here means a SEPARATE
  -- invoice from a freight company, posted to their own account.
  supplier_id   INT UNSIGNED NULL,
  description   VARCHAR(120) NOT NULL,
  amount_excl   DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  vat_rate_pct  DECIMAL(6,3)  NOT NULL DEFAULT 0.000,
  their_invoice_no VARCHAR(60) NULL,
  PRIMARY KEY (id),
  KEY ix_pcharge_document (document_id),
  CONSTRAINT fk_pcharge_doc      FOREIGN KEY (document_id) REFERENCES purchase_documents (id) ON DELETE CASCADE,
  CONSTRAINT fk_pcharge_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers (id)          ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

`charges_excl` stays as the total, so every existing GRV, report and the void
path keep working untouched. The new table explains what the total is made of.

**The posting rule, and it is the important part of this phase.** Every charge
row is apportioned into landed cost regardless of who is being paid — the goods
cost what they cost to get onto the shelf, whoever sent the invoice. But the
credit side splits:

- charge with no supplier → part of the goods supplier's invoice, exactly as now
- charge with a supplier → its **own** `postSupplierTransaction` against that
  supplier, and a GL line to `4000 — freight in` rather than stock control

That means `receiveGoods()` can post more than one creditor transaction. The
ledger postings already happen after commit — a failure there must not
un-receive goods on the shelf — so the loop extends naturally. `mirrorGrv()`
gains a `charges` argument and splits the debit between stock control and
freight-in.

The void path (`voidReceipt`) must reverse **every** creditor posting the
receipt made, not just the goods one. This is the sharpest edge in the phase: a
void that reverses one of two invoices leaves the freight company's account
permanently overstated, silently.

UI: a small charges editor on the receive screen — description, supplier
(optional), amount, VAT, their invoice number. Total flows into the existing
`charges_excl` field, so the summary card needs no change.

---

### Phase 4 — Bonus quantities

"Buy 10, get 1 free." Currently only expressible by faking the unit cost, which
puts a wrong number on the supplier's invoice line.

```sql
-- 080_purchase_bonus_qty.sql
ALTER TABLE purchase_document_lines
  ADD COLUMN qty_bonus DECIMAL(12,3) NOT NULL DEFAULT 0.000 AFTER qty_received;
```

**The rule that must not be got wrong:** bonus units increase the quantity
received but not the invoice value. So:

```
stock movement qty = qty_received + qty_bonus
line value        = qty_received x unit_cost   (bonus contributes nothing)
landed unit cost  = (net + charges) / (qty_received + qty_bonus)
```

Divide by `qty_received` alone and average cost is overstated on every
promotional buy — exactly the silent, compounding costing error the module
header warns about. The grid shows the effective cost per unit beside the bonus
box so the buyer sees a promotion's real effect on margin.

Serial-tracked lines need `qty_received + qty_bonus` serials. The existing
validation counts against `qty_received`; it must count against the total, or a
bonus phone arrives with no serial and the two figures disagree with no way to
tell which is right.

---

### Phase 5 — Document-level discount

A settlement or volume discount on the whole order.

```sql
-- 081_purchase_document_discount.sql
ALTER TABLE purchase_documents
  ADD COLUMN discount_pct   DECIMAL(6,3)  NOT NULL DEFAULT 0.000 AFTER charges_excl,
  ADD COLUMN discount_excl  DECIMAL(12,4) NOT NULL DEFAULT 0.0000 AFTER discount_pct;
```

Largely wiring: `apportionDiscount()` already does this correctly, remainder on
the largest line so a three-line R100 discount comes to exactly R100. It is
already used for charges on this very screen; the discount is the same call with
the opposite sign.

Rule 3 of `documentMath.ts` — apportion onto the lines, never apply to the total
— is why. A discount held only at document level cannot be split by VAT rate, so
a mixed-rate order would have an unallocatable VAT figure.

Order of operations, fixed and tested: **line discount → document discount →
charges → landed cost.** Charges last, because freight is not discounted by the
goods supplier's settlement terms.

---

### Phase 6 — Suggested ordering

The screen that turns purchasing from data capture into a tool. New:
`src/lib/site/reorderSuggestions.ts` and `/purchasing/suggest`.

Four bases, chosen by the buyer:

1. **Below minimum** — `stock_on_hand < min_stock`, order up to `max_stock`.
   The straightforward one, and the levels already exist per location.
2. **Sales velocity** — units sold over a chosen window from `stock_movements`
   (`movement_type = 'sale'`, negated), projected across
   `lead_time_days + cover_days`. `ix_move_type_date` makes this indexed.
3. **Min to max** — everything below max, topped up regardless of minimum.
4. **Manual** — the buyer's own list, for a promotion or a new line.

Every basis subtracts what is **already on order** — outstanding
`qty_ordered - qty_received` on issued POs. Without that the second run of a
suggestion double-orders everything the first run just ordered, which is the
classic way an auto-replenishment feature loses a shop's trust in a week.

Rounded up to `product_suppliers.pack_size`, grouped by preferred supplier,
warning where the order is below `suppliers.minimum_order`. One click creates a
draft PO per supplier via the phase-2 screen.

The suggestion is a proposal, never an automatic order. Every quantity stays
editable, and the reasoning is shown per line — on hand, on order, sold in the
window, suggested — because a buyer who cannot see why will not trust the
number.

---

## Testing

`scripts/test-purchasing.ts` is the model: pure arithmetic first, then fixtures,
then `reconcileStock()` and `reconcileSupplierBalances()`. Extended per phase,
plus a new `scripts/test-purchase-orders.ts`.

The cases that matter, because each is silent when wrong:

- landed cost divides by received **+ bonus**
- a document discount apportions to exactly the amount asked for
- a shipping charge with a supplier credits *that* supplier, not the goods one
- voiding a receipt reverses **every** creditor posting it made
- a suggestion subtracts what is already on order
- discount value and discount percent agree to the cent
- receiving against a PO closes the order line and moves fulfilment status

Global-invariant tests are run solo — `reconcile*()` failures are usually other
tests, not the ledger. Scratch rows get cleaned up, sequences included.

## Migrations

078 through 081, applied with `site-migrate.mjs` for **every** active site
before the work is called done — a migration file that exists but has not run is
not a migration. Verified with `SHOW COLUMNS`, since editing an already-applied
file silently does nothing.

Migration numbering currently collides in this repo (two 064s, two 070s, two
071s). 078+ is clear of the storefront branch's 074-077.

## Built after the six phases

All six phases landed. Four more followed, each because using the module made
the gap obvious:

- **Draft goods receipts.** Receiving was all-or-nothing, and a sixty-line
  delivery is an hour of work standing on one interruption. A draft moves
  nothing and takes no number; finalising reuses its row so its id survives.
- **Invoice-total matching.** Type what their invoice says and the receipt is
  refused if the lines do not tie. The single best guard in the module —
  catches a transposed quantity, a line keyed twice, a case cost keyed as a
  unit cost. Compared against what the GOODS supplier is owed, so a carrier's
  separate invoice does not break the tie.
- **Cost-change warnings.** Per line, against the LAST cost paid rather than
  the average. A warning, never a refusal.
- **Supplier price lists.** Agreed costs with effective dates, so a list can be
  captured before it starts. Ordering reprices on both paths that change the
  answer — adding a product, and changing the supplier — and `priceVariances`
  shows where a receipt disagreed with what was promised.

## What this does not do

- **Multi-currency purchasing.** Real for importers, and a much larger change:
  rate at order, rate at receipt, and the FX difference posted somewhere.
- **Landed-cost apportionment by weight or volume.** By value is right for most
  freight; by weight is better for heavy goods. `product_dimensions` exists, so
  this is reachable later.
- **A price-list screen.** The library, the actions and the ordering hook are
  built and tested; there is no page for maintaining lists by hand yet, and no
  CSV import. `saveSupplierPriceList` takes a whole list and reports its
  failures per line, so an importer is a thin wrapper over what exists.
- **Container / consignment tracking.** A shipment spanning several POs.

Each is a sensible successor. None is needed for the module to be complete.
