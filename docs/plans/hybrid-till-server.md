# The hybrid till server — table sharing that does not need the line

A restaurant runs ten tills. The cloud holds the shop: stock, ordering,
purchasing, accounting, pricing, customers. None of that moves. What moves is
one narrow thing — the **open tab** — onto a small machine in the building, so
that ten waiters can see and edit the same table when the internet is down.

That is the entire feature. It is worth stating plainly because the temptation
is to build something much larger.

This plan also covers two things that arrived alongside it and cannot sensibly
be built separately: **splitting the desktop app into three installers**, and
**provisioning the shop's database from the control panel** so the technician on
site never learns its credentials.

## What this is not

It is **not** the local backend (`docs/local-backend.md`). That inverts the
product: the shop's machine becomes the master, the cloud becomes a binlog
replica, and everything — stock, GL, back office — runs locally. It exists for
customers who want their data on their own premises.

This is the opposite customer. They **want** the cloud to be the master. They
just refuse to have table service stop when the line drops.

So there is no replication here, in either direction. Nothing to reconcile, no
delete-tracking problem, no read-only back office. The in-store box holds open
tabs and an outbox, and forgets them once they are on the books.

A useful way to hold it: the box is a **spool**, not a database of record.

## Why the box exists at all

One failure mode, and only one: *the internet drops mid-service and ten waiters
must still share a table.*

Everything else already survives an outage. The catalog is cached on each till.
Numbering is per-till and runs offline. Sales queue in an outbox and flush when
the line returns. All of that is built and none of it needs a box.

What cannot work device-locally is a **shared** tab. Waiter A opens table 12,
waiter B adds a round, the manager splits the bill at the pass — three devices,
one live bill. Ten independent IndexedDB stores cannot do that without a
peer-to-peer merge protocol, and open tabs are the one case where two people
editing at once is normal rather than exceptional.

One authoritative row, ten thin clients. That is what the box buys, and it is
the only thing it buys.

---

# Part 1 — The three connection types

`cp2_sites.connection_type` is `cloud | local | hybrid`, set in the control
panel, and it is the authority on what a site is.

| | Where the master lives | Shop's own MariaDB | What it is for |
|---|---|---|---|
| **cloud** | Our servers | none | The default. Everything hosted. |
| **local** | The shop's machine | **yes** — holds everything | Customer wants data on their premises. `docs/local-backend.md`. |
| **hybrid** | Our servers | **yes** — open tabs only | Cloud back office, but table service must survive an outage. |

A **hybrid** site therefore has two database records in the control panel:

- **`master`** — the cloud database. The real one.
- **`hybrid`** — the in-store box, flagged **Managed**.

A **local** site has one record, and it is the master, on the shop's machine.

## The managed `hybrid` record

Created by the control panel, and deliberately constrained: **only server host
and port may be changed.** Database name, username and password are what the
shop's installation was configured against, so renaming them in the control
panel would only make the record disagree with the shop.

Worked example (site ODY10000):

```
purpose   hybrid   [Managed]   host localhost:3306
database  ody10000_hybrid       user ody10000_hybrid   password generated
purpose   master               host localhost:3306
database  ody10000_master       user root
```

This record replaces the "per-site box address" field an earlier draft of this
plan proposed. It is better, because the credentials travel with the address
instead of living somewhere else.

## What this repo does not yet read

**`connection_type` does not appear anywhere in this codebase.** `src/lib/sites.ts`
still reads `backoffice_type` (`'windows' | 'cloud'`), and
`electron/runtimeConfig.js` decides cloud-vs-local from an installer marker file
and a build-time default.

So Part 1 is not merely a schema note — **reading `connection_type` is work this
plan has to do**, and it is the first thing everything else depends on.

---

# Part 2 — Three installers, not one

## Why the app splits in two

There are two independent questions, and only one belongs in the control panel:

- **Where does data live?** cloud / local / hybrid → **control panel**, one build.
- **What is this machine for?** back office / till → **two builds**.

The second cannot be a runtime setting. A POS machine must open *straight* to
the clerk PIN with no admin login reachable at all. If one build could be
either, the back-office capability would be present on the machine and merely
hidden — and a franchise manager who knows a URL can reach a hidden thing. Two
builds means it is not there to reach.

## Why the database splits out

