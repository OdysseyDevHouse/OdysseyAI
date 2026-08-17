# Control panel v2 — changes from the local-backend work

**For:** whoever builds the v2 control panel screens
**From:** the OdysseyAI back-office / desktop side
**Date:** 17 August 2026
**Status:** schema written and committed; **not yet applied to the live control database**

---

## What this is about, in one paragraph

Odyssey desktop installs currently point at a cloud database — you sign in, and
the app connects to a database we host. We have built a second option: a
**local backend**, where MariaDB ships inside the installer and the shop's
trading data lives on the shop's own machine. The shop can then trade with no
internet at all.

That creates work for the control panel, because three new things now need
managing from your side: **an escrowed database password**, **a licence lease
with a telephone unlock**, and **a read-only cloud replica** used for reporting.

This document describes only what touches the control database (`odyssey_tickets`).

---

## The one existing column that now matters

`cp2_sites.backoffice_type` is already `'windows' | 'cloud'`. It has existed for
a long time, is read by the back office, and until now was **displayed and never
acted upon**.

It is now the switch that decides whether a site is cloud or local.

**What v2 needs to do:** make it editable, and make it obvious. A site set to
`windows` is one where the customer's data is on their own premises — that
changes what support can see, how backups work, and what happens when the
shop's line goes down.

**One caveat worth knowing.** The desktop app cannot read this column on its
*first* run (reading it needs a database connection it may not have yet), so the
installer carries the decision and the control panel confirms it afterwards. A
mismatch between the two should be **surfaced to support, not auto-corrected** —
switching a live shop between backends means moving its data, which is not
something software should do to itself at startup.

---

## New tables

Three migrations, `sql/tickets/011` → `013`. All strictly additive — **no
existing table is altered**, nothing v2 owns is touched.

### 1. `cp2_local_backends` — the shop's own database, as we know it

One row per machine that hosts a local database. A cloud site never gets a row,
and **the absence is the answer** — no row means nothing was ever provisioned
on a customer's machine, which is a safer statement than a row full of nulls.

```sql
CREATE TABLE cp2_local_backends (
  id                INT UNSIGNED NOT NULL AUTO_INCREMENT,
  site_id           INT NOT NULL,
  device_serial     VARCHAR(190) NOT NULL,   -- matches cp2_devices.serial_number
  db_password_enc   TEXT NULL,               -- enc:v1 envelope — see "Encryption"
  db_port           INT UNSIGNED NULL,       -- NOT 3306; the installer picks 33060+
  db_name           VARCHAR(190) NULL,
  unlock_secret_enc TEXT NULL,               -- enc:v1; shared secret for the phone unlock
  escrowed_at       DATETIME NULL,
  last_seen_at      DATETIME NULL,
  lease_expires_at  DATETIME NULL,
  status            VARCHAR(32) NOT NULL DEFAULT 'active',
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_cp2_local_backends_site_serial (site_id, device_serial),
  KEY ix_cp2_local_backends_site (site_id)
);
```

**Who writes it:** the desktop app, on first successful contact. The machine
generates its own database password, then escrows it here. Deliberately that
way round — the installer must bring a database up with **no network at all**,
so the machine cannot wait to be told its password.

**Why the password is stored reversibly:** so support can recover a machine the
customer cannot. A password nobody can read back is not an escrow.

**The rule for v2 screens:** `db_password_enc` must **never** be shown to a
customer. It opens their live trading database with full rights, and a shop
owner who can edit sales rows directly is a shop whose VAT, stock valuation,
commission and audit trail all quietly stop meaning anything.

### 2. `cp2_unlock_grants` — every telephone unlock ever issued

```sql
CREATE TABLE cp2_unlock_grants (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  site_id        INT NOT NULL,
  device_serial  VARCHAR(190) NULL,
  challenge      VARCHAR(64) NOT NULL,   -- what the customer read out
  response       VARCHAR(64) NOT NULL,   -- what was read back
  unlock_counter INT NOT NULL,           -- makes a code single-use
  granted_days   INT NOT NULL,           -- currently always 14
  granted_by     INT NULL,               -- cp2_users.id, no FK (see below)
  reason         VARCHAR(255) NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_cp2_unlock_grants_site (site_id, created_at),
  KEY ix_cp2_unlock_grants_serial (device_serial, created_at)
);
```

