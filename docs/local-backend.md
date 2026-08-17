# The local backend

A desktop install that keeps the shop's database on the shop's own machine,
rather than on a server we run.

Everything the till and the back office need is local: stock, prices,
customers, the day's takings. The control panel keeps exactly two jobs — saying
who may sign in, and saying what the shop has paid for — and the machine can
carry on without it for seven days.

---

## Cloud or local

`cp2_sites.backoffice_type` is `'windows' | 'cloud'`. It has existed and been
displayed for a long time; this feature is what finally acts on it.

It cannot be the answer on a machine's **first** run, though. Reading it needs a
connection to the control database, and on a local install the whole point is
that we may not have one — a customer whose line is down during installation
would silently be provisioned as a cloud site. So:

1. **The installer carries the decision.** A `backend.txt` file next to the
   executable containing `local` or `cloud`, or `BACKEND` in the build's
   `buildDefaults.json`. That is a fact known at download time, because the
   customer downloaded from a link we generated.
2. **The control panel confirms it afterwards**, on first successful sign-in.
3. **A mismatch goes to support** rather than being corrected. Switching a
   running shop between backends means moving its data, which is not something
   an app should do to itself at startup.

Absent any marker: **cloud**. Every install in the field today keeps working
exactly as it does now.

For development and support, `ODYSSEY_BACKEND=local` overrides everything.

---

## Building an installer that includes the database

The MariaDB binaries are **not committed** — around 200MB of third-party
binaries with their own release cadence.

```
# 1. Download the Windows portable ZIP (not the MSI) from mariadb.org
# 2. Unpack so that the binaries land here:
vendor/mariadb/bin/mariadbd.exe
vendor/mariadb/bin/mariadb.exe
vendor/mariadb/bin/mariadb-install-db.exe
vendor/mariadb/bin/mariadb-admin.exe
vendor/mariadb/share/...

# 3. Mark the build as local, then build
echo local > build/backend.txt
npm run dist
```

`electron-builder.yml` copies `vendor/mariadb` to `resources/mariadb`. A `from:`
that does not exist is skipped, so a **cloud-only build needs nothing in
`vendor/`** and is unchanged by all of this.

`localDb.isBundled()` checks for the server binary at startup and reports a
clear error if a local build somehow shipped without it, rather than failing
later with a confusing connection error.

---

## What happens on a customer's machine

**First run** (once, roughly a minute — `starting.html` narrates it):

1. `runtimeConfig.ensureBackend()` sees the marker and provisions.
2. Generates a database password, a root password, a session secret, an
   encryption key and a backup key. All sealed with DPAPI, so the ciphertext is
   bound to that Windows account.
3. Picks a port in `33060–33359`. **Not 3306** — a customer who already runs
   MySQL must not have their server shadowed or ours refuse to start.
4. `mariadb-install-db` creates the data directory under
   `%LOCALAPPDATA%\...\mariadb\data`.
5. Starts `mariadbd` bound to `127.0.0.1` only.
6. Creates the app's user and the control database, then takes away root's
   passwordless access.
7. The Next server starts with all of that in `process.env`.

**Every run after:** the same, minus steps 2–4 and 6. Idempotent throughout —
provisioning never rotates a credential the database is already using, which
would lock the machine out of its own data.

### The data directory is sacred

It is initialised **once**, on a machine that has never had one, and after that
only ever started. There is deliberately **no repair path**: re-initialising is
indistinguishable from erasing the shop's trading history. A directory that
exists but will not start is an error somebody must be told about.

---

## The seven-day lease

A local machine can trade offline, but not forever — otherwise a licence could
be evaded by unplugging a network cable.

Every successful conversation with the control panel writes a `licence_lease`
row: what was held, and **when it was last confirmed**. When the control panel
cannot be reached, the app reads the lease instead of guessing.

- `checked_at` moves **only** on a real, successful round trip. Not on a cached
  read, a restart, or an unlock. Nothing available to the machine locally can
  renew its own lease.
- `expires_at` is stored separately, so an unlock can extend how long a machine
  may run **without** claiming a conversation happened.

Under two days remaining, screens warn. Past expiry, the machine locks to one
screen that explains itself.

### Why the lock is decided on the server

`DesktopLicenceGate` fails open in three places by design — no device id passes,
a rejected check passes, a pending check renders the app — and each is right for
what it does. But it means an offline machine sails straight through, and an
offline machine is the only kind this rule is about. So `lockState()` decides
server-side, where the answer does not depend on a network call that can fail
permissively.