MariaDB and the app change on completely different schedules. Bundling them
means every app update re-downloads ~200MB of third-party binaries that did not
change. `electron-builder.yml` already treats them as separate — "deliberately
NOT committed: ~200MB of third-party binaries with their own release cadence" —
and this extends that reasoning from the repo to the installer.

It also means a ten-till restaurant does not put ten copies of a database on ten
machines that will never run one.

## The three artifacts

| Artifact | Contains | Runs where |
|---|---|---|
| **Odyssey Back Office** | App only | Back-office machines |
| **Odyssey Point of Sale** | App only, boots to `/pos` | Tills |
| **Odyssey Database Setup** | MariaDB + provisioning | The one machine that hosts a database |

One codebase, one `electron-builder.yml`, three targets. This **replaces** the
current single "OdysseyAI Back Office" build — it is not a third config
alongside it.

**Naming:** display names drop the "AI" — *Odyssey Back Office*, *Odyssey Point
of Sale*, *Odyssey Database Setup*.

**`appId` stays `za.co.pointofsale.odysseyai`** unless deliberately changed.
It is install/upgrade identity, not a display name: a build with a new appId is
not recognised as an upgrade of an existing install. Confirm before touching it.

## The Point of Sale build

Nearly all of this exists. `(pos)` is already its own route group with its own
layout — no sidebar, no site switcher, no back-office chrome — and that layout
deliberately has **no auth gate**, so it can already serve the public PIN-unlock
screen when a session has lapsed overnight. That *is* the "opens to the clerk
PIN" behaviour.

Three differences from the Back Office build:

1. **Boots to `/pos`**, not `/`.
2. **Refuses to navigate off `/pos*`** — the inverse of the existing
   `isTillUrl()` in `electron/main.js`. Anything else opens externally or is
   denied.
3. **No till-window-in-a-window.** The main window *is* the till, so the
   `setWindowOpenHandler` branch that spawns a separate till window does not
   apply.

First run still needs one admin sign-in, to learn which site and device this is.
After that it caches, and every subsequent launch lands on the clerk PIN.

### This is a product boundary, not a security boundary

Worth stating so nobody later relaxes a check on the strength of it.

A packaged Electron window has no address bar and no devtools, and
`setWindowOpenHandler` already intercepts `window.open`. So a cashier **cannot**
type their way to `/purchasing`. That much is genuinely closed.

What the split does not close: the Next server still serves those routes over
HTTP. On a hybrid site the box is on the shop LAN, so any machine in the
building can reach it with a browser. And nothing about which EXE is installed
stops the same user signing in from a browser elsewhere.

The real boundary is where it already is — `actorForModule` /
`requireModuleCapability` on every action. A POS-only user cannot do back-office
things regardless of which EXE they are sitting at. The two-build split makes
the machine's purpose unambiguous and the wrong thing unreachable in normal use.
That is a real goal. It is not defence against an attacker.

## Odyssey Database Setup

A technician runs it on the machine that will host the shop's database. It asks
for **email and password**, authenticates against the control panel, reads the
site's `connection_type`, and branches:

- **cloud** → nothing to do. Say so plainly and exit. A cloud site has no shop
  database to install.
- **hybrid** → provision MariaDB and create the database and user from the
  **managed `hybrid` record**.
- **local** → the same, from the site's single master record.

### The technician never learns the credentials

This is the point of doing it this way. They type an email and password they
already have; the installer fetches the generated credentials and creates the
MariaDB user from them. They never see the database password, and cannot reach
the database directly afterwards.

Same principle as the DPAPI sealing already in `runtimeConfig.js` — "the
customer cannot read their own database password" made true rather than
aspirational — extended to the person doing the install.

### Re-runnable, on demand only

It reaches the control panel **when a person asks it to**, never on a schedule.

On launch it detects whether MariaDB is already installed here:

- **Not installed** → sign in, read, provision.
- **Already installed** → do not reprovision. Offer **"Retrieve new details"**,
  which signs in again, re-reads the control panel, and reapplies what changed.

That one path covers a host/port change, a moved box, a password rotation, and a
site switched from local to hybrid. It is why the control panel needs no warning
machinery when the managed record is edited — the technician re-runs setup.

### Reapply must never rotate a live password

`provisionLocal()` in `runtimeConfig.js` is already deliberately idempotent, and
says why: "a machine that regenerated its credential on restart would lock
itself out of its own data." The same trap applies here.