See **"The telephone unlock"** below for what this is for. The short version:
it is a **ledger, not a lock**, and it is the only real control on the feature.

### 3. `cp2_credential_reveals` — who read an escrowed password, and why

```sql
CREATE TABLE cp2_credential_reveals (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  site_id       INT NOT NULL,
  device_serial VARCHAR(190) NULL,
  credential    VARCHAR(40) NOT NULL,   -- 'db_password' today
  revealed_by   INT NULL,               -- cp2_users.id, no FK
  reason        VARCHAR(255) NOT NULL,  -- REQUIRED, not decorative
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_cp2_credential_reveals_site (site_id, created_at),
  KEY ix_cp2_credential_reveals_by (revealed_by, created_at)
);
```

`reason` is `NOT NULL` on purpose. This log is the only thing that can later
distinguish *"support recovered a machine"* from *"somebody read a customer's
password"*, and an entry without a reason cannot.

**A mistake worth not repeating:** the first version of this wrote reveals into
`cp2_unlock_grants` with a fake challenge of `'DB-PASSWORD'`. It worked, and it
was wrong — that table answers *"how often has this shop been let off a licence
check"*, and any report counting its rows would silently have started counting
password reads too.

### 4. `cp2_reporting_replicas` — the read-only cloud copy

```sql
CREATE TABLE cp2_reporting_replicas (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  site_id         INT NOT NULL,
  server_host     VARCHAR(190) NOT NULL,
  server_port     INT UNSIGNED NOT NULL DEFAULT 3306,
  database_name   VARCHAR(190) NOT NULL,
  db_username     VARCHAR(190) NULL,      -- SELECT-only account
  db_password_enc TEXT NULL,              -- enc:v1
  device_serial   VARCHAR(190) NULL,
  status          VARCHAR(32) NOT NULL DEFAULT 'pending',  -- pending|running|stopped|error
  seconds_behind  INT NULL,               -- NULL = not running (≠ zero)
  last_contact_at DATETIME NULL,
  last_error      TEXT NULL,
  binlog_file     VARCHAR(190) NULL,
  binlog_position BIGINT UNSIGNED NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_cp2_reporting_replicas_site_device (site_id, device_serial),
  KEY ix_cp2_reporting_replicas_site (site_id),
  KEY ix_cp2_reporting_replicas_status (status, seconds_behind)
);
```

**Why this is not a row in `cp2_site_databases`.** That table already supports
several databases per site through its `purpose` column, and adding
`purpose = 'reporting'` would have been three lines. It was rejected
deliberately: everything that reads `cp2_site_databases` does so to **write** as
well — it is the connection the till posts sales through. A replica must never
be written to, and keeping it in a separate table means the write path
*cannot* resolve to one. The separation is the safety property.

> **`seconds_behind IS NULL` means replication is not running.** That is a
> different and more serious state than `0`. Any screen or alert must treat them
> differently.

---

## Encryption: the contract you must match

Three columns hold reversible secrets: `cp2_local_backends.db_password_enc`,
`.unlock_secret_enc`, and `cp2_reporting_replicas.db_password_enc`.

They use the **same envelope as `cp2_site_databases.db_password_enc`**, which v2
already implements — so if you can read that column, you can read these.

```
Algorithm : aes-256-gcm
Key       : scryptSync(ENCRYPTION_KEY, 'odyssey-secret-v1', 32)
IV        : 12 random bytes per value
Format    : enc:v1:<iv b64>:<authTag b64>:<ciphertext b64>
```

`ENCRYPTION_KEY` must be **byte-identical** between v2 and the Odyssey back
office. A mismatch does not fail cleanly — GCM authentication fails on decrypt,
which surfaces as "could not be decrypted" long after the write.

Values without the `enc:v1:` prefix are legacy plaintext and pass through
unchanged.

---

## Foreign keys: deliberately absent

`granted_by` and `revealed_by` hold `cp2_users.id` but carry **no foreign key**.
This follows the precedent set in `005_pos_device_licensing.sql` for
`terminal_id`: a constraint across an ownership boundary is one that the other
side can break without knowing we exist.

Same for `site_id` — join in queries, but do not add the constraint.

---

## What the control panel needs to be able to do

Roughly in priority order.

### Must have

1. **Set `backoffice_type` per site**, and show it prominently. This is the
   switch that decides everything else.

