# Batch-tracked products — tester's guide

A walkthrough for someone who knows what lot/batch tracking *is*, but has never
navigated this system. Every step names the screen, the menu path and the
button. Do them in order the first time — later steps need lots created by the
earlier ones.

**Before you start**, confirm two things or nothing below will be visible:

- The site has the **Inventory Advanced** module switched on. Without it the
  **Batches** menu item is not there at all.
- Your login has the `stock.view` capability (to see lots) and `stock.adjust`
  (to write one off). If **Write this lot off** never appears in step 8, that
  is the missing one.

---

## 1. Make a product batch-tracked

**Stock → Products → New product** (or open an existing one).

1. On the **Details** tab, find the **Product type** card.
2. Choose **Batch-tracked product**.
3. Save.

That is the whole setup. There is no separate "batch settings" screen — the
type is the switch.

> **If the product already had stock on hand**, the system immediately files
> that quantity into an *untracked bucket* per location, so the books stay
> balanced from the moment you flip the type. You will see it in step 3 as a
> row badged **Untracked**. This is expected and correct, not a bug — see
> section 9.
>
> For the cleanest test, use a **brand-new product with zero stock**.

---

## 2. Receive stock and capture the lot

Goods receipt is the **only** place a person types lot data. Everywhere else
the system works out which lot moved on its own.

**Stock → Purchasing → Receive** (or receive against an existing order).

1. Pick a supplier.
2. Add your batch-tracked product as a line and enter a quantity.
3. A **Lot** panel appears directly underneath that line, with a badge reading
   **batch number or expiry needed**.
4. Fill in **Batch / lot number** (e.g. `L2408A`) and/or **Expiry date**.
   The badge flips to **captured**.
5. Post the receipt.

**Things to test here:**

- **The receipt is blocked without lot data.** Leave both fields empty — the
  post button stays disabled. One of the two is enough; you do not need both.
- **Expiry only, no lot number.** The lot is auto-named `EXP-2026-11-30` from
  the date. Valid on purpose — plenty of suppliers print a date and nothing
  else.
- **Receive the same product three times**, each with a different lot number
  and a different expiry date. You need several lots to test the sale order in
  step 4. Give one of them an expiry date **in the past**.
- **Receive the same lot number twice.** It should top up the existing lot
  rather than creating a duplicate row.

---

## 3. Look at the lot book

**Stock → Batches**

The filter buttons across the top:

| Filter | What it shows |
|---|---|
| **On the shelf** | Every lot with stock left. The default. |
| **Expiring (30d)** | Lots with stock left, expiring within the window. |
| **Expired** | Lots with stock left whose date has already passed. |
| **Untracked** | The unattributed buckets — see section 9. A clean book has none. |
| **All** | Everything, including lots fully used up. |

The list is sorted by expiry date, so **what needs attention is at the top**.
Expiry dates are colour-coded: red for already expired, amber for within the
window, plain for comfortable.

Search takes a lot number, a product code or a product description.

**Check:** your three lots from step 2 are all listed, with the right supplier
and the GRV number they arrived on.

---

## 4. Sell it — and check FEFO

This is the core behaviour. **Nobody picks a lot at the till.** The clerk sells
the product normally; the system decides which lot went.

1. Sell a small quantity of the product at the till.
2. Come back to **Stock → Batches**, filter **All**.
3. Check which lot went down.

**What should happen — First Expired, First Out:**

- The **earliest expiry date** is consumed first.
- A lot with **no expiry date** is used **last** among the in-date lots —
  there is no urgency on something that never goes off.
- **Expired lots are used only after everything in date is gone.**

**Test the expired case deliberately:** sell more than the total of your in-date
lots, so the sale has to reach into the expired lot.

**The sale will still go through.** This is intentional — the shelf is the
authority, not a date typed at a receiving door, and a till that refuses on a
stale expiry stops trade over a typo. Instead the system records it: go to the
activity log and look for an **expired stock sold** entry against that product.
Confirm it is there.

**Also test a sale that crosses two lots**, e.g. 8 units when the oldest lot
only has 5. It should take 5 from the oldest and 3 from the next — and step 7
will show both slices.

---

## 5. Return a sale

Process a customer return for something you sold in step 4.

**Expected:** the quantity goes back to **the lots it originally left** — not
to the newest lot, and not to the bucket. Check on the Batches screen that the
lot which gave up the stock is the one that gets it back.

If you return more than the original sale took, the surplus lands on the newest
open lot.

---

## 6. Transfers and stock takes

**Transfer — Stock → Transfers.** Move some of the product to another location.