"Retrieve new details" reconciles **toward** the control panel's values. It
mints nothing.

### Ordering: the app installer detects and tells

Someone can run the app installer, choose "this machine hosts the database," and
not yet have run Database Setup.

The app **detects and says so** — "Run Odyssey Database Setup first" — rather
than fetching anything. It keeps the three artifacts genuinely independent, at
the cost of a dead end on install day if the technician does not have the file
to hand. Revisit if that proves annoying in the field.

`localDb.isBundled()` changes meaning here: today it answers "did this build
ship with MariaDB?", and it must become "is MariaDB installed on this machine?".
A different question with a different source, and it must fail clearly — a
machine told to host a database that has no database installed should say
exactly that, not surface a connection error.

## The install-time database question

One question, three answers, replacing the marker file and baked build value:

- **Cloud** — no local database.
- **This machine hosts the database** — requires Database Setup to have run.
- **The database is on another machine** — ask for host and port, install nothing.

The third is what a ten-till restaurant uses: one machine hosts, nine point at
it, none of the nine carry binaries they will never run.

---

# Part 3 — What already exists, and is reused unchanged

Most of the tab feature is already written. Recording that precisely matters,
because the risk here is rebuilding things that work.

### Table service — `src/lib/site/posTables.ts`

A full floor implementation: rooms, sections, seats, geometry, visit types,
bill-asked state. The decision that makes it reusable is that **a table holds a
saved sale, not a bill of its own** — `pos_tables.document_id` points at an
ordinary `sales_documents` row with `status = 'saved'`, the same mechanism the
retail till uses to park a basket.

So there is no second kind of unfinished sale, no second set of lines, no second
posting path. A table's bill posts through `finaliseDocument` exactly as a
counter sale does, and every rule about specials, VAT, rounding and stock
applies without being restated.

On a hybrid site that posting happens **in the cloud, on arrival** — the box
never calls `finaliseDocument`. See Part 4.

Occupancy is **derived, never stored**. A table with a document is occupied; one
without is free. There is no status column to fall out of step.

### The claim lease — `sql/site/171_document_claim.sql`

Two waiters cannot pull the same bill onto their screens: `claimed_by` /
`claimed_at` on the document, settled by a conditional UPDATE.

It is a **lease, not a lock**, expiring after fifteen minutes. A till that dies
holding a claim strands the table for at most that window rather than forever.
The migration documents an earlier version that spelled the claim by moving the
document to `draft`, which made the bill vanish off the floor — worth reading
before anyone touches this.

Ten devices on one server is the situation this was written for. It needs
nothing.

### The catalog — `src/lib/posOffline/catalog.ts`

**Stays per-device, unchanged.** Full load once, deltas after — on a normal day
a handful of rows rather than 12 MB. The cursor comes from the server's clock,
never the device's, so a fast till cannot silently skip price changes.

Moving this to the box was considered and rejected. The saving is modest
(deltas are already small), and the cost is severe: if the box dies, ten tills
with no product file cannot sell *anything*. Keeping it per-device means a dead
box degrades the shop to cash-and-carry instead of stopping it.

If bandwidth ever proves a real problem on a large site, the box can become a
caching proxy for the catalog endpoint — same contract, tills unchanged, cloud
still reachable directly as a fallback. Not now.

### Numbering — `src/lib/posOffline/saleNumber.ts`

Per-till numbering is what makes offline numbering possible: each till owns its
sequence, so there is no shared cursor to coordinate and no collision between
the ten. Seeded `max(serverNextNumber - 1, localCounter)` — only ever forward,
because a till with unsynced sales is *ahead* of what the server knows. Numbers
burn on crash rather than being reused. Same formatter as the server.

**Prerequisite:** `nextLocalNumber` returns null when the store is not on
per-till numbering, and the caller must then refuse the sale. So a hybrid site
**must** be on per-till numbering, and the installer must check it rather than
letting it surface as a till refusing a payment mid-service.

### The sync contract — `src/lib/posOffline/sync.ts`, `api/pos/sync/route.ts`

Reused wholesale, with the queue moved from device to box. Its rules are already
the right ones for this:

- a pending row is a sale that **happened** — nothing deletes one;
- oldest first, one run at a time, behind a mutex;
- a **transport** failure aborts the run (says nothing about the sales); a
  **record** rejection marks one row and continues.

