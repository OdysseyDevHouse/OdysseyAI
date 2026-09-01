# SQLite on the Android till

The Android till keeps its catalog, its outbox and its parked sales in
IndexedDB. This plan moves that storage to SQLite **on Android only**, behind one
interface, and changes nothing else about how the till behaves.

The target is PARITY: everything the Dexie till does offline today, done the same
way on a different engine. The reasons are, in order of weight — a sale in the
outbox must survive an operating system that is entitled to delete it; a large
catalog must stay quick on weak hardware; and no offline capability may be lost
along the way.

It is written to be argued with, and it says plainly which of those a database
can deliver and which it cannot.

## What is already built, and is not being rebuilt

A till that has synced once already trades through an outage. This is not a
greenfield offline story — it is a storage engine decision inside a working one.

| Piece | Where it lives |
|---|---|
| Offline shell — the app OPENS with no network | `public/pos-sw.js`, registered by `useOfflineShell.ts` |
| Catalog cache, outbox, parked sales, drafts, returns | Dexie/IndexedDB, `odyssey-pos-{siteId}` |
| Per-till numbering, so an offline sale gets a number | `seedSequence`, seeded from the catalog response |
| Cashier PIN sign-in with no line | `offlineOperators.ts` verifiers |
| Queue-and-flush for completed sales | `finaliseOffline.ts`, the `outbox` store |

`docs/plans/hybrid-till-server.md` states the same position: *"The catalog is
cached on each till. Numbering is per-till and runs offline. Sales queue in an
outbox and flush when the line returns. All of that is built."*

Two things follow. The service worker is untouched by this plan — it caches the
SHELL, and the shell has nothing to do with where rows are kept. And the
sync protocol is untouched: `refreshCatalog` keeps its cursor, its schema gate
and the `productTotal` audit added in `a6bc920`.

## The one thing SQLite genuinely fixes

**IndexedDB in an Android WebView is evictable.** The OS may clear site data
under storage pressure, and `navigator.storage.persist()` is not reliably
granted in a WebView. Against that sits the rule `posOffline/db.ts` states in
its own header:

> A `pending` row is a sale that HAPPENED. The customer has the goods and the
> drawer has the cash; the only record of it is here.

So today the only record of an unsynced sale sits in a store the operating
system is entitled to discard. Nothing in the app would report it: the till
would simply open one morning with an empty outbox and a correct-looking screen.
That is the case for SQLite, and it is sufficient on its own. A database file in
app-private storage is not subject to eviction, is backed up on the app's terms,
and can be copied off the device for recovery.

The catalog half of the same database is a cache and does not need this. It
comes along because splitting the two across two engines would be worse than
either.

## What SQLite does NOT fix, and must not be sold as fixing

`offlineCapability.ts` already enumerates what a till refuses when the line is
down. **None of it is a storage limit.** Every entry is a correctness limit that
a local database — any local database — makes no difference to:

| Refused offline | Why no local store can settle it |
|---|---|
| Account tenders | Needs a credit check against a balance only the server knows. A stale balance is how a shop extends credit to somebody who has exhausted it. |
| Loyalty redemption | Spent by functions that THROW, so an unaffordable redemption rolls the sale back. Offline there is nothing to roll back into. |
| Gift cards (tender and product) | The `FOR UPDATE` that stops two tills draining one card has no offline equivalent. Two offline tills each sell the same balance. |
| Serial-tracked products | Deciding locally which physical unit went out, and hoping the server agrees. It will not always: another till can sell the same serial. |
| `recipe` / `refer` products | `resolveComponents` walks the composition tree five levels deep and can legitimately refuse. A `normal`-method refer may break a larger pack open, and which pack depends on live stock at every level. |

These are shared-authority problems. The answer to them is a shared authority —
which is exactly what `docs/plans/hybrid-till-server.md` proposes for open tabs,
and the same reasoning applies here. **SQLite on the device moves none of them.**

So "full independence from the server" has a ceiling, and the ceiling is a
product decision rather than an engineering one: how much of the shop's takings
may be transacted against stale knowledge. `pos_offline_account_sales` already
exists as exactly that decision, defaulted OFF, for accounts alone. If
independence is to grow, it grows by a shop owner accepting risk on named
categories — not by changing where rows are stored.

