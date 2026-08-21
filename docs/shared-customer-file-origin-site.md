# Sharing the customer file: what was found, and what is still open

Notes kept while building the shared customer file. Everything here was found
by **testing rather than by reading** — each item is a case where the design on
paper turned out to be wrong or incomplete, which is why they are written down
rather than left in commit messages.

The first three are resolved. The last two are open.

---

## ✅ Branch foreign keys had to be dropped after all

**Found:** by switching sharing on and writing a layby against a shared
customer. **Fixed:** `sql/site/197_shared_customer_file.sql`.

An early probe showed MariaDB accepts a cross-database foreign key and fires
its cascade, and we concluded branch tables could **keep** their FK to
`customers`.

That was wrong, and the probe missed it because it *created* a cross-database
FK from scratch. The real schema is different: every branch table's FK already
points at **its own** `customers` table, and those tables stay behind when the
file moves. So a branch could not record anything against a shared customer:

```
INSERT INTO laybys (customer_id, ...) VALUES (<owner's customer id>, ...)
→ ER_NO_REFERENCED_ROW_2: a foreign key constraint fails
  (`ody10001_master`.`laybys`, CONSTRAINT `fk_layby_customer`
   FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`))
```

It failed hard and immediately, which was the good news — no silent-wrong-answer
version of it.

Twelve branch-owned tables now drop the FK and validate in code. Repointing at
the owner's schema was never available: the FK would be wrong for every store
that does not share, and a store cannot have two schemas.

**The guard that came with it.** `fk_sdoc_customer` was `RESTRICT`, so the
database refused to delete a customer with sales history. `deleteCustomer()`
only checked the balance, so dropping the key would have quietly allowed
deleting a settled customer with a year of invoices. That rule now runs in code,
before the delete, and names what is in the way.

---

## ✅ Every shared-file row needed an origin site

**Found:** while routing `salesPosting.ts` through `customerOwnerSite()`.
**Fixed:** `sql/site/198_origin_site.sql` and `200_loyalty_stamp_origin.sql`.

`customer_transactions.source_doc_id` points at a row in **the branch's own**
database, and those ids are auto-increment per database — store 3 and store 7
both have a document 5 001.

Pooled into one shared ledger, `document_id` stopped identifying anything, and
three UNIQUE keys built on it started rejecting good rows. That was worse than a
wrong read: store 3 awards points for its sale 5 001, store 7 is refused as a
duplicate, and **the customer silently loses the points**.

`origin_site_id` now sits on `customer_transactions`, `loyalty_ledger`,
`loyalty_wallet`, `loyalty_stamps` and `gift_card_events`, and in the keys.
Deliberately not a foreign key — `cp2_sites` lives in the control database, and
a site leaving a group must not make its own history unreadable. Same shape as
[`stock_transfers.peer_site_id`](../sql/site/101_store_transfers.sql).

Seven lookups that matched on a document id alone are now scoped by it. Three
were writes, and those were the dangerous ones: an UPDATE that could rewrite
another branch's credit-note number, a wallet refund that could refund the wrong
sale, and `restoreGiftCardsForDocument`, which reverses money onto and off cards.

---

## ✅ Loyalty is fully centralised

**Found:** by asking whether the result deserved the name. **Fixed:**
`sql/site/201_loyalty_central.sql`.

An earlier pass moved the loyalty BALANCES to the owner and left the programme
CONFIGURATION per store, because `loyalty_card_items` had foreign keys to
`products` and `departments` and could not follow the customer.

The result was a shape nobody would call a loyalty programme: one shared points
balance, but a tier ladder and a punch card per branch. Gold could mean R50,000
at one store and R30,000 at another, measured against one shared spend figure.

The fix was to stop naming local row ids. Configuration now names the **portable
identifier** — a product CODE, a department NAME — which is what this system
already uses to mean "the same product everywhere" (see
`lib/site/shareSettings.ts`). So `loyalty_tiers`, `loyalty_cards` and
`loyalty_card_items` all move to the owner with the balances.

`listCards()` resolves those codes to the caller's own ids once per load, so
matching a basket line stays an id comparison on the till's hot path.

### The one real behaviour to know about

A card scoped to a product code earns stamps only at branches that **carry** that
code. That is not a gap — a shop that does not sell the item cannot award a stamp
for buying it — and the cards screen says so per card: *"3 products · 1 not
stocked here"*.

Editing a card from a branch that lacks one of its products carries the
unresolvable codes through untouched rather than dropping them. Without that,
editing from the wrong store would silently delete scope from the whole group's
card, and nobody at that store would ever see the difference.

---

## ✅ Fixed: each entity has its own documents and comments

**Answered:** split the tables. **Fixed:** `sql/site/207_party_files_per_entity.sql`
plus `src/lib/site/partyStore.ts`, which is the single place that decides which
entity lands where.

The framing below was wrong in a way worth recording: it said "two tables serve
both customers and suppliers", but `CommentEntity` is
`'customer' | 'supplier' | 'job_card' | 'ticket'` — **four** entities, and two of
them are branch-local by nature. A table already straddling three ownership
answers was never going to follow one file cleanly, which made the split the
obvious answer rather than the expensive one.

    customer_documents / customer_comments   →  the customer owner
    supplier_documents / supplier_comments   →  the supplier owner
    job_documents      / job_comments        →  the branch (jobs and tickets)

The bytes needed nothing. `UPLOADS_ROOT` is resolved once per **process** and
takes no `siteId`, and sharing already requires every member to be on the same
MariaDB instance as the primary — so branch and owner are the same machine and
the same uploads directory. Only metadata moved.

Both tables were empty on every database, so the `INSERT…SELECT` copies in 207
are no-ops that exist only for a site which accumulates rows before running it.
The old tables are left in place: an empty table costs nothing, and dropping one
holding a signed contract because a migration assumed it was empty is not
recoverable.

Verified with suppliers shared and customers NOT: three `createComment` calls
from one branch landed in three different places, which one table could not have
done.

The original note is kept below.

---

## ⚠ Was open: two tables serve both customers and suppliers

`party_documents` and `party_comments` are keyed by a loose
`(entity, entity_id)` pair with no foreign key, and the entity is `'customer'`
**or** `'supplier'`. They cannot follow one of them without stranding the other.

They currently move to the owner alongside customers, which is correct **while
customers are shared and suppliers are not**. Sharing suppliers as well will
break that, because the supplier half would then need to be somewhere else.

Two options, neither of which needs deciding now:

- Split the table per entity, so each half follows its own file.
- Keep one table in the branch and accept that documents and comments are
  per-store rather than per-customer.

The first is more faithful; the second is less work. Decide it with the supplier
classification, not before.

**Update — the supplier classification is now made (206), and this is still
open.** Suppliers are shared as a creditors book while purchasing stays per
store, so a supplier record genuinely does move to the owner, and these two
tables genuinely cannot follow both files at once. Nothing has broken yet
because the supplier switch is hidden and no site has both flags on.

It has to be answered before the switch returns. The narrowing is that the
supplier half of `party_documents` is thinner than the customer half — supplier
documents are mostly price lists and contracts filed once, where a customer's
are per-account correspondence — so "keep one table in the branch" costs less on
the supplier side than it would have on the customer side. That is an argument
for the cheaper option, not a decision.

---

## ⚠ Open: only ever run with two stores

Everything above is verified on a two-site dev database. Ten branches is the
actual use case, and things that hold at two sometimes do not at ten — the group
reconciliation fans out one query per member, and the resolver caches per
request.

A three- or four-store fixture run against `test:shared-customer-queries` is the
cheapest way to find what two stores hid.