That distinction is the whole retry policy. Conflating the two either drops good
sales or retries a bad one forever.

---

# Part 4 — The decisions

### 1. The box holds open tabs and the outbox. Nothing else.

No stock movements, no GL, no audit tables, no catalog mastering, no back
office. The waiter closes the bill, the box captures what was charged, and the
**cloud** does everything that follows: stock, ledger, loyalty, serials, tips,
shifts, audit. Local prunes its copy on a timer.

Stock therefore moves when the sale **reaches the cloud**, not when the waiter
closes the table. That is already how the offline till behaves and is not a new
decision here. The consequence to state to a customer: during an outage, cloud
stock is stale by however long the line has been down, and lands in one go when
it returns. Fine for a restaurant; a real constraint for tightly-controlled or
serialised stock, where two tills can sell the same last unit and only collide
at sync.

Keeping all posting in the cloud is also why the box needs no stock schema. Two
stock ledgers would have to be reconciled against each other, and reconciling
stock across two sources has no clean answer. One ledger, and the box never has
an opinion about it.

The discipline is the outbox rule, unchanged: a row is deletable only once the
server has it.

### 2. The box does not finalise. The cloud does.

`finaliseDocument` (`src/lib/site/salesPosting.ts`) is not self-contained. It
reaches into stock movements, refer breakdown, customer ledger, loyalty,
serials, tips, shifts, sequences, period locks, product composition, credit
rules and deposits — and writes `sales_documents`, `sales_tenders`,
`serial_movements`, `product_serials` and `document_audit`. Putting that on the
box would drag most of the site schema with it, and the box would stop being a
spool.

It does not have to. `src/lib/site/offlineSync.ts` already solves exactly this
for the offline till, and says so plainly: **there is no second posting path.**
An offline sale goes `saveDraft → checkPricing → finaliseDocument` *in the
cloud*, on arrival. The till captures what it charged; the cloud recomputes
every figure and writes any disagreement onto the document as an exception for a
manager. Nothing about money is reimplemented at the edge.

**What the box's schema needs:** `sales_documents`, `sales_document_lines`,
`pos_tables`, the claim columns, the outbox, the lease. **Not** stock, ledger,
loyalty, serials or shifts.

### 3. Pruning is on a timer, not on acknowledgement

Seven days, matching the till's existing `KEEP_SYNCED_DAYS`.

Pruning the moment the cloud acknowledges would mean a reprint an hour later,
with the line down, has nowhere to read from. The bill is on the books but
unreadable in the building where the customer is standing.

### 4. `hybrid` is a third backend mode, and it is a cloud install

`ensureBackend()` in `electron/runtimeConfig.js` resolves the mode at startup,
before `next().prepare()`, writing the answer into `runtime-config.json` and
**never re-deciding**. `hybrid` becomes a third value.

A hybrid till is a **cloud** install in every respect that matters — control DB
in the cloud, sign-in unchanged, cloud secrets. What differs is that tab
reads/writes and the outbox route to the box.

Note this is *not* what local mode does. Local sets `SITE_DB_HOST_OVERRIDE` to
`127.0.0.1` and every site query silently follows. **Hybrid must not**: only two
call paths move, and everything else must keep reaching the cloud.

### 5. One EXE per purpose. No marker files, no baked flags.

Franchises must not be handed different downloads of the same app. So
`connection_type` comes from the control panel at sign-in and is cached.

`resolveInitialBackend()` currently resolves: env var → `backend.txt` marker
beside the executable → baked build value → default cloud. Two of those four are
exactly what must not decide hybrid.

They were right for the **local** backend, where the decision genuinely must
precede first run: a local install provisions its own MariaDB and mints its own
secrets, and may have no control DB to ask. Chicken and egg.

**Hybrid has no such problem.** It is a cloud install; it can always ask. So
`backend.txt` and the baked value stay for the local case, and hybrid does not
use them.

Turning hybrid on or off is a control-panel edit picked up at the next sign-in.
No reinstall in either direction.

### 6. The bootstrap trap, and the fix

A device reads its configuration *after* it signs in — but the point of the box
is surviving an outage, and a till that cannot reach the cloud at startup cannot
learn that a box exists. It would fall back to cloud-only offline mode and lose
table sharing at exactly the moment it matters.

This is the same trap `runtimeConfig.js` already documents for
`backoffice_type`. Same fix:

