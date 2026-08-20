# Block tests — breaking a carcass into cuts, at a cost you can defend

> **Planned, not built.** Research is complete and cited below; nothing in
> `src/` implements this yet. The next free migration number is **195**.

## What a block test is

A butcher buys a side of beef at one rate per kilogram and sells twenty
different things off it at twenty different rates. A **block test** is the
document that records the breakdown: what went in, what came out, what was
lost to bone, fat and drip, and — the point of the exercise — what each cut
actually cost.

"Block test" is South African terminology. Internationally the same document is
a *butcher's yield test*, *cutting test* or *cut-out*.

Two questions are answered by one event, which is why this is one feature and
not two:

- **Costing.** A carcass at R61.50/kg does not make every cut cost R61.50/kg.
  Fillet and shin cannot carry the same cost or the margin report is fiction.
- **Traceability.** The carcass is a lot. Every cut off it descends from that
  lot, and a recall has to be able to say so.

Capturing the breakdown twice — once for cost, once for lot — would be asking
the butcher to key the same weights into two screens.

---

## Where this starts

### What already exists and fits

**`referBreakdown.ts` is the closest structural precedent.** It opens a case
into six-packs: one product out, another in, one transaction, every write
through `recordMovement()`, and the outgoing value blended into the receiving
product's `average_cost` with `weightedAverageCost()`. A block test is that
verb with **many outputs of differing value** instead of one.

**`manufacturing.ts` supplies the document shape** — draft, post, cancel,
overheads, `guardPosting()`, sequence numbering, a reconciler. Its header calls
a build "a transfer between PRODUCTS", which is exactly what this is.

But manufacturing is **many inputs → one output**: `manufacturing_orders` has a
single `product_id` and `qty`. A block test is the inverse and cannot be
expressed as a build. That inversion is the whole job.

**The batch layer already does the traceability half.** `BatchDirective`
accepts an exact `batchId`, and the hook inside `recordMovement()` is total, so
consuming a named carcass lot and receiving cut lots is plumbing that exists.

**`weightedAverageCost()`** (`documentMath.ts:250`) is reusable unchanged, per
output cut — which keeps this module's arithmetic identical to the GRV's.

### What does not exist

- No document with one input line and many output lines.
- No cost-apportionment concept anywhere in the codebase.
- No per-species cut structure or yield expectation.
- `products.average_cost` gains a **sixth** writer. Today:
  `purchasePosting.ts`, `manufacturing.ts`, `products.ts`,
  `referBreakdown.ts`, `storeTransfers.ts`.

---

## The hard decision: how one carcass cost splits across cuts

This determines the schema, so it is settled first.

### The methods actually in use

| Method | Mechanism | Where |
|---|---|---|
| **Value / cost factor per cut** | `cost_i = carcass R/kg × factor_i` | **SA industry standard**; Aptean; SAP equivalence numbers |
| Pre-configured yield % | Stored % per cut per species | Arch Retail |
| Standard cost + variance | Fixed cost, difference to a variance account | Matrix, Emydex |
| By-product credit (NRV) | Parent cost − market value of fat/bone/trim | Classic butcher's yield test |
| Manual entry | Typed per cut | Odyssey GTN |

### Why market-value allocation is wrong here

Allocating strictly by sales value **gives every cut an identical gross
margin** — a computed 75kg hindquarter returns 15.59% GP on fillet, mince and
stewing beef alike. That erases the per-cut margin analysis the butcher is
running the block test to get.

This is precisely why SA practice stores **independent factors** instead.

### The SA factor method

