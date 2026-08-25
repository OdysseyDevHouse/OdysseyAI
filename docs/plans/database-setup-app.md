# Odyssey Database Setup — giving the provisioning engine a face

A technician installs one program on the machine that will host a shop's
database. They type the email and password they already have, and press a
button. Some minutes later that machine holds a MariaDB with the shop's database
in it — schema, tables, the lot — and a first back-office login the owner
changes on their way in. From then on the shop signs in on that machine whether
or not the line is up, and the database password is one **the technician never
saw and cannot recover**.

## The model, decided

This is the part that was ambiguous in the codebase and is now settled. It
applies to the **Electron local install only**; the web app is untouched.

**The control-panel credential is a provisioning key, not a login.** One email
and password per local site. Its entire job is to authenticate once against the
cloud control panel and answer "which ODY is this machine, and what are its
database details". It is never used to sign in to the shop afterwards.

**After provisioning, all sign-in is local.** The shop's users live in the
`users` table in the site's own database. Users created on that machine are
saved there and nowhere else — nothing is written back to `cp2_users`, and
nothing needs to be. There is no mirror, no sync, and no conflict to resolve.

**The first user is created during setup, and signs in with a name and a PIN.**
A freshly provisioned database has an empty `users` table, so the wizard's last
step asks the person installing it to create the store owner — a `back_office`
user with a name and a PIN they choose. From then on that is how everyone signs
in on this machine: Bob, 5204. No password, no control-panel account, nothing
copied down from the cloud.

**Credentials and port come from the control panel.** Database name, user,
password, host and port are read from `cp2_site_databases` and handed straight
to MariaDB. This settles a second disagreement: `runtimeConfig.provisionLocal()`
mints its own credentials and picks a port in `33060–33359`, deliberately
avoiding 3306 so as not to shadow a customer's existing MySQL. The control panel
currently says 3306 and the control panel wins. The hazard is accepted, and it
already fails clearly rather than silently — `provisionForPlan` refuses with a
plain message when something answers on the port and this machine has no Odyssey
data directory.

## What is already written

The provisioning engine is done, commented and partly tested. None of it needs
rebuilding:

| Piece | Where | State |
| --- | --- | --- |
| Authenticate the provisioning key | [signIn.ts](../../src/lib/dbSetup/signIn.ts) | Done — same bcrypt verifier and lockout as the login form |
| Decide what to provision | [plan.ts](../../src/lib/dbSetup/plan.ts) | Done — pure function of `connection_type`, shown to a human first |
| Generate the SQL | [sql.ts](../../src/lib/dbSetup/sql.ts) | Done — `CREATE IF NOT EXISTS` + `ALTER`, no `DROP` |
| Install, start, apply | [localDb.js](../../electron/localDb.js) `provisionForPlan` | Done — initialises, starts, applies statement-by-statement with progress |
| Drive it | [db-setup.ts](../../scripts/db-setup.ts) | Done, but it is a **terminal program** |

The only way to run any of it today is `npm run db:setup`, which needs Node, the
repository and a command prompt. A technician has none of those.

## The flow, end to end

```
1. Technician runs Odyssey Database Setup
2. Signs in with the provisioning key  -> cloud control panel
3. Picks the shop                      -> skipped when there is only one
4. Reads cp2_site_databases            -> localhost, 3306, ODY10003_master,
                                          username, password
5. Installs MariaDB, creates the database, user and grants
6. Applies sql/site/*.sql                                      <- NEW
7. Asks for the store owner's name and PIN, creates that user  <- NEW
8. Done. Back Office on that machine signs in with name + PIN.
```

Steps 6 and 7 are the new work. Everything above them exists.

## How the two installers hand over

They are separate installers with separate appIds, so separate userData
directories. Setup finishes knowing exactly what the Back Office needs — which
shop this machine is, and how to reach the database it just created — and has
nowhere to put it that the Back Office will look.

So it writes one file to `ProgramData\Odyssey\site.json`, for the same reason
`localDb` puts the MariaDB binaries there: the technician provisions under
their own Windows login and the shop then runs the app under the owner's.

The Back Office adopts it on first start, seals the password into its own
per-user config under DPAPI, and thereafter carries the whole site connection in
its environment — `ODYSSEY_SITE_DB_HOST`, `_PORT`, `_NAME`, `_USER`,
`_PASSWORD`. `siteDb.ts` prefers those over its usual `cp2_site_databases`
lookup, in `sitePool` as well as `getSiteDatabase` — the pool is what opens the
socket, so checking only the latter would leave a control-database query in
front of every site query, which is the exact dependency a local install exists
to be free of.