1. the control panel is the authority;
2. the till **caches** connection type and the managed record's host/port into
   `runtime-config.json` on every successful sign-in;
3. startup reads the cache first, reconciling when the line is up.

**First sign-in needs internet.** That is unavoidable — a device that has never
spoken to us cannot know anything about its site — and it is an install-day
action with an engineer present. Every start after that works offline. It
belongs in the install checklist, not in a support call.

### 7. A hybrid till that cannot reach its box still trades

Box off, cable out, wrong host typed in the control panel. The till trades
cloud-only cash-and-carry, with a clear indicator that table sharing is
unavailable.

Refusing would turn a cabling mistake into a shop that cannot take money.

### 8. The address accepts a hostname or an IP

The managed record's host field is free text, because the two differ in *when*
they resolve. An IP is a fact baked into ten devices; a hostname is a question
asked fresh at each connection, so the address can change without the tills
caring.

Shops get addresses by DHCP, and routers hand out leases. A power cut can bring
the box back on a different IP, and ten tills then point at nothing mid-service.
A hostname survives that — but needs something to answer it, and the usual
candidates (mDNS `.local`, router DNS, hosts files) are each either flaky on
cheap switches or per-device setup.

So: **accept either, and put a DHCP reservation on the box in the install
checklist.** Two minutes on install day, and the address genuinely never moves.
Accepting a hostname costs nothing — same connection string — and lets a
well-run site use one.

### 9. The lease lives on the box, one per site

The seven-day lease (`src/lib/licence/lockState.ts`) answers "has this machine
been offline too long?", so it must be readable **while offline**. A hybrid till
can reach exactly one thing with the line down: the box.

One lease per site, not ten. The box renews once for the shop and all ten tills
read it. Ten separate leases would drift — three tills locking on Tuesday and
the rest on Thursday is confusing to support and worse to explain to a customer.

`checked_at` / `expires_at` stay **separate columns**, unchanged. An unlock
extends how long a machine may run without claiming a conversation happened, so
a shop silent for three weeks still reads as silent for three weeks. That is
what keeps a non-payer visible instead of being laundered clean by support calls.

This is what switches off a shop that stops paying. The check is at **startup**,
not real time — a SaaS product must be able to stop, but ten tills polling a
licence server continuously is load nobody needs. The lease expiring is the
mechanism.

`keepsLease()` currently returns true for `APP_MODE === 'desktop'` and reads the
local site DB. Hybrid is desktop but has no local site DB in that shape, so it
reads from the box. A routing change in one function, not a redesign.

`DesktopLicenceGate` keeps its job — the live check, with its deliberate
fail-open in three places. The lease answers the separate question of whether an
**offline** machine has been offline too long, which is why it is evaluated
server-side where the answer does not depend on a network call that can fail
permissively.

The telephone unlock is unchanged: an agent unlocks the site, the box holds it,
ten tills see it.

**Fail open when both are down.** Box down *and* line down means the lease
cannot be read at all — trade anyway. A box that is down already means
cash-and-carry, and a shop refused service because two things broke at once is
the worse failure.

### 10. Device-local offline becomes the fallback, and the precedence is explicit

This is the one genuinely new *behaviour*, and the likeliest source of a bug.

Today each device holds its own tabs, deliberately invisible to other tills —
`parkOffline.ts` says so and explains why. In hybrid, tabs move to the box so
all ten share them, and the device-local path becomes the fallback for a box
that cannot be reached.

Which means a tab could exist in both places. The rule:

- **Box reachable → the box is the only truth.** The device does not write tabs
  locally at all.
- **Box unreachable → the till falls back to device-local**, and those baskets
  are marked local, exactly as the recall list already marks them.
- **A device-local basket never migrates to the box.** It is recalled at the
  till that took it, like an offline parked basket today.

Uploading them would mean inventing bills on the box for baskets that may be
abandoned, then reconciling against tabs the same till opened online — two
sources for "what is open here", which is how a badge comes to disagree with its
own list.

The honest cost, worth telling customers: **tabs opened while the box was down
are visible only on the till that opened them.**

### 11. The full Next build runs on the box

A narrow API surface would mean a second implementation of tab handling, and two
implementations drift. That is the same failure `offlineSync.ts` refuses when it
declines a second posting path.

Same build, configured to hold less.

### 12. Plain HTTP on the LAN, bound to the LAN interface