Published by the RPO ([AgriOrbit](https://agriorbit.com/beef-and-sheep-carcass-block-test/)):

```
factor_cut = cut's R/kg (ex-VAT, ex-margin) ÷ carcass R/kg
```

Beef factors run **fillet 2.380 → short rib 0.973**. Verified against the
published example — an A2 lamb side at R98.31/kg, factor 1.283, margin 44%:

```
98.31 × 1.283 × 1.44 × 1.15 = R208.87   (published: R208.80)
```

**Margin is applied as a markup, not a GP divisor.** Getting that backwards
misprices every cut.

### Three findings the schema must respect

1. **Independently-set factors do not self-balance.** A test table recovered
   only R3,992 of a R6,150 side (0.6492) because bone and drip carry no
   factor. Either normalise (`factor ÷ balance`) or post the residual to a
   yield-variance account — silently losing R2,158 of stock value is not an
   option.
2. **Constant-gross-margin allocation can produce negative cost** (−R268.84 on
   bones, demonstrated). Meaningless as inventory value; must be clamped.
3. **With no separable processing costs, market-value and constant-gross-margin
   are mathematically identical.** They diverge only once per-cut costs exist.

### Decision

**Store the factor, normalise by default, offer the residual as variance.**

- Each output line carries a `cost_factor`.
- Apportionment is Aptean's published formula:
  `ratio_i = (qty_i × factor_i) / Σ(qty × factor)`
- Normalising makes Σ(allocated) = parent cost exactly, so no value leaks.
- A per-document flag posts the unrecovered residual to a variance account
  instead, for shops that want yield loss visible in the P&L rather than
  buried in cut costs.
- An `exclude_from_apportionment` flag per line, for waste that must carry
  zero cost regardless.

Weight-proportional is deliberately not offered: it is the wrong answer that
looks reasonable, and a butcher who picks it once will not notice.

---

## Traceability through the breakdown

### The carcass is the lot

The parent is received as a batch-tracked product on a GRV with its carcass or
consignment number as the lot. The block test consumes **that exact lot** via
`BatchDirective.batchId`, and each output cut is received as a lot whose number
derives from the parent.

Backward tracing already works: `batchTrace()` walks to the GRV and supplier.

### Mixed batches — mince from five carcasses

The genuinely hard case, and it is settled by regulation rather than by taste.

USDA FSIS **9 CFR 320.1(b)(4)** requires a grind lot to record supplying
establishment numbers, **all supplier lot numbers**, materials including
**carryover from the previous lot**, production date/time, and clean/sanitise
times. Retention one year. Lots may span multiple suppliers.

> *"the amount of ground raw beef produced during particular dates and times,
> following clean up and until the next clean up, during which the same source
> materials are used."*

**A grind lot does not inherit a parent lot — it mints a new identity and
records its inputs.** That is a many-to-many link table, not a parent pointer.

SA converges independently: **R.2410** defines a batch as production *"over a
period not exceeding 24 hours"*; the EU caps a batch at one day. Build to ≤24h
and both are satisfied.

### The constraint that kills the obvious feature

**Assume SA scale labels carry PLU + weight + price and NO lot number.** The
CAS CL5200 barcode-format token set has no batch token. Lot in a barcode needs
GS1 DataBar Expanded — available on higher-end scales, not the SA default.

`barcodes.ts` already parses PLU + embedded value, which matches reality.

**Do not architect any traceability feature that depends on reading a lot off a
counter label.** Forward tracing is complete to trade customers via invoices
and impossible to anonymous cash customers — EU Art. 18(3) obliges forward
tracing only to *businesses*, with public notice as the answer for consumers.

---

## South African regulatory findings

Each of these changes a column or a default.

- **Classification is *conditionally* compulsory.** R.55 of 30 Jan 2015 (APS
  Act 119/1990) bites only once an abattoir registers an abattoir-identification
  code, and then only where **40+ head/month** are slaughtered.
  → **Class fields must be nullable.**
- **Fat codes differ by species.** Bovine class 2 = 1–3mm; sheep class 2 =
  1–4mm. Verified verbatim from the bilingual gazette.
  → **Fat-class lookup is per species, not global.**
- **The roller mark carries no carcass number** — only age class, fat class and
  abattoir code. Carcass identity cannot be recovered from it and must come
  from the supplier's documentation.
- **Classification drives price:** A2/3 beef R69.21/kg vs C2/3 R61.50/kg cold
  dressed weight — an ~11% spread, so class belongs on the document.
- **VAT: meat *and offal* are standard-rated at 15%.** The offal zero-rating
  was announced 12 March 2025 for 1 May 2025 and **withdrawn** when the rate
  increase was reversed. Much of the web is stale.
  → **Do not build an offal zero-rate class.** No code change needed; VAT is
  already per-product.
- **What binds a retail butchery is R.638 of 2018**, not the Meat Safety Act.
  Reg 10(18) requires a traceability system "according to the best available
  method" plus a recall procedure; reg 10(16) requires records kept **6 months
  after shelf-life** — product-relative, so a hard-coded 6 months is wrong for
  frozen or cured.
- **No legal requirement to trace a cut back to a carcass.** "Traceab\*"
  appears once in all of R.638. This feature is commercially valuable, not
  legally forced — which argues for making the traceability half optional.
- **Boerewors: 90% min total meat, 30% max fat** (R.2410 of 2022, verbatim).
  Trap: **total meat = lean + fat**, so they are not competing buckets. Mince
  fat bands tie to the claim word: extra lean 5%, lean >5–10%, regular >10–30%.

### Corrections to assumptions

- **AI (7001) is NATO Stock Number, not meat. (7002) is MEAT CUT** (UN/ECE).
  AI (703n) holds processor approval numbers.
- **(310n) is fixed-length and takes no FNC1**; (10) and (21) do. Value is
  always 6 digits, `n` = decimal places, `weight = digits / 10^n`.
- **R.1072 is the Red Meat Regulations (2004), not labelling.** Labelling is
  **R.146 of 2010**; R.3337 is still draft.

---

## Verified yield benchmarks

For seeding expectations and flagging an implausible breakdown (AHDB primary
sources):

| Species | Carcase | Bone/fat/drip | Edible meat |
|---|---|---|---|
| Beef | 53% | 13% | **40%** |
| Lamb | 47.44% | 12.20% | **35.24%** |
| Pork | 70.27% | 7.44% | **62.83%** |

US beef primals (UT PB1822): chuck 26.8%, round 22.4%, loin 17.2%, rib 9.6%.
Chilling shrink 2–5%; drip loss 2.4–3%.

**AHDB records both "% of primal" and "% of carcase"** per cut — a direct
schema requirement where cuts are broken down in stages.

---

## Proposed schema — `sql/site/195_block_tests.sql`

### The document

```
block_tests
  id, document_number (NULL until posted), document_date
  status ENUM('draft','posted','cancelled')      -- required by OWN_TABLE_TYPES
  location_id
  species                    -- beef | lamb | pork | game | other
  class_code     NULL        -- A2, AB3, C2 … nullable, see R.55
  fat_code       NULL        -- per-species lookup
  carcass_no     NULL        -- supplier's carcass / consignment number
  input_product_id, input_product_code, input_description
  input_qty, input_unit_cost_excl, input_batch_id NULL
  apportionment  ENUM('factor','manual')
  normalise      TINYINT(1)  -- 1 = scale to parent cost, 0 = residual to variance
  variance_account_id NULL
  input_cost, output_cost, variance_cost, yield_pct   -- denormalised at post
  reference, note, user_id, user_name, timestamps
```

### The outputs

```
block_test_lines
  id, block_test_id, line_number
  product_id, product_code, description
  qty                        -- weight out
  cost_factor                -- the SA factor; 0 with exclude flag
  exclude_from_apportionment TINYINT(1)
  allocated_cost_excl        -- computed at post
  unit_cost_excl             -- allocated / qty
  batch_id NULL              -- the lot this cut became
  is_loss TINYINT(1)         -- bone, drip: consumes weight, takes no stock
  note
```

`is_loss` is a flag rather than a product because bone thrown away is not
stock. It must still consume input weight or the yield percentage lies.

### Cut templates

```
block_test_templates          -- "A2 beef side"
block_test_template_lines     -- product, expected yield %, default factor
```

Without these the butcher keys twenty lines per carcass, every carcass. The
research is unanimous that pre-configured cut lists are what makes the feature
usable.

### The mixed-batch link

```
batch_sources
  batch_id           -- the new grind/mince lot
  source_batch_id    -- a lot that went into it
  qty_contributed
```

Many-to-many, per FSIS. This is what lets a mince lot answer "which five
carcasses" without pretending it has one parent.

### Registration, or the numbers report missing

`block_test` must be added to `OWN_TABLE_TYPES` (`sequences.ts:554`), which is
why `block_tests.status` exists with `'cancelled'` as its void value. Without
this every block test number ever issued reports missing from `verifySequence`.

---

## Screens

- **`/block-tests`** — list, filterable by species and date.
- **`/block-tests/new`** — the capture screen. Pick the input product and lot,
  choose a template, and the cut lines pre-fill. Weights typed in; factors
  default from the template and stay editable. A **live yield and cost panel**
  recalculates as weights are entered — that panel is the feature, since the
  butcher is watching whether this carcass broke down better or worse than the
  last one.
- **`/block-tests/[id]`** — the posted document: what went in, what came out,
  allocated cost and unit cost per cut, yield %, variance, and the lots created.
- **`/setup/block-test-templates`** — cut lists per species.
- **Nav** — under Stock, gated on `products.edit` and module
  `inventory_advanced`.

---

## Suggested phases

1. **Schema + costing engine.** Migration, `blockTests.ts`, the apportionment
   arithmetic, `npm run test:block-tests` proving Σ(allocated) = input cost
   under normalisation, and that no cut takes negative cost.
2. **Post/cancel through `recordMovement()`.** Input consumed, outputs
   received, `average_cost` blended per cut via `weightedAverageCost()`.
   Reconciler proving stock invariants hold.
3. **Capture screen + templates.** The live yield panel.
4. **Traceability.** Parent lot consumed by `batchId`, cut lots created,
   `batch_sources` for mixed batches, extend `batchTrace()` to walk across a
   block test in both directions.
5. **Reporting.** Yield by species over time, cut-cost history, and the
   variance account in the P&L.

Phases 1–3 are the commercial feature; 4 is the regulatory one. They are
separable, and given that no SA law compels carcass-to-cut tracing, a butcher
who only wants costing should not be forced through lot capture.

---

## Open questions

- **Which in-store barcode prefix does GS1 SA allocate** (02 vs a specific 2x)?
  GenSpecs says each member organisation chooses per territory. Confirm with
  GS1 SA before hardcoding.
- **Do the customer butcheries want the variance account**, or is normalising
  into cut costs enough? This is an accounting-policy question, not a technical
  one.
- **Cascading block tests** — MeatWise supports parent/child (side → hindquarter
  → cuts), and AHDB's "% of primal" *and* "% of carcase" columns imply the same.
  Worth confirming whether a single level is enough for phase 1.

## Sources with unread gaps

Flagged rather than guessed:

- R.3450/2023 and R.5419–5420/2024 operative texts are **scanned images**, so
  whether boerewors composition changed after Oct 2024 is unverified.
- VAT Schedule 2 Part B not read verbatim; the standard-rating conclusion rests
  on the withdrawal record.
- Per-model DataBar support for specific Bizerba/Ishida/Avery units unverified.
