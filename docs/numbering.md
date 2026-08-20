# Document numbering

Every number this app issues comes from one of **four systems**. They look
similar and are not interchangeable, and most numbering bugs in this codebase
have been somebody reaching for the wrong one.

| System | For | Lives in |
|---|---|---|
| **Document sequences** | Invoices, quotes, GRVs, journals — anything with a printed number | `src/lib/site/sequences.ts` |
| **Segments** | Which store and till a counter document came from | `src/lib/site/numbering.ts` |
| **Offline sequences** | A till numbering with no server | `src/lib/posOffline/saleNumber.ts` |
| **Master codes** | Customer, supplier and product codes | `sequences.ts` (`nextMasterCode`) |

---

## 1. Document sequences — `src/lib/site/sequences.ts`

One row per `(doc_type, terminal_id)` in `document_sequences`. `terminal_id = 0`
(`SITE_SEQUENCE`) is the shop-wide run; anything else is one till's own.

### Reading

| Function | What it does |
|---|---|
| `listSequences(siteId)` | Every sequence, for the setup screen |
| `listTerminalSequences(siteId, terminalId)` | One till's |
| `getSequence(siteId, docType, terminalId)` | One row, or null |
| `previewNext(sequence)` | What the next number **would** look like. Pure — allocates nothing |

### Allocating

**`nextDocumentNumber(tx, docType, now, terminalId, segments)`** — the one that
actually issues.

Takes a **transaction**, not a pool, and that is the whole safety property: it is
a single `UPDATE` that takes an exclusive lock on the primary-key row, so a
concurrent finalise blocks until this transaction commits.

Three things worth knowing:

- **The SET clauses are order-dependent.** MySQL evaluates left to right, so
  `last_issued_number` must be assigned *before* `next_number` is advanced.
  Reversed, every document is numbered one ahead of itself.
- **The yearly reset is inside the same statement**, so two tills crossing
  midnight on 1 January cannot both perform "the" reset.
- **A missing row throws.** It does *not* fall back to the shared sequence —
  that would drop an unregistered till's sale into the middle of the shop's run
  silently, and nobody would find out until the numbers were reconciled.

**`adoptDocumentNumber(tx, docType, terminalId, value)`** — for a sale that was
numbered offline. It does not allocate; it catches the sequence *up*.

Uses `GREATEST`, so sales arriving 97, 98, 99 and a retry of 97 all leave the
sequence at 100 whatever order they land in. The number itself is protected by
`uq_doc_number`, so a genuine duplicate is refused by the database rather than
trusted from the client.

### Changing

`validateSequence(input)` then `updateSequence(...)`. A prefix is refused once
documents have been issued under the old one — it is printed on documents
customers hold.

### Checking

**`verifySequence(siteId, docType, terminalId)`** — finds gaps: numbers the
sequence says were issued with no document to show for them.

It needs to know which TABLE a doc type lives in. That registry has been
forgotten **four times** (stock takes, job cards, customer assets, laybys), and
each time it was found long after the numbers had been issued. A doc type with
its own table must be registered there, and needs a `status` column carrying
`'cancelled'` for the contract to hold.

---

## 2. Segments — `src/lib/site/numbering.ts`

Segments answer *"which store and which till issued this"*. They turn
`INV000041` into `INV_01_02_000041`.

```
INV _ 01 _ 02 _ 000041
 │    │    │      └── the counter, from the sequence
 │    │    └───────── till number   (terminals.till_number)
 │    └────────────── store number  (settings.store_number)
 └─────────────────── prefix        (the sequence's)
```

**The store segment is not decoration.** Twenty branches each number their first
till `01`, so without it every branch issues `INV_01_000041` and a group report
has twenty rows claiming one invoice number. `uq_doc_number` cannot catch that —
each site has its own database and its own copy of that index.

### `numberSegmentsFor(siteId, docType, terminalId, origin)`

The gate. Returns segments, or `null` meaning *"number this the way it has
always been numbered"*. Null in four cases:

1. the store is on **site-wide** numbering (`sales_number_scope`);
2. the doc type is **not one a counter issues** — see below;
3. the document has **no terminal**;
4. the document was captured in the **back office** (`origin`).

**`SEGMENTED_DOC_TYPES`** is `invoice`, `credit_sale`, `quote`, `sales_order` —
what a counter issues. A purchase order, GRV, journal or stock take is raised by
the business rather than by a register, has no till to name, and keeps the
shared run.

**`origin` is explicit, not inferred.** Before migration 099, `terminal_id IS
NULL` meant "back office". Once back-office invoices started *recording* the
till they were captured on, that inference would have quietly moved every one of
them onto a till's run — changing numbers customers already held. Recording a
till and numbering from it are separate questions.

### Configuration

| Function | Notes |
|---|---|
| `numberingConfig(siteId)` | Reads `sales_number_scope` and `store_number`. Anything unrecognised folds to `'site'`, so a typo cannot silently change how a shop numbers |
| `setStoreNumber(siteId, raw)` | **Refused once documents have been issued** — it is printed on invoices customers hold |
| `setNumberScope(siteId, scope)` | Has no UI. New sites are seeded `'terminal'` by migration 064 |
| `hasIssuedDocuments(siteId)` | What that refusal checks |
| `normaliseSegment(raw, fallback)` | Two digits, zero-padded, digits only. A settings row edited by hand to `7` must still produce `INV_07_…` |
| `tillNumber(siteId, terminalId)` | The printed number of one till, or null |
| `tillNumberPrefix(prefix, segments, periodKey)` | Everything before the counter — `INV_01_02_`. Formats a sentinel and cuts the counter off it, so it cannot disagree with `formatNumber` |