TLS needs a certificate. On a shop network that means either self-signed —
warnings, and pinning on every device, which is the per-device setup this
feature exists to avoid — or a local CA, which is real infrastructure in a
restaurant.

The traffic is tabs and menu lines on a private network, and the session cookie
already does the authenticating. The box binds to the LAN interface and nothing
else; it is not internet-reachable.

Revisit if a customer's compliance requires it. Not by default.

### 13. WebSocket push, reusing `server/wsFrame.mjs`

Polling ten tills against one box spends the latency the box was bought for, and
a waiter looking at a stale table is precisely the failure this feature exists
to prevent.

The framing is already hand-rolled in this repo for the replication tunnel, and
this is the same shape of problem: a long-lived connection carrying small
updates. Reuse it rather than adding a dependency.

---

# Part 5 — The failure model, stated for the customer

- **Internet down, box up** — full table service. Sales queue and flush later.
  This is the case the feature exists for.
- **Box down, internet up** — cash-and-carry on every till. Catalog is local,
  numbering is local, sales go to the cloud. No shared tabs.
- **Both down** — cash-and-carry, device-local, lease fails open.

The single point of failure for *table sharing* is the box, and that is
inherent: one authoritative copy of a live tab is what makes sharing work. The
box should be a reliable small machine, not a repurposed desktop under the
counter.

This is already how the legacy product is sold, and customers accept the trade
knowingly.

---

# Part 6 — Scope

**In:** reading `connection_type`; the hybrid backend mode and its config
caching; routing tab reads/writes to the box; the outbox on the box; the
per-site lease; the fallback precedence rule; three installers replacing one;
Database Setup with control-panel provisioning.

**Out:** replication of any kind; moving the catalog; changing numbering;
back-office functionality on the box; any change to `posTables.ts` or the claim
lease; any change to the web build.

**Electron only.** A browser hitting the cloud app behaves exactly as it does
today. The hybrid flag only ever affects Electron installs.

---

# Part 7 — Files

Written against what exists today; sequence matters more than exact paths.

### Reading the control panel

- **`src/lib/sites.ts`** — read `connection_type` alongside `backoffice_type`.
  Nothing in this repo reads it yet. Everything else depends on this.
- **The managed record** — resolve a hybrid site's `hybrid`-purpose row for its
  host, port and credentials. `src/lib/siteDb.ts` already routes site
  connections by `(siteId, purpose)`, which is the shape this needs.

### Electron

- **`electron-builder.yml`** — three targets replacing one. Display names drop
  "AI"; `appId` unchanged. MariaDB moves out of `extraResources` into the
  Database Setup target.
- **`electron/runtimeConfig.js`** — `hybrid` mode; cache connection type and
  managed host/port; do not take local mode's `SITE_DB_HOST_OVERRIDE` path.
- **`electron/main.js`** — POS build boots `/pos` and refuses to leave; no
  till-window-in-a-window; box reachability check feeding decision 7.
- **`electron/localDb.js`** — `isBundled()` becomes "is MariaDB installed here?".

### Odyssey Database Setup

- Sign-in, `connection_type` read, provisioning from the managed record,
  "Retrieve new details", and the never-rotate rule.

### The box

- **Schema** — `sales_documents`, `sales_document_lines`, `pos_tables`, claim
  columns, outbox, lease. Nothing else.
- **The outbox** — port `src/lib/posOffline/sync.ts`'s rules server-side,
  pushing to the existing `api/pos/sync` contract.
- **Tab routing** — the one place that decides box-vs-cloud.

### Licensing

- **`src/lib/licence/lockState.ts`** — `keepsLease()` and the lease read for
  hybrid.

### Control panel (outside this repo)

- Per-till-numbering check before a site can be set hybrid, so it cannot be
  provisioned into a till that will refuse payments mid-service.

---

# Part 8 — Open questions

- Whether the hybrid flag needs anything on `cp2_devices` at all, now that
  `connection_type` is per-site. An earlier draft proposed a per-device flag;
  the site-level type may be sufficient, which would avoid altering a table the
  v2 backend owns (see `sql/tickets/005_pos_device_licensing.sql`, which is
  explicit that altering it is an exception, not a habit).
- Exactly which columns of `sales_documents` the box needs, versus which are
  only meaningful once posted.
- Whether Database Setup should also verify per-till numbering, or leave that to
  the control panel.