2. **Show local-backend health for a site.** Read `cp2_local_backends` joined to
   `cp2_reporting_replicas`. The useful summary, in severity order:
   - locked (lease expired) → *the shop cannot trade*
   - trading but silent 3+ days → *drifting toward a lock*
   - replica stopped or lagging → *reporting is wrong*
   - healthy

   Lead with a verdict rather than a table of fields. A support call starts with
   *"why can this shop not X"*, and an agent should not have to know which
   subsystem to suspect before they can start reading.

3. **Reveal an escrowed database password**, with a required written reason,
   writing `cp2_credential_reveals` **before** returning the password. Show
   recent reveals on the same screen — a deterrent only deters when the person
   about to act can see it.

4. **Issue a telephone unlock code.** See the next section — the algorithm is
   specified and must match exactly.

### Should have

5. **A report of sites living on unlocks.** `cp2_unlock_grants` grouped by site.
   Four grants in a row is an account conversation, not a connectivity one, and
   nobody will find it unless a screen shows it.

6. **A report of credential reveals by user.** `cp2_credential_reveals` grouped
   by `revealed_by`. Same reasoning.

7. **Replica health across all sites.** `WHERE status <> 'running' OR
   seconds_behind > 300`, ordered worst-first.

### Nice to have

8. **Last-seen dashboard** — `cp2_local_backends.last_seen_at` across every local
   site, so a machine that has quietly stopped reporting is visible before the
   customer rings.

---

## The telephone unlock — algorithm specification

**This is a contract.** Both ends compute the same HMAC. If v2's implementation
differs by a single character, every machine in the field stops accepting codes
from the control panel — and there is no way to push a fix to a machine that is,
by definition, offline and locked.

### Why it exists

A local install locks itself **7 days** after its last successful licence check.
That is what stops a machine trading forever on a licence nobody can withdraw.

But a machine that *has* a connection never locks — it renews automatically. So
the only useful unlock is one that works with **nothing but a telephone**. The
internet is only on our side of the call.

### The exchange

1. The locked machine displays a **challenge** (9 characters, shown as `ABC-DEF-GHJ`).
2. The customer reads it to support.
3. The supervisor types it into the control panel, which finds which machine it
   came from and computes a **response**.
4. The customer types the response into the machine, which verifies it locally
   and extends its lease by **14 days**.

No packet moves between the two systems.

### The constants — treat as frozen

```
ALPHABET    = 'ACDEFGHJKMNPQRTUVWXY34679'   // 25 chars, no confusables
CODE_LENGTH = 9                              // displayed grouped 3-3-3
SEPARATOR   = U+0000   // a single NUL byte (0x00), NOT a space or a pipe
GRANT_DAYS  = 14
```

The alphabet omits every character people mishear reading aloud: no `0`/`O`, no
`1`/`I`/`L`, no `5`/`S`, no `8`/`B`, no `2`/`Z`.

### Deriving a challenge

```
challenge = encode(
  HMAC-SHA256(
    key     = base64_decode(unlock_secret_enc, decrypted),
    message = 'odyssey-unlock-challenge-v1' + SEP
            + str(site_id)                  + SEP
            + (device_serial or '')         + SEP
            + str(unlock_counter)
  )
)
```

### Deriving a response

```
response = encode(
  HMAC-SHA256(
    key     = same secret,
    message = 'odyssey-unlock-response-v1' + SEP + normalise(challenge)
  )
)
```

`normalise()` upper-cases, strips everything not in the alphabet (so dashes,
spaces and any mis-typed confusable simply vanish), and is applied to **both**
sides of every comparison.

### `encode()` — bytes to characters

Rejection sampling, **not** modulo:

```
limit = floor(256 / 25) * 25          // = 250
for each byte b of the HMAC:
    if b >= limit: skip               // discard the biased tail
    else: append ALPHABET[b % 25]
    stop at 9 characters
```

`byte % 25` alone would favour the first 6 characters. It would not be
exploitable at this length, but a skewed alphabet is impossible to change later
— every machine in the field would have to change at the same moment.

### Finding which machine a challenge came from

The supervisor types a code but does not know the serial. So: for each active
row in `cp2_local_backends` for that site, recompute the challenge at each
plausible `unlock_counter` and look for a match.

