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
```

All six run with no database and no browser.