**And that settles driver three.** The goal is PARITY: the same offline
capabilities the Dexie till has today, on a different engine. Nothing in the
table above becomes allowed, nothing becomes refused. If the offline ceiling is
ever to rise it is a separate conversation about acceptable commercial risk —
see `docs/plans/hybrid-till-server.md`, which is where a shared authority
belongs — and it is not this plan.

## The scope decision, and its cost

Android gets SQLite. Chrome and Electron keep Dexie. Both sit behind one
interface.

This is worth stating honestly: **it means two persistence implementations**, and
this codebase argues against exactly that, repeatedly and for good reason —
`browseForTill` is shared rather than copied, `signIn` is reused by the mobile
route rather than reimplemented, and `tillCatalogTotal` shares `LIVE_GROUP_ONLY`
rather than restating it. The stated fear is always the same: the copy that
drifts is the one guarding the door.

The mitigation is to make the duplicated surface as small as it can be, and to
put nothing but persistence inside it:

- **Policy stays shared.** What a sale is, what may be sold offline, how the
  cursor advances, when a full load is forced — all of it stays in
  `catalog.ts`, `finaliseOffline.ts` and `offlineCapability.ts`, untouched and
  engine-agnostic.
- **The port is rows in, rows out.** No engine-specific concept crosses it.
- **One test suite, two engines.** The same cases run against both
  implementations, so drift is a failing test rather than a support call.

**And this shape is already proven here.** `lib/site/boxOutbox.ts` is the
till's outbox reimplemented server-side against MariaDB for a hybrid shop, and
its header states the rule this plan follows:

> the STORE differs — Dexie there, MariaDB here — but nothing about the POLICY
> changes

So a second store behind one policy is an established pattern in this codebase
rather than a new risk being taken. The surface is also smaller than it looks:
exactly one file imports Dexie (`posOffline/db.ts`), and only six touch
`posDb` — `cancelOffline`, `catalog`, `db`, `draftOffline`,
`parkOffline`, `sync`. Everything else already goes through helpers that
`db.ts` exports, which is the port in all but name.

The alternative — SQLite everywhere via wasm and OPFS — was considered and
rejected; see "Settled, and why" below for the three reasons. This section
records what the chosen split COSTS, so it can be revisited later with the
trade-off visible rather than forgotten.

## Design

### The port

Extract from today's Dexie usage the operations the till actually performs, and
nothing speculative:

```
products   replaceAll(rows) · upsert(rows) · deleteByIds(ids) · count()
           byId(id) · byBarcode(code) · byDepartment(id) · search(term, limit)
kv         get(key) · put(key, value) · delete(key)
outbox     append(sale) · pending() · markSynced(ids) · countByStatus()
parked     put · list · byUid · delete
drafts     put · list · byUid · delete
returns    append · pending · markSynced
```

Two rules the interface must carry, because they are correctness rather than
convenience:

1. **A full catalog load is atomic.** `replaceAll` clears and repopulates in one
   transaction. Today's Dexie transaction is what stopped an interrupted sync
   leaving a half-catalog; SQLite must keep that property, not merely imitate it.
2. **Nothing deletes a pending outbox row.** Not a schema upgrade, not a prune,
   not a "clear cache" convenience. `posOffline/db.ts` states this rule for
   Dexie; the SQLite schema inherits it verbatim, and every future version of it
   may drop synced rows and must not touch pending ones.

### Schema

Tables mirroring the stores, plus the indexes the current grid and scan paths
need: `products(barcode)`, `products(code)`, `products(department_id)`, and an
FTS5 virtual table over `description` for the search box. FTS5 is the part that
speaks to the performance driver; it is also the part that must not be assumed
to help until measured.

`PRAGMA journal_mode=WAL`. For outbox writes specifically,
`PRAGMA synchronous=FULL` and one explicit transaction per sale — a sale is
worth an fsync.

### There is nothing to migrate

No shop is running this yet, so there is no installed outbox to rescue and no
staged cutover to design. A build either uses SQLite on Android or it does not.

This is worth writing down because it will stop being true. The moment one till
is trading, an engine change becomes a data-migration problem with real money in
it — an unsynced sale is the only record of goods that have left the shop. The
cheap moment to make this change is now, and that is the reason to make it now.

### Platform detection

