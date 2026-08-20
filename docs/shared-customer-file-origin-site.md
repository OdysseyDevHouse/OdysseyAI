# Open schema work for the shared customer file

Two items, both found by testing rather than by reading. Both must be done
before the sharing switch is exposed (stage 6).

---

## 1. Branch foreign keys must be dropped, not kept

**Status:** open. **Found:** stage 4, by switching sharing on and writing a
layby against a shared customer.

The stage 1 classification said cross-database foreign keys work — MariaDB
accepts them and the cascade fires, both measured in
`scripts/probe-shared-customer-file.ts`. It concluded that branch tables could
therefore **keep** their FK to `customers`.

That conclusion was wrong, and the probe did not catch it because it *created*
a cross-database FK from scratch. The real schema is different: every branch
table's FK already points at **its own** `customers` table, and those tables
stay behind when the file moves. So a branch cannot record anything against a
shared customer:

```
INSERT INTO laybys (customer_id, ...) VALUES (<owner's customer id>, ...)
→ ER_NO_REFERENCED_ROW_2: a foreign key constraint fails
  (`ody10001_master`.`laybys`, CONSTRAINT `fk_layby_customer`
   FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`))
```

It fails hard and immediately, which is the good news — it cannot corrupt
anything, and there is no silent-wrong-answer version of it.

**The fix:** branch-owned tables drop their FK to `customers` and validate in
code, exactly as the original plan said before the probe seemed to make it
unnecessary. That is `sales_documents`, `laybys`, `job_cards`, `online_orders`,
`contracts`, `gift_cards`, `tickets`, `job_sla_policies`, `customer_assets`,
`job_series`, `service_addresses`, `online_saved_baskets`,
`discount_code_uses`.

Repointing them at the owner's schema is *not* the fix: the FK would then be
wrong for every store that does not share, and a store cannot have two schemas.

**What the probe result still buys us:** `cashbook_links` and the other
customer-cluster tables move *with* `customers`, so their FKs stay intact and
resolve locally. Only tables that stay behind lose theirs.

---

## 2. `source_doc_id` needs an origin site

**Status:** open, must be fixed before the sharing switch is exposed (stage 6).
**Found:** stage 3, while routing `salesPosting.ts` through `customerOwnerSite()`.

## The problem

`customer_transactions.source_doc_id` points at a row in **the branch's own**
database — a `sales_documents.id`, a `job_cards.id`, an offline return. Those
ids are auto-increment per database, so store 3 and store 7 both have a
document 5 001 and a job 42.

Today that is harmless: the ledger and the document live in the same database,
so the id is unambiguous. Once a group shares one customer file, the ledger rows
of ten branches sit in one table while the ids they point at stay local. Any
query matching on `source_doc_id` alone can then match **another branch's**
transaction.

## Where it bites

Four call sites look up `customer_transactions` by `source_doc_id` without
scoping to a customer. Each is a silent wrong answer rather than an error:

| Site | What goes wrong |
| --- | --- |
| [`jobDeposits.ts:98`](../src/lib/site/jobDeposits.ts) | Job 42 at store 3 shows the deposits taken against job 42 at store 7. Every balance on the job is then wrong. |
| [`paidInvoices.ts:165`](../src/lib/site/paidInvoices.ts) | Reads `amount_outstanding` for the wrong invoice, so a till shows the wrong amount still owing. |
| [`offlineReturns.ts:527`](../src/lib/site/offlineReturns.ts) | **An UPDATE.** Writes a printed credit-note number onto another branch's ledger row. |
| [`salesEdit.ts:134`](../src/lib/site/salesEdit.ts) | The guard that refuses to reverse an allocated invoice. Could refuse a legitimate edit, or allow one it should refuse. |

`salesPosting.ts:1835` is already safe — it scopes by `customer_id AND
source_doc_id`, which cannot collide because a customer's transactions are one
set. That is the accidental precedent for the fix.

## The fix

Add `origin_site_id` to `customer_transactions`, written by `postTransaction()`
from the **calling** site (not the owner), and carry it into every lookup that
matches on `source_doc_id`.

Deliberately not a foreign key: `cp2_sites` lives in the control database, and a
site leaving a group must not make its own history unreadable. That is the same
reasoning — and the same shape — as
[`stock_transfers.peer_site_id`](../sql/site/101_store_transfers.sql).

The same treatment is already needed for three UNIQUE keys on the loyalty and
gift-card tables, for exactly this reason:

- `loyalty_ledger.uq_ledger_document_earn (document_id, entry_type)`
- `loyalty_wallet.uq_wallet_document_spend (document_id, entry_type)`
- `gift_card_events.uq_gc_event_doc (card_id, document_id, entry_type)`

Those are worse than a wrong read: pooled across branches, the second branch's
award is refused as a duplicate key and the customer **silently loses points**.

## Related: loyalty splits into balances and programme configuration

The stage 1 classification moved "loyalty" to the owner as one block. Working
through it, the five customer-data tables do move — but three others turned up
that were never classified, and they must **stay in the branch**:

| Table | Why it stays |
| --- | --- |
| `loyalty_tiers` | The tier ladder is a shop's own pricing decision, and `loyalty_members.tier_id` FKs to it. |
| `loyalty_cards` | Punch-card definitions — reward product, required stamps. |
| `loyalty_card_items` | FKs to **`products`** and **`departments`**, both branch-owned. It cannot leave. |

That produces a dependency crossing the boundary in the other direction:
`loyalty_stamps` and `loyalty_vouchers` hold customer balances (owner) but FK to
`loyalty_cards` (branch). Those two foreign keys have to be dropped, exactly as
in `197_shared_customer_file.sql`, and validated in code.

The practical consequence is worth stating plainly: **a punch card is defined
per store.** "Buy 10 coffees" at branch 3 is a different card from the same
offer at branch 7, even though the customer and their points balance are shared.
Making cards group-wide would mean sharing `products` too, which is a different
project (product sharing already exists and is a fan-out, not an ownership move).

Tier ladders are the same: shared points, per-shop tiers. Worth confirming that
is acceptable, because it is a visible product behaviour rather than an
implementation detail.

## Related: two tables that serve both customers and suppliers

`party_documents` and `party_comments` are keyed by a loose
`(entity, entity_id)` pair with no foreign key, and the entity is
`'customer'` **or** `'supplier'`. They cannot follow one of them without
stranding the other.

They currently move to the owner's database alongside customers, which is
correct while customers are shared and suppliers are not — the arrangement
stage 3 assumes. **Sharing suppliers as well will break that**, because the
supplier half of the table would then need to be somewhere else.

Two options when suppliers come round, neither of which needs deciding now:

- Split the table per entity, so each half follows its own file.
- Keep one table in the branch and accept that documents and comments are
  per-store rather than per-customer.

The first is more faithful; the second is less work. Decide it with the
supplier classification, not before.

## Why it is not fixed yet

Stage 3's discipline is that every change is provably a no-op while all sharing
is off, policed by the existing suites. Adding a column and threading it through
`postTransaction()` is a schema change with real behaviour, so it belongs with
the rest of the schema work in stage 6 — where it can be written directly into
`sql/site/014_subledger.sql` rather than layered on, since no site holds live
data.

Recorded here so it cannot be lost between the two.