**Two digits is a real limit.** A three-digit till would change the shape of
every number issued after it, so ninety-nine tills per store is the ceiling
until somebody decides otherwise deliberately.

---

## 3. Formatting — `src/lib/numberFormat.ts`

**`formatNumber(prefix, number, padding, periodKey, segments?)`** produces all
four shapes:

```
INV000041                 no segments, no yearly reset
INV-2026-000041           yearly reset
INV_01_02_000041          segments
INV_01_02_2026_000041     both
```

Underscores for segments, a hyphen for the year — `INV-01-02-2026-000041` gives
a reader no clue which field is which.

**With no segments the output is byte-identical to what it has always been.**
That is what leaves every document already issued untouched.

**`numberValueOf(documentNumber)`** is the inverse: it takes the **last** run of
digits, so it reads a counter out of every shape above. Returns `null` rather
than `0` when there is none — "unparseable" and "number zero" must not be the
same answer to a caller about to advance a sequence.

This is why segmenting a doc type renumbers nothing: a register spanning the
change still sorts and reprints, because both shapes yield their counter.

---

## 4. Offline sequences — `src/lib/posOffline/saleNumber.ts`

A till with no server has to number a sale itself. It can, **only because the
store is on per-till numbering** — this till owns its own sequence, so it can
advance it locally and no other till can collide with it.

Site-wide numbering makes this impossible. There is no shared cursor to
coordinate over and no number a till could invent that would not risk a
collision, so `nextLocalNumber` returns null and the sale is refused.

| Function | Notes |
|---|---|
| `seedSequence(siteId, seed, kind)` | From the server, on every catalog refresh |
| `hasSequence(siteId, kind)` | Whether this till can trade offline at all |
| `nextLocalNumber(siteId, kind)` | Takes the next number |
| `releaseLocalNumber(siteId, counter, kind)` | Hands one back |

### The three rules

**Seed HIGHER, never lower.** `counter = max(serverNextNumber - 1, localCounter)`.
A till with unsynced sales is *ahead* of what the server knows, so taking the
server's figure would hand out numbers already printed on customers' slips.

**Burn on crash.** `nextLocalNumber` advances the stored counter *before* it
returns. A burnt number is an explainable gap; a reused one is two sales under
one invoice number, which offline has no unique index to catch.

**Release only the last one, only if nothing printed.** `releaseLocalNumber`
takes the counter it expects to be undoing and refuses otherwise. A cancelled
sale whose slip already printed must *burn* its number — the customer may be
holding it.

### Two sequences, not one

`SequenceKind` is `'sale' | 'return'`. A credit note that consumed an invoice
number would leave a gap in the invoice register that nothing explains, and
`verifySequence` would report it as a missing sale.

---

## 5. Master codes — `nextMasterCode` in `sequences.ts`

Customer, supplier and product **codes** — not document numbers. A different
problem: these must not collide with codes a user typed by hand.

So it *probes*. It claims a candidate, checks the table, and moves on if taken —
up to twenty attempts. Returns `null` when the sequence is missing or every
candidate in a reasonable window is taken, and the caller keeps whatever the
user supplied.

**The loop bound is the point.** Without it, a store that hand-typed
`PRD00001..PRD09000` would spin the counter forward one query at a time on every
save. More than twenty attempts means the numbering does not fit the data, and
asking the user to choose a prefix beats hammering the database.

`previewMasterCode(...)` shows the next one without claiming it.

---

## Where a number comes from, end to end

**A sale rung up at a till, online:**

1. `finaliseDocument` asks `numberSegmentsFor` → segments, because it is an
   invoice on a claimed till with `origin = 'till'`
2. `nextDocumentNumber(tx, 'invoice', now, terminalId, segments)` inside the
   posting transaction
3. → `INV_01_02_000041`

**The same sale with no server:**

1. `nextLocalNumber` from the till's seeded local sequence → `INV_01_02_000041`
2. Printed, and queued in the outbox
3. On sync, `adoptDocumentNumber` catches the server's sequence up to it — the
   number is not ours to choose, the customer is holding it

**A purchase order:**

1. `numberSegmentsFor` → `null`, not a counter document
2. `nextDocumentNumber(tx, 'purchase_order', now)` → `SITE_SEQUENCE`
3. → `PO002156`

---

## The traps, collected

- **A missing sequence throws rather than falling back.** Deliberate. Any change
  that gives a till a new segmented doc type needs the rows to exist first — see
  `sql/site/196_till_sequences.sql`.
- **`setStoreNumber` and prefix changes are refused after issue.** They are
  printed on documents customers hold.
- **`verifySequence`'s table registry has been forgotten four times.** Register
  a doc type with its own table *when you add the table*.
- **`origin` decides independently of doc type.** A back-office credit note gets
  no segments even on a claimed till.
- **Two digits per segment.** Ninety-nine tills, ninety-nine stores.
- **Site-wide numbering breaks offline trading entirely** — no local sequence,
  no sale. Migration 064 seeds `'terminal'`; there is no UI to change it.