**The shared file is not encrypted, deliberately.** DPAPI binds ciphertext to
the account that wrote it, so a file sealed by the technician is bytes the owner
cannot decrypt — the property that makes it valuable in userData makes it
useless here. It is written in the clear and says so in the file. The reduction
is real: any account on that machine can read the shop's database password. It
is bounded by MariaDB listening on loopback only, and by the accounts on a
shop's office computer belonging to the people who work there.

**The trade:** an adopted install no longer hears about a change made in the
control panel. Re-running Odyssey Database Setup re-points it — the "Retrieve
new details" path, which already exists and is already safe to re-run.

**And the two provisioning models no longer compete.** `ensureBackend()` adopts
the shared file when it is there and only falls back to `provisionLocal()` when
it is not. Both running would leave the app holding credentials for a database
that does not exist while ignoring the one that does.

## The gaps

### 1. Nothing creates the tables

`provisionStatements` does `CREATE DATABASE`, `CREATE USER`, `GRANT` and stops.
The 254 files in `sql/site/` are applied by
[site-migrate.mjs](../../scripts/site-migrate.mjs), which nothing in
`src/lib/dbSetup/` calls. So the tool as it stands creates an empty database.

`site-migrate.mjs` is close to what is needed and already resolves its
connection the way the app does, so the two "can never disagree about where a
site's data lives". It wants lifting out of `scripts/` into a module the
Electron main process can call, with its `console.log` progress replaced by the
`onProgress` callback `provisionForPlan` already takes.

### 2. `sql/` is not in the installer

Not in `files`, not in `extraResources`. Those 254 migrations are not packaged
at all, so there would be nothing to apply even once step 6 is wired up. Same
family of fault as the three found while getting the installer to build: the
build config was written for a machine that already had the repository.

### 3. Sign-in has to work against the site's own users

**No password, and no new credential.** The site `users` table already carries
`pin_hash` — bcrypt, hashed and verified by the same helpers `cp2_users` uses —
and that is the credential. A person signs in with their **name and their PIN**:
Bob, 5204.

That resolves unambiguously without a unique username, which is worth spelling
out because it looks like it should not. `name` is deliberately not unique — two
people may be called Bob. But PIN uniqueness across active users **is** already
enforced, in `users.ts`, one bcrypt comparison at a time, precisely because the
till identifies a person by PIN alone:

> *"Every active PIN has to be compared one at a time."*

So the pair is unique even when the name is not. Verify the PIN, find the one
user it belongs to, check the name matches. Nothing to add to the schema for
this, and nothing new to keep unique.

**Nothing in this plan alters the control panel.** `cp2_users`, `cp2_sites` and
`cp2_site_databases` are read-only throughout: authenticate the provisioning key,
read the connection details. `cp2_users` is not consulted at all once
provisioning is done — an Electron local install does not have control-panel
users, and the ones it does have were created on the machine.

What the work actually is:

- an auth path that verifies name + PIN against the site `users` table, used
  when the app is a local Electron install;
- the setup wizard creating the shop's first user — the store owner, a
  `back_office` user with a PIN they choose — as its last step, because a
  freshly provisioned database has an empty `users` table and nobody who can
  sign in;
- `Setup → Users` continuing to work exactly as it does, since it already
  creates site users with PINs.

**Lockout: deliberately not built.** `cp2_users` has `failed_attempts` and
`locked_until`; the site `users` table has neither, and will not get them. This
is a back office sitting in a shop's own office, on a machine only the people
who work there can physically reach — the door is the rate limiter. Adding a
lockout would mostly mean staff locked out of their own till on a busy morning.
Recorded here so it reads as a decision rather than an oversight; revisit it if
this ever runs somewhere the public can touch the keyboard.

### 4. The role does nothing yet

`build-config/database.yml` bakes `odysseyRole: database` and
[appRole.js](../../electron/appRole.js) reads it — but nothing acts on it.
[main.js](../../electron/main.js) imports `isPos`, `startPath` and
`posNavigation`, never `isDatabaseSetup`, and `startPath()` returns `/` for
anything that is not a till. Built today, Odyssey Database Setup opens the
ordinary back office.