```
COUNTER_WINDOW = 5

for each backend at this site:
    secret = decrypt(backend.unlock_secret_enc)
    prior  = COUNT(*) FROM cp2_unlock_grants
             WHERE site_id = ? AND device_serial = backend.device_serial
    for counter in max(0, prior - 5) .. prior + 5:
        if normalise(challengeFor(secret, site_id, serial, counter)) == normalise(typed):
            → this is the machine; compute and return the response
```

**Why a window.** The control panel only *mirrors* the machine's redeem counter.
A code issued and never typed in leaves us one behind; a machine restored from
backup leaves us ahead. Both directions happen, and getting the window wrong
means a real customer hears *"that code does not match"* with no way to fix it
from their side.

A match proves the code is genuine, because only a holder of that secret could
have displayed it.

### Properties this gives you

- **Machine-specific** — a code for one till is refused by every other.
- **Single-use** — the counter feeds the challenge, so redeeming changes the
  next challenge and kills the code just used.
- **Time-boxed** — it extends the lease, it does not clear the requirement.

### What it deliberately cannot do

It **cannot stop your own support desk** keeping a non-paying shop trading a
fortnight at a time. Granting access without verifying anything over the wire is
the entire premise, and no cryptography changes that.

`cp2_unlock_grants` is the actual control: **not prevention, accountability**.
Write the grant **before** returning the code, and refuse the grant if the write
fails — an unrecorded unlock is the only kind that defeats the point.

Show the prior-grant count to the agent **while they are deciding**. A shop on
its fourth unlock is not a connectivity problem.

---

## Reference implementations

If it helps to read working code rather than a spec, these are in the Odyssey
back-office repo and are all tested:

| Concern | File |
| --- | --- |
| Unlock algorithm (the contract) | `src/lib/licence/unlockCode.ts` |
| Control-panel side: find machine, mint response, record grant | `src/lib/licence/grantUnlock.ts` |
| Reveal an escrowed password | `src/app/(app)/setup/databases/localBackendActions.ts` |
| Health summary + verdict ordering | `src/lib/licence/localBackendStatus.ts` |
| Encryption envelope | `src/lib/crypto/secrets.ts` |
| Replica provisioning script | `scripts/replica-provision.mjs` |

Test suites worth mirroring — they encode the properties, not just the code:

```
npm run test:unlock-code            # alphabet, bias, single-use
npm run test:unlock-exchange        # the whole phone call, both ends, counter drift
npm run test:local-backend-status   # verdict severity ordering
```

---

## Applying the migrations

```
sql/tickets/011_local_backend.sql        cp2_local_backends, cp2_unlock_grants
sql/tickets/012_reporting_replicas.sql   cp2_reporting_replicas
sql/tickets/013_credential_reveals.sql   cp2_credential_reveals
```

There is **no migration runner for `sql/tickets/`** — these are applied by hand,
same as `001`–`010`. All are `CREATE TABLE IF NOT EXISTS` and safe to re-run.

Verify with `SHOW COLUMNS`, not by assuming the file ran — a `.sql` that was
edited after being applied silently does nothing.

---

## Summary for a coding agent

> The Odyssey back office has added a "local backend" mode where a shop's
> MariaDB runs on the shop's own machine instead of in our cloud. Four new
> tables were added to the control database (`odyssey_tickets`), all prefixed
> `cp2_` and all purely additive:
>
> - `cp2_local_backends` — one row per shop machine; holds the **escrowed
>   database password** and the **shared secret for offline unlock codes**
> - `cp2_unlock_grants` — audit ledger of every telephone unlock issued
> - `cp2_credential_reveals` — audit ledger of every escrowed password read
> - `cp2_reporting_replicas` — the read-only cloud copy used for reporting
>
> The existing column `cp2_sites.backoffice_type` (`'windows' | 'cloud'`) is the
> switch that decides which mode a site uses. It already exists and is currently
> inert.
>
> The control panel needs screens to: set `backoffice_type`; show local-backend
> health; reveal an escrowed password with a **required reason** (logged before
> the password is returned); and **issue offline unlock codes** using the HMAC
> algorithm specified in this document, which must match the client exactly.
>
> Three secret columns use the existing `enc:v1:` AES-256-GCM envelope under
> `ENCRYPTION_KEY` — the same one `cp2_site_databases.db_password_enc` already
> uses.
