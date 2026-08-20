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

## ⚠ Open: `sales_reps` is NOT replicated — my earlier note was wrong

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

## ⚠ Open: `customerFileIsShared()` is defined and never called

`storeGroups.ts:393` exports it; nothing imports it. Whatever guard it was
written for is not running.
