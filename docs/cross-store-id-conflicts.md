# Ids do not mean the same thing in two stores

Every store has its own MySQL database with its own `AUTO_INCREMENT`, so **id 9
in one store is a different row from id 9 in another**. Anything that carries an
id across the boundary is a silent-wrong-answer bug: it resolves to a real row,
just the wrong one, and nothing errors.

Live proof from the dev data:

| | site 1 | site 2 |
| --- | --- | --- |
| department 9 | Cooldrinks | *does not exist* |
| departments 11–16 | *do not exist* | Smash Burgers, Gourmet Hotdogs, … |
| vat_rates 165 | sales @ 7.5% | *does not exist* |

## The rule

Never move an id. Move the **portable key** and resolve it on the far side:

| Table | Portable key | Where it is done |
| --- | --- | --- |
| `products` | `code` | `shareSettings.ts`, `productFanout.ts` |
| `price_structures` | `name` | `mapStructureIds()` |
| `vat_rates` | `rate` percentage | `vatRateIdFor()` |
| `departments` | `name` | `departmentIdFor()` |
| `loyalty_cards` scope | product `code`, department `name` | `201_loyalty_central.sql` |
| a document | `(origin_site_id, id)` | `198_origin_site.sql` |
| `sales_reps` | `name` | `205_customer_rep_name.sql` |
| a supplier document | `(origin_site_id, source_doc_id)` | `206_shared_supplier_file.sql` |

---

## ✅ Already correct

**Price structures and VAT rates in the fan-out.** Matched by name and by rate.
A target store that has no match is skipped rather than having a row invented —
and, since the "Say what could not be translated" commit, that skip is now
REPORTED per store instead of being silent. A store missing a "Wholesale" tier
used to keep its old wholesale price while the screen said the save succeeded.

**Documents referenced from a shared ledger.** `origin_site_id` plus the
document id, because document ids collide across branches — see
`docs/shared-customer-file-origin-site.md`.

**Loyalty programme configuration.** Cards name a product `code` and a
department `name`, resolved per store when the card is loaded.

---

## ✅ Fixed: departments now travel by name

`fanoutProduct` copied description, barcode, type, properties, cost, prices and
tax rates — but not `department_id`. A product fanned out to a branch arrived
with NO department, missing from every department-filtered list, report and till
menu in that store. Meanwhile the Linked Stores screen promised "keeps the
department structure the same, so a product lands in the same place everywhere".

Now matched by NAME, like price structures. Proven on the dev data, where the
same department has different ids in the two stores:

    site 1 "Cooldrinks" = id 9
    site 2 "Cooldrinks" = id 20   -> resolved correctly by name

A store with no department of that name is REPORTED, not invented: creating
departments as a side effect of saving a product is not something that screen
should do.

### Still open: what `sharesDepartments` should mean

The flag is read in one place (`mapMember`) and acted on nowhere. Either it fans
the department STRUCTURE out — creating missing departments in a branch — or it
should be removed rather than left promising something it does not do. The
per-product department now travels regardless of it.

`brand_id` has the same gap and the same fix, one table down. Left for now
because a brand is a label rather than a routing decision: a product with no
brand is untidy, a product with no department is missing from the till.

## ⚠ Open: never run with more than two stores

Everything above is reasoned from two dev sites. Ids collide far more readily at
ten, and a third store is the cheapest way to find what two hid — two stores can
agree by accident where ten cannot.

---

## ✅ Fixed: `sales_reps` travels by name

**Answered:** a rep is a group-wide PERSON — they work for the company, not a
building — so option 2 below was taken. **Fixed:** `205_customer_rep_name.sql`
adds `customers.rep_name`, backfilled from the rep the customer already points
at, and every read, filter, bulk-assign and delete-guard resolves through it.

By NAME and not code: `code` is nullable with no unique key, so it does not
identify a rep even within one store, while `name` carries `uq_sales_rep_name`
and is already what every lookup in `customerLookups.ts` matches on.

`rep_id` stays — within one store it is a correct indexed FK doing real work,
and every unshared site keeps using it. Renaming a rep now carries to the
customers, read before the update while the old name is still knowable.

Verified against genuinely divergent ids: the same rep is id 5 at the primary
and id 3 at the branch; the branch's own id filters correctly and the count
crosses the boundary.

The original note is kept below, because the reasoning that made it wrong is
the part worth remembering.

---

## ⚠ Was open: `sales_reps` is NOT replicated — my earlier note was wrong

`customerDb.ts` used to state that `sales_reps` "is replicated into every store
rather than moved", and the decision to leave rep joins alone was built on that
sentence. **It is false.** The only `INSERT INTO sales_reps` in the codebase
(`customerLookups.ts`) writes to the caller's own database, nothing fans it out,
and no migration seeds it.

So `customers.rep_id` is a **branch id sitting in the owner's table** — the one
thing the rule at the top of this file forbids. Four consequences, none of which
raise an error:

| Where | What happens |
| --- | --- |
| Joining reps from the owner | resolves against the OWNER's reps — a different person, or nobody |
| Filtering a list by rep | matches on an id that means something else |
| Bulk-assigning a rep | writes a branch id into the shared file |
| `deleteSalesRep` | counts customers in the branch's empty table, so it never refuses |