---

## Unlocking a machine over the telephone

A machine that has a connection never locks — it renews automatically. So the
only useful unlock is one that needs **no connection at all**, and the internet
is only on our side of the call.

**The customer** reads out the code on their locked screen.
**The supervisor** types it into Setup → Tills → *Unlock a machine over the
phone*, and reads back the response.
**The machine** verifies locally and extends its lease by 14 days.

Both ends hold a secret planted while the machine was online. The response is an
HMAC over it, so:

- **Machine-specific** — a code for one till is refused by every other.
- **Single-use** — the redeem counter feeds the challenge, so redeeming changes
  the next challenge and kills the code just used.
- **Time-boxed** — it extends, it does not clear the requirement.

The alphabet omits every character people mishear reading aloud: no `0/O`, no
`1/I/L`, no `5/S`, no `8/B`, no `2/Z`. Dashes, spaces and case are all ignored
on input.

### What this cannot do

It cannot stop **our own support desk** keeping a non-paying shop trading a
fortnight at a time. Granting access without verifying anything over the wire is
the entire premise, and no cryptography changes that.

`cp2_unlock_grants` is the actual control: every code names the supervisor, the
site, the machine and the moment. The count is shown to the agent **while they
are deciding**, because a shop on its fourth unlock is not a connectivity
problem. The grant is written **before** the code is handed over, and a failure
to write refuses the grant — an unrecorded unlock is the only kind that defeats
the point.

---

## Signing in with the line down

Every password read in `auth.ts` targets `cp2_users`. On a local backend that
would mean a shop with a dead line cannot open its own back office, with all its
data sitting on the machine in front of it.

So a verifier is mirrored into `offline_signin` after each **successful online**
sign-in — PBKDF2 under an HMAC salt, the same construction the till's PIN uses.
The bcrypt hash is deliberately **not** copied down: at cost 10 it is
offline-attackable by anyone who reaches the database, and unlike a PIN a
back-office password is often reused elsewhere.

Two rules make it safe:

- **Only a successful online sign-in mints a verifier.** A user who has never
  signed in on that machine cannot sign in offline. That is correct, not a
  limitation.
- **A verifier older than seven days is refused**, because a password changed
  upstream while the machine was offline would otherwise keep working forever.

Two deliberate consequences:

- **No `claimSession`.** The one-live-session registry lives in the control
  database, so while offline an account could be signed in in two places.
- **2FA users get no offline sign-in.** That half of the flow never sees the
  password, and admitting them anyway would silently drop the second factor they
  turned on.

---

## The cloud replica

A live, queryable copy of each shop's database on our servers — for head-office
reporting and for support to see real data without asking a customer to read
figures down the phone.

**This is MariaDB's own replication, not an application sync**, and the reason
is worth keeping written down because "just ship changed rows" looks simpler
every time somebody re-reads this.

The schema has **no delete tracking**: no `deleted_at`, no tombstones anywhere
across 238 tables, and deletes cascade widely. Only 58% of tables have
`updated_at`, and the missing ones include `sales_document_lines` and
`stock_movements`. A watermark-based sync would copy every insert and update
faithfully and **never once see a delete** — so a voided sale's lines would
vanish locally and live forever in the cloud. The replica would drift quietly,
and a reporting database that is silently wrong is worse than none, because
people trust it.

The alternative to fix that — full-key reconciliation across ~200 mutable tables,
nightly, over a shop's ADSL line — is not viable.

The binary log has none of these problems. It records every change the server
actually made, deletes included, needs no `updated_at`, no triggers, and no
per-table code.

### How it is configured

On the shop's server (`electron/localDb.js`):

```
--log-bin=odyssey-bin
--binlog-format=ROW      # not STATEMENT: ships row images, not SQL to re-run
--server-id=<site id>    # unique per shop, so the far end is unambiguous
--expire-logs-days=7     # matches the lease; a machine offline longer is locked
--max-binlog-size=64M
--sync-binlog=1          # a power cut must not lose the tail of the log
```

`ROW` format matters: `STATEMENT` replays the SQL, so anything
non-deterministic (`NOW()`, an `UPDATE ... LIMIT` without `ORDER BY`) can produce
different rows on the replica. `ROW` makes it a copy rather than a re-enactment.