There is an ordering trap with it: `resolveEnv()` sends a `local` install at
`127.0.0.1` for everything, control database included. The setup tool's whole
job is to read the **cloud** control panel on a machine where the local database
does not exist yet. The `database` role must resolve as cloud regardless of the
marker, and must not call `provisionLocal()`.

### 5. The plaintext password must not enter the browser

`SetupPlan` carries the password in the clear — its own comment says it must
never be logged or shown. A renderer is a browser: what it holds is one devtools
window from being read.

So the flow inverts. The renderer collects an email, a password and a site
choice, and displays progress. It never receives a plan.

```
renderer  --{email, password, siteId}-->  main  (IPC)
main      --HTTP 127.0.0.1------------->  in-process Next server
                                          signInForSetup / sitesForSetup / planFor
main      <--full plan (never forwarded)--
main      --provisionForPlan()---------->  MariaDB
main      --{step, message}------------>  renderer  (IPC events)
```

The technician's own password passes through the renderer, which is fine — they
typed it. The shop's database password never leaves the main process.

[preload.js](../../electron/preload.js) exposes only static values and there is
no `ipcMain` handler anywhere in the app. This introduces the first, so the
pattern is worth setting deliberately: one `invoke` channel per step, one event
channel for progress, nothing generic.

## The screens

Four in sequence, plus two terminal states, all outside the `(app)` layout —
that layout calls `requireSession()` and wraps children in `DesktopLicenceGate`,
neither of which applies to a program run before the shop's software exists.

1. **Sign in** — the provisioning key. One message for every failure except a
   locked account, matching `signInForSetup`.
2. **Choose the shop** — from `sitesForSetup`. Skipped entirely when there is
   one; nobody should be asked a question with one answer.
3. **Confirm** — rendered through `redact()`, never the raw plan. Shop,
   connection type, database name, host and port. Says plainly when a server is
   already installed and this is a re-run. A `cloud` site becomes *"nothing to
   install here"* and explains why.
4. **Provision** — a progress list fed by `onProgress`. Installing, applying 254
   migrations and seeding are each long enough to deserve their own line;
   applying a schema is not a spinner.

Terminal states: **done**, naming the first login and telling the technician it
must be changed on the way in; and **refused**, carrying the `action: 'refuse'`
reason verbatim.

Built from `@/components/ui` per AGENTS.md, and added to the Style Guide page.

## Work, in order

1. **Make the role mean something** — `startPath()`, a navigation guard, and
   `resolveEnv()` forcing cloud for the database role. Everything depends on it.
2. **Package `sql/`** and lift `site-migrate.mjs` into a callable module.
3. **Local sign-in** — the name + PIN auth path against the site `users`
   table, and the store-owner step at the end of provisioning. Plus the lockout
   columns, if you want them.
4. **The IPC bridge** — the first in the app, so set the pattern deliberately.
5. **The screens.**
6. **Packaging** — populate `vendor/mariadb` from the portable ZIP per
   [local-backend.md](../local-backend.md), write `build/backend.txt`, build.
   The `extraFiles` entry carrying `backend.txt` beside the executable was added
   while investigating this; it had never shipped.

## How we will know it works

Unit coverage exists — `scripts/test-db-setup.ts` exercises the SQL generation.
What is not covered is the thing that actually failed: an install on a machine
that is not the developer's.

The acceptance test is a **clean Windows VM, no Node, no repository**: install
Odyssey Database Setup, provision `ODY10003`, create the store owner, then
install Odyssey Back Office marked local on the same machine, sign in with that
name and PIN, **unplug the line**, sign in again, and reach a page showing
trading data. Anything less does not count. Every fault found while getting the
installer to build was invisible on the developer's machine and obvious on the
tester's.

## Risks

- **What still reads the control database on a local install.** Sign-in no
  longer does, which was the point. Licensing, module entitlements and the site
  record are separate questions, and each needs checking against "the line is
  down" before this is called finished. `DesktopLicenceGate` already fails open
  when it cannot reach control, which is a good sign but not a survey.
- **3306 will collide on some machine.** Accepted, and it fails clearly, but it
  will generate a support call eventually.
- **The two provisioning models must not both stay live.** Leaving
  `provisionLocal()` reachable means a machine can end up with self-minted
  credentials the control panel has never heard of.
- **Site #1 in the current control database is `cloud` but its trading database
  exists nowhere on the cloud server.** Unrelated to this plan; it will block any
  cloud tester the moment one is tried.