- **Expected:** the lot identity travels with the goods. The destination
  location shows the *same lot numbers and expiry dates*, not a fresh anonymous
  pile. Filter by location on the Batches screen to confirm.

**Stock take — Stock → Stock Takes.** Count the product and post a variance.

- **Counting stock down** takes it earliest-expiry-first.
- **Counting stock up** goes onto the most recently received lot — most stock
  found on a count arrived recently. If there is no tracked lot at all, it goes
  to the untracked bucket.

---

## 7. Trace a lot — the recall test

This is the reason batch tracking exists. **Stock → Batches → click any row.**

A panel opens showing:

- **Backwards:** the supplier and the GRV number the lot arrived on.
- **How much is left** of how much was received.
- **Forwards:** every movement that touched it — Received, Sold, Returned,
  Adjusted, Transferred in/out, Built — each with its document number and the
  quantity.

**The test:** pick a lot, and from this panel alone answer *"which supplier
sent it, and which sales documents did it go out on?"* That is the question a
recall notice asks.

---

## 8. Write a lot off — the recall action

Same panel, button **Write this lot off** (only shown if the lot has stock
left, and you have `stock.adjust`).

1. Click it.
2. Pick a **Reason** — the category the write-off is counted as in reporting
   (Damaged, Shrinkage, Expired or spoiled, …). Required.
3. Type the **Details** — the specifics the reason cannot carry, e.g.
   `Supplier recall notice 2026-08`. Also required.
4. Confirm.

> Two fields, deliberately. The **reason** is what *"how much did we lose to
> recalls last quarter"* totals; the **details** are what the person reading
> that line wants next. Neither answers the other's question.

**Expected:** everything left of that lot comes off the shelf, and you get a
toast with an **adjustment document number**.

**Verify it went through the normal path**, which is the whole point of the
design: go to **Stock → Adjustments**, find that document number. It should be
an ordinary posted adjustment, reversible the same way any adjustment is.
There is no special recall mechanism to learn.

On that document, check the line's **Note** column reads
`Lot L2408A — <your details>`. That is where the lot identity is recorded, and
it is the column an auditor reads.

> The button is deliberately hidden on **Untracked** rows — you cannot write
> off a bucket, because you would not be able to say what you had written off.

---

## 9. Untracked buckets — expected, not a fault

A row badged **Untracked** is stock the system holds but cannot attribute to a
lot. It appears legitimately when:

- A product was **switched to batch-tracked while it already had stock**.
- Stock was **written on** with no lot data (opening balances, a count-up on a
  product with no lots yet).
- A **transfer arrived** that could not be paired to an outbound lot.
- Something **oversold** — more went out than any lot could cover.

**An untracked bucket can go negative.** That is on purpose: an
over-commitment is shown rather than hidden. A negative bucket is a real
signal that stock went out that the books cannot account for.

**The fix is always a count or a corrected receipt** — never an edit to make
the number look right.

**Worth testing:** oversell the product past everything on the shelf, then
check the **Untracked** filter for a negative row.

---

## 10. Voiding a receipt

Void a GRV that brought in a batch line.

- **If none of the lot has been sold:** the lots that receipt created are
  backed out cleanly, and any lot that existed *only* because of that document
  disappears entirely.
- **If some of it has already been sold:** the void is **refused**, with a
  message telling you to raise a supplier return instead. Test this — receive a
  lot, sell one unit of it, then try to void the receipt.

---

## What is *not* in scope

So the tester does not go hunting for things that were never built:

- **The till never asks about lots.** No lot picker at point of sale. FEFO is
  fully automatic. The only manual lot entry in the whole system is at goods
  receipt, and on a deliberate write-off.
- **A product cannot be both batch-tracked and serialised.** Product type is a
  single choice.
- **There is no expiry blocking at the till.** Selling expired stock is allowed
  and logged, by design (see step 4).
- **There is no automatic expiry write-off.** Expired lots sit on the Batches
  screen under the **Expired** filter until someone acts on them.

---

## Quick reference — where everything lives

| What | Where |
|---|---|
| Make a product batch-tracked | Stock → Products → *product* → Details → Product type |
| Capture a lot number / expiry | Stock → Purchasing → Receive → the Lot panel under the line |
| See all lots, chase expiry | Stock → Batches |
| Trace one lot / recall | Stock → Batches → click the row |
| Write a lot off | Stock → Batches → click the row → Write this lot off |
| Confirm the write-off posted | Stock → Adjustments |
| Confirm expired stock was sold | Activity log — "expired stock sold" |

## The one-line summary for the tester

*Lots are born at goods receipt, consumed earliest-expiry-first automatically,
and the Batches screen is where you chase expiry and answer a recall.*