The replica connects as `odyssey_repl`, which holds **`REPLICATION SLAVE` and
nothing else** — it cannot `SELECT` a table, write, or read the schema. That is
deliberate: it is the one account reachable from outside the shop.

### The tunnel

Replication normally has the replica dial the master. That cannot work here — the
master is a PC behind a domestic router, on a dynamic address, often behind
carrier-grade NAT. Nothing can reach it, and configuring a shopkeeper's router is
not an installation step.

So the direction is inverted: **the shop dials out to us** over a WebSocket
(`electron/replicationTunnel.js`), and the replica reads back down it. The shop's
server stays bound to `127.0.0.1` throughout.

The tunnel knows nothing about replication — no binlog positions, no SQL. It
dials, authenticates, forwards bytes, notices drops, and redials with capped
exponential backoff plus jitter, so an outage that hits the whole estate does not
produce a thundering herd when it clears.

### How reports reach it

`cp2_reporting_replicas`, **not** a row in `cp2_site_databases`. That table
already supports several databases per site through its `purpose` column, and
adding `purpose = 'reporting'` would have been three lines — it was rejected
deliberately.

Everything that reads `cp2_site_databases` does so to **write** as well: it is
the connection the till posts sales through and every server action mutates. A
replica must never be written to. Keeping it in a separate table means
`siteQuery()` *cannot* resolve to a replica, because `sitePool()` does not look
there. The separation is the safety property; a shared table with a flag would
have relied on every caller remembering to check it.

The report engine has exactly one place it reads rows
([`run.ts`](src/lib/reportBuilder/run.ts)), so redirecting it is one seam:

```ts
const read = options.reader ?? (await reportSourceFor(siteId)).reader
```

Resolved inside the engine rather than at the six call sites, so no caller has
to remember. `reportSourceFor()` returns the site's own database for a cloud
site and the replica for a local one — and reports, exports, the API, scheduled
sends and the AI path all inherit it with no change.

A lagging replica is **labelled, not refused**: `stalenessNote()` produces
"Figures are about 20 minutes behind the shop." A head office with clearly-dated
figures can work; one with nothing cannot, and a silently stale number is worse
than either.

### The cloud side: one long-running process

```
node --env-file=.env server/replicaHost.mjs     # or: npm run replica:host
```

**Not part of the Next app**, and cannot be. It does two things a route handler
cannot: an HTTP upgrade to WebSocket (Next never exposes the raw socket), and
streaming a several-hundred-megabyte body to disk without buffering it.

It authenticates a shop against `cp2_local_backends` — the same credential the
machine escrowed at first contact, so there is no second secret to keep in step
— then moves bytes. It never speaks the MySQL replication protocol and never
holds a backup key, so **it cannot read a customer's data**. That is what makes
it safe to run on the edge of the network.

| Route | Purpose |
| --- | --- |
| `GET /health` | Unauthenticated, names nothing. For a load balancer. |
| `PUT /backup/{folder}/{file}` | Takes a nightly archive, streamed to disk |
| `Upgrade:` on any path | The replication tunnel |

The archive path is derived from the **authenticated** identity, never from
anything the client sent, so no request can write into another site's folder.
Folder and file names are checked against an allowlist rather than sanitised —
stripping `../` is whack-a-mole; an allowlist is not.

The WebSocket framing is hand-rolled (`server/wsFrame.mjs`) rather than taken
from `ws`. This is not a general WebSocket server: it accepts binary frames
from one known client and forwards them. Against a dependency on the one
process that terminates connections from every shop, a few dozen lines of a
well-specified protocol is the smaller thing to own. It is verified against
Node's own conformant client, including 2MB across many TCP reads and 400
coalesced frames — the case a naive parser passes small and corrupts under load.

### Provisioning a replica

```
node --env-file=.env scripts/replica-provision.mjs <siteId> [--device <serial>] [--dry-run]
```

Creates the database and its two accounts — an **applier** that writes (applying
a binary log is writing) and a **reader** with `SELECT` and nothing else — then
records the row. It refuses a cloud site, refuses a site with no local install
on record, and refuses to re-provision over an existing replica.

It deliberately stops there and prints what to run next. Seeding needs a dump
taken at a known binlog position, and that dump has to travel from the shop on
the shop's line — it never pretends to have done the half that needs them.

### A replica is not a backup