Recorded rather than quietly fixed, because the fix is a **choice**:

1. **Replicate reps by code**, like products — reps stay per-store objects and
   the fan-out keeps them in step. Fits if a rep belongs to a branch.
2. **Store `rep_code`, or `rep_name`** on the customer instead of `rep_id`.
   Fits if a rep is a group-wide person, and is the smaller change.

Option 2 matches how documents already snapshot a customer, and how loyalty
cards name a product `code`. It is the recommendation, but commission is
involved, so it is the owner's call rather than mine.

## ✅ Fixed: `customerFileIsShared()` is called, and it was also wrong

It was exported and never imported — but the more interesting part is that it
would not have worked if it had been. It read `owner.siteId !== siteId`, "is my
file in somebody else's database", which is true at a branch and **false at the
primary** even though the primary's `customers` table IS the shared file.

That broke the debtors reconciliation at head office — the one place that
reconciles the whole book — which compared its own control account against the
GROUP's sub-ledger and reported drift that could not be repaired. Measured at
55.1m on a two-store demo group.

It now asks whether any other member routes here, so it is true at both ends,
and `supplierFileIsShared()` shares one implementation with it. Callers that
genuinely need "is it elsewhere" compare `customerOwnerSite()` themselves, which
is what `customerDbPrefix()` does and why it stayed correct.

**The general lesson, which keeps recurring:** the primary is the most sharing
store in the group, not the least. Any "am I special" test written from a
branch's point of view inverts there, silently.

---

## ✅ Decided: the supplier file is shared, purchasing is not

`shares_suppliers` shares the CREDITORS BOOK — one supplier record, one balance,
one ledger, one payment run — so a supplier invoiced at branch 3 and paid from
branch 7 nets off correctly.

`purchase_documents`, `supplier_prices` and `product_suppliers` **stay in the
branch.** All three key into `products`, and products do not move: where a group
shares them at all it does so by replication, matched on code, which is a
different mechanism. `199_loyalty_shared_split.sql` settled the identical
argument on the customer side by keeping `loyalty_card_items` local for exactly
this reason.

So this is **not central buying**, whatever `015`'s header suggests. Each branch
orders for itself, at its own agreed costs, into its own stock, with its own PO
numbers. Genuine central buying needs a group-wide order document a branch
receives against — a new flow, not a routing change. See
`206_shared_supplier_file.sql`.

`product_suppliers` and `supplier_prices` each carry a CASCADE key to `products`
AND one to `suppliers` — a shape the customer side never met. Keeping them in
the branch means the products key survives and only the supplier one is dropped.

---

## 🔴 Open, and the most serious one: a loyalty sale at a branch CANNOT COMPLETE

Not an id collision — the opposite failure, and worse. Reproduced end to end
against the dev sites, not reasoned about.

`salesPosting.ts` does its loyalty spend **inside the sale's own transaction**,
on the branch's connection (lines 931, 950, 959):

    await redeemPointsForSale(tx, actor, ...)   // tx = the BRANCH's transaction

With a shared customer file the customer row lives in the OWNER's database, but
`loyalty_ledger` still exists in the branch too, still carrying
`fk_loyalty_ledger_customer` to the branch's own `customers`. Migration 197
freed twelve BRANCH tables from that FK; the loyalty tables were not among them,
because the plan was that loyalty MOVES to the owner — so nobody asked what the
branch's leftover copies would do when the sale path kept writing to them.

Measured result:

    Customer #4 (Harbour Cafe) lives in site 1. Selling at site 2.
    -> ER_NO_REFERENCED_ROW_2 on ody10001_master.loyalty_ledger

The write throws inside `siteTransaction`, the throw propagates, **the whole
sale rolls back.** A shop that switches sharing on cannot sell to a loyalty
customer at any branch — the till refuses, having already scanned the goods.

It fails loudly rather than silently, which is the one mercy here: no split
points, no drifting balance. But it is a hard stop at a counter with a queue.

### Why this needs a decision rather than a patch

The three spend functions take a `PoolConnection` precisely so an unaffordable
redemption rolls the sale back — a real requirement, stated in the comment
above the block. Routing them to the owner means they can no longer share the
sale's transaction, because **no transaction spans two databases.** So the
atomicity that comment relies on has to be rebuilt, not just relocated:

1. **Check first, write after.** Verify affordability on the owner BEFORE the
   sale transaction opens, then write the spend after it commits. Keeps the
   refusal, but a crash between the two leaves goods sold and points unspent.
2. **Reserve, then confirm.** A two-phase hold on the owner: reserve inside the
   check, confirm after commit, release on rollback. Correct under a crash, and
   materially more work.
3. **Keep loyalty per-branch** even when customers are shared — points earned at
   a store stay that store's. Cheapest, and contradicts what centralised
   loyalty was for.

(2) is the only one that is actually correct under a crash at a till, which is
where crashes happen. But this is a business call about what a customer's points
mean across stores, so it is the owner's to make, not mine.

**Until it is fixed, `shares_customers` must not be switched on for any site
whose till sells loyalty.** The Linked Stores switch does not warn about this.