One check — the SQLite plugin is available and its database opens — decided once
at startup and held. Never per-call, and never inferred from user agent: the
same bundle runs in Chrome on the same site.

## Sequencing

**Phase 0 — Measure.** We have never profiled this till. Today's "POS feels
laggy" turned out to be dev-mode overhead (5.44 MB of JavaScript against 0.85
MB), not storage. Before optimising storage for performance, get numbers on a
real Sunmi: catalog load, department open, search keystroke latency, sale
finalise. Without them, phase 3 cannot be judged.

**Phase 1 — The port, with no behaviour change.** Introduce the interface, keep
Dexie as its only implementation, ship it. Nothing about the app changes; if
anything does, the port is wrong. This is the phase that makes the rest
reviewable.

**Phase 2 — SQLite on Android.** Implement the port with
`@capacitor-community/sqlite` (Capacitor 8 in this repo — `@capacitor/core`
^8.5.0 — so a v8-compatible release is required; `minSdkVersion` is 24, which
the plugin supports). No migration: the store starts empty and the first catalog
sync fills it, exactly as a new till does today. Confirm an outbox survives an
app kill and a storage-pressure event before calling it done.

**Phase 3 — Performance, judged against phase 0.** Indexes and FTS5, measured
rather than assumed.

**Phase 4 — Independence, separately scoped.** See the section above: this is a
product conversation about acceptable risk per category, not a storage change.

## Risks

- **Two implementations drift.** The mitigation is one test suite over both. If
  that suite is not written, this plan has failed regardless of what ships.
- **The free window closes.** With no customers there is no migration to write.
  That is true today and not next month, which is the argument for doing this
  before the first shop trades rather than after.
- **The plugin on old Android.** The test device is a Sunmi T2 running Android
  7.1.1 with Chrome 119 WebView. Verify on that hardware, not on a modern phone.
- **Encryption at rest is an open question.** A till holds customer names and a
  day's takings on a device that can be stolen. IndexedDB is not encrypted
  either, so this is not a regression — but SQLite makes it addressable
  (SQLCipher), and the decision should be taken deliberately rather than by
  default.
- **iOS diverges.** This plan leaves iOS on IndexedDB. When the iOS shell is
  built (`docs/mobile-app.md`, Still to do), it inherits the port and can adopt
  the same plugin.

## Settled, and why

**Android gets SQLite; Chrome and Electron keep Dexie.** The alternative
considered was SQLite everywhere via wasm and OPFS. It was rejected on three
grounds, the third being decisive:

1. OPFS sync access handles are only available inside a WORKER, so the storage
   layer would become async message-passing rather than a direct call.
2. `sqlite-wasm`'s fast `opfs` VFS needs COOP/COEP cross-origin isolation,
   which is an app-wide switch that breaks third-party images, iframes and
   payment-gateway flows. The `opfs-sahpool` VFS avoids that but allows one
   connection per pool, which needs care across tabs.
3. **OPFS is still browser storage and is evicted like IndexedDB.** So on Chrome
   and Electron it would buy a different engine over the same evictable
   substrate — no durability gain, which is the whole point of the exercise.

Browser support itself is not the objection: OPFS sync access handles are
available in Chromium 108+, Firefox 111+ and Safari 16.4+, all requiring a
secure context, which the till already needs for its service worker.

The native Android file is the only place SQLite removes eviction, so that is
the only place it is used.

## Decided

**No encryption at rest.** SQLCipher was considered and declined. IndexedDB is
not encrypted either, so plain SQLite is not a regression, and the device is
already a trusted till holding a signed-in session. If a shop ever needs it —
a franchise handing tills to staff who take them home, say — SQLCipher is a
drop-in for the same plugin and can be added without touching the port.

## Follow-ups, after the engine lands

**Load the engine lazily, per platform.** Both implementations will otherwise
ship in one bundle to every client: an Android till downloading and parsing
Dexie it will never call, and a Chrome till doing the same for the SQLite
adapter. A dynamic import behind the platform check fixes it, and the device
that benefits most is the weak one — measured on this app, a production bundle
is 0.85 MB against 5.44 MB in development, so JavaScript weight is not
theoretical on a Sunmi. Deliberately NOT done in the first pass: it is an
optimisation, and doing it while the port is still moving would make a
behaviour bug and a loading bug look alike.