If a bug deletes rows on the shop's machine, replication **faithfully deletes
them in the cloud too**. That is what replication is for. The encrypted nightly
archive below is the point-in-time copy, and it is the only thing that survives
operator error or corruption. Both are needed; they do different jobs.

### What is not replicated

Credentials and device-bound state, which are meaningless or actively wrong off
the machine: `offline_signin` and `user_offline_verifiers` (device-bound
verifiers), `users.pin_hash`, `api_keys`, `webhook_endpoints.secret`,
`tender_integrations.secrets_enc`, `payment_gateways` keys, `licence_lease`
(carries `device_serial` precisely so a copied database cannot present another
machine's lease), `document_sequences` (per-terminal counters — replicating them
causes duplicate document numbers), and the `offline_*_claims` idempotency
ledgers.

Filtered at the **replica**, with `replicate-ignore-table`, rather than at the
shop: the shop's binlog must stay complete, because it is also what a
point-in-time restore replays.

---

## Backups

`backup.mjs` makes the nightly dump and uploads tarball. `backup-push.mjs` sends
it, **encrypted on the machine** with the shop's own key, so we store ciphertext
we cannot read.

```
node --env-file=.env scripts/backup.mjs
node --env-file=.env scripts/backup-push.mjs
node --env-file=.env scripts/backup-push.mjs --dry-run   # inspect, don't send
```

`--dry-run` leaves the encrypted files on disk and prints where, so a restore can
be rehearsed before a night's backup is trusted to it.

AES-256-GCM, streamed, fresh IV per file, layout `iv(12) || ciphertext ||
tag(16)`. The recorded SHA-256 is of the **plaintext**, so a restore can prove it
decrypted to the bytes that were backed up.

It refuses to run without a key rather than uploading in the clear, and refuses
to send a backup whose own manifest reported failures.

**The backup key must be escrowed.** Without it every nightly backup is
unrecoverable, and the loss is silent until the day somebody needs a restore.

---

## Environment

Composed by `runtimeConfig.resolveEnv()` before the Next server starts. Anything
already in the real environment **wins**, which keeps `npm run dev:desktop`
working against a developer's `.env` and gives support an override.

| Variable | Local | Cloud |
| --- | --- | --- |
| `DB_HOST` | `127.0.0.1` | build default |
| `DB_PORT` | generated, 33060+ | build default |
| `DB_PASSWORD` | generated, DPAPI-sealed | build default |
| `SITE_DB_HOST_OVERRIDE` | `127.0.0.1` | — |
| `SESSION_SECRET` | generated | build default (shared) |
| `ENCRYPTION_KEY` | generated | build default (shared) |
| `BACKUP_ENCRYPTION_KEY` | generated | — |
| `ODYSSEY_SITE_ID` | recorded at provisioning | — |
| `UPLOADS_DIR` | `userData/uploads` | `userData/uploads` |

A local install shares **nothing** with anyone, so generating its own secrets is
strictly better than shipping ours: there is no shared key to leak, and no two
installs have the same one.

---

## Support tasks

**Reveal a customer's database password.** Setup → Tills, on the site. Never
give it to the customer — it is what keeps them out of their own takings, and a
shop owner who can edit sales rows directly is a shop whose figures mean
nothing.

**A machine that will not start.** Check `%LOCALAPPDATA%\...\runtime-config.json`
exists and `mariadb\data\mysql` is present. If the data directory is missing but
the config is not, the machine was interrupted mid-provisioning — starting again
completes it. If the data directory exists but the server will not start, **do
not delete it**; that is the shop's trading history.

**A machine that keeps locking.** Look at `cp2_unlock_grants` for the site. Four
grants in a row is an account conversation, not a connectivity one.

---

## Tests

```
npm run test:unlock-code         # the primitives: alphabet, bias, single-use
npm run test:unlock-exchange     # the whole phone call, both ends, counter drift
npm run test:lease               # the boundary, the warning, the parsing
npm run test:runtime-config      # provisioning, never rotating, per-install uniqueness
npm run test:offline-backoffice  # the offline credential
npm run test:backup-push         # encryption round-trip, tampering, refusals
npm run test:replication         # server id, replication account, tunnel backoff
npm run test:ws-frame            # framing, against Node's own WebSocket client
npm run test:replica-host        # auth, path traversal, streamed upload
```

All nine run with no database and no browser.
