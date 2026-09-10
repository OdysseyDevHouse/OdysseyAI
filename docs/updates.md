# Keeping shops current

Odyssey updates itself. This is how that is set up, how a release is cut, and
what to check when a shop says it is still on an old version.

## What a shop experiences

Nothing, which is the design. Thirty seconds after launch and every four hours
after that, the app asks the release bucket whether there is a newer version. If
there is, it downloads it in the background and applies it **when somebody
closes the app** — end of day on a counter machine. A till never stops
mid-sale, and no dialog ever interrupts a queue.

If the line is down, the bucket is unreachable, or there is no release, the app
opens exactly as it always does. An updater that can stop a shop trading is
worse than no updater.

The database is never touched. Updates replace the application directory; the
shop's data lives in `ProgramData\Odyssey\mariadb`, served by a Windows service
that keeps running throughout — see [local-backend.md](local-backend.md).

## One-time setup

Done once, by one person. Twenty minutes, most of it waiting for a DNS record.

### 0. Before you start

`odysseysoftware.co.za` must already be a **zone in the Cloudflare account you
are about to use** — nameservers pointed at Cloudflare, showing Active in the
dashboard. R2 will only attach a custom domain to a zone it can see, and the
"Connect Domain" button below simply will not find the name otherwise. If the
domain lives elsewhere, moving it is the first job and everything here waits.

### 1. Create the bucket

**dash.cloudflare.com → R2 Object Storage → Create bucket.**

First time in R2 it asks for a payment method even to use the free tier. Add
one. The tier is 10GB stored and 10M reads a month, and — the part that matters
here — **egress is free**. A thousand shops pulling a 130MB installer is 130GB
of transfer per release, which is a real bill on almost anything else and zero
here.

- **Name:** `odysseywindowsupdatelink` — this is `R2_BUCKET`. The name is never seen
  by a shop: the public domain below is what installers read, and the bucket is
  implied by it.
- **Location:** there is no African hint. Pick **Western Europe (WEUR)**; it is
  the shorter leg from ZA and it only affects a cache MISS anyway, because
  everything below is served from Cloudflare's edge and there are PoPs in
  Johannesburg and Cape Town.
- **Leave lifecycle rules alone.** An expiry rule that tidies away old
  installers also removes the file a technician reaches for when a machine needs
  a manual re-install, which is exactly the machine that could not update
  itself. Storage for a year of releases is inside the free tier.

Nothing needs creating inside the bucket. `publish:release` writes the three
folders on first upload.

### 2. Give it a public domain

**Bucket → Settings → Public access → Custom Domains → Connect Domain.**

Enter `updates.odysseysoftware.co.za`. Cloudflare writes the DNS record itself,
proxied. Wait for the status to read Active — usually a minute or two.

**Do not use the `r2.dev` URL for this.** It is offered on the same screen and
it looks like it would do, but Cloudflare rate-limits it deliberately and
documents it as development-only. Discovering that limit means discovering it on
the morning a release goes out to every shop at once, which is the one morning
every shop asks for the same file inside the same hour.

There are no CORS rules to set: the updater is a Node HTTP client in Electron's
main process, not a browser. Range requests need to work — they are how a shop
downloads only the blocks that changed instead of the whole installer — and R2
serves them by default.

Caching also needs nothing: an R2 custom domain honours the origin's
`Cache-Control`, and `publish:release` sets it per object. Installers are
`immutable` (their names carry the version, so they can never mean two things);
`latest.yml` is `no-cache`, because a manifest cached for an hour is a release
that arrives an hour late and a rollback that does not arrive at all.

### 3. Create an API token

**R2 → API → Manage API tokens → Create API token.**

- **Permissions: Object Read & Write.** Not Admin. This token cannot then create
  or delete buckets, and Read is needed as well as Write because the publish
  script asks whether a version already exists before it overwrites one.
- **Specify bucket:** `odysseywindowsupdatelink`, and nothing else. This credential can
  replace the installer a thousand shops will run — it is worth the extra click.

On creation you get three values, **shown once**:

| Cloudflare calls it | goes into |
|---|---|
| Access Key ID | `AWS_ACCESS_KEY_ID` |
| Secret Access Key | `AWS_SECRET_ACCESS_KEY` |
| Use jurisdiction-specific endpoint / S3 endpoint | `R2_ENDPOINT` |

The endpoint is `https://<account-id>.r2.cloudflarestorage.com`. It is the
**write** side, spoken by the AWS CLI on your machine, and has nothing to do
with the public domain in step 2 — no installer ever contacts it.

### 4. The AWS CLI

R2 speaks S3, so `aws` is what uploads.

```powershell
winget install Amazon.AWSCLI
```

Nothing to configure — no `aws configure`, no profile. `publish-release.mjs`
passes `--endpoint-url` and `--region auto` itself, and reads the credentials
from the environment, so the CLI never has to hold R2 settings that would
confuse it about real AWS.

### 5. `.env`

```ini
ODYSSEY_UPDATE_URL=https://updates.odysseysoftware.co.za

R2_BUCKET=odysseywindowsupdatelink
R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
AWS_ACCESS_KEY_ID=<the token's access key id>
AWS_SECRET_ACCESS_KEY=<the token's secret>
```

`ODYSSEY_UPDATE_URL` is the **public read** domain from step 2, with no trailing
folder — `electron/updater.js` appends `backoffice/`, `pos/` or `database/`
itself. It is the only one of the five that is baked into installers;
`scripts/make-build-defaults.mjs` copies it into `electron/buildDefaults.json`.

The `R2_*` and `AWS_*` keys never leave your machine. They are not in the `KEYS`
list in make-build-defaults, so they cannot reach a customer's installer even by
accident — which is the reason the write credential and the read URL are
separate settings rather than one.

Without `ODYSSEY_UPDATE_URL` the build still succeeds; `build:defaults` warns,
and the app logs `No update server configured for this build` once at startup.

### 6. Prove it before you need it

```powershell
aws s3 ls s3://odysseywindowsupdatelink --endpoint-url $env:R2_ENDPOINT --region auto
```

An empty listing is success. `InvalidAccessKeyId` means the token or the
endpoint is wrong; `Could not connect` means the endpoint is.

If the CLI complains about a checksum or an unimplemented header, it is a
recent AWS CLI defaulting to integrity headers R2 does not accept. Add to
`.env`:

```ini
AWS_REQUEST_CHECKSUM_CALCULATION=when_required
AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
```

Then, once a release is published, the thing the shops actually do:

```powershell
curl https://updates.odysseysoftware.co.za/backoffice/latest.yml
```

## Cutting a release

```powershell
npm version patch          # or minor — this is what makes the update EXIST
npm run dist               # all three installers, into release/<role>/
npm run publish:release
```

The version bump is the whole mechanism. electron-updater compares the version
in `latest.yml` against `app.getVersion()`, and a build published at the version
shops already run is invisible to them.

`publish:release` checks each build before it uploads anything — that the
manifest's version matches `package.json`, that the file it names exists, and
that it is the size and sha512 the manifest claims. Then it uploads the
installer, then the blockmap, and **the manifest last**. That order is
load-bearing: `latest.yml` is what makes a release visible, and publishing it
first would tell a thousand machines about an installer that is still uploading.

Single build, or a rehearsal:

```powershell
npm run publish:release -- pos
npm run publish:release -- --dry-run
```

Republishing a version that is already in the bucket is refused. Shops that
already downloaded it hold a digest for the old bytes, and differential
downloads are computed against a blockmap that would no longer describe the
object. Bump the version instead.

## Beta releases

A release does not have to go to everybody. Every device carries a **channel**,
set in Control Panel v2 → **Releases**, and the machine asks the bucket for that
channel's manifest instead of the shipping one:

| Channel | Manifest | Who is on it |
|---|---|---|
| Stable | `latest.yml` | everybody, unless deliberately moved |
| Beta | `beta.yml` | the machines you have picked to test on |

Both live in the same `<role>/` folder and name their own installer. Nothing
about the bucket, the domain or the update mechanism changes — only which file a
given machine asks for.

### Cutting a beta

The version decides the channel. There is no flag:

```powershell
npm version 0.2.0-beta.1      # a prerelease tag -> beta
npm run dist
npm run publish:release
```

electron-builder reads the prerelease tag and writes `beta.yml` instead of
`latest.yml`; `publish:release` reads the same version and uploads it under the
same name. That means you cannot publish to beta by accident, and you cannot
publish a beta to stable at all — the file it would have to overwrite is never
produced.

Then in **Releases**, tick the machines and press *Move to Beta*. They pick it
up at their next update check (within four hours, or at the next launch).

### Putting a machine on beta

Control Panel v2 → Releases. The chips at the top count the estate by channel
and filter it; select devices and move them. Needs the **Manage Update Channels
(v2)** permission — seeing which machines are on beta needs only the ordinary v2
view, because that is support context.

Every move is written to that site's activity trail, so "why is this till on a
different version" has an answer with a name and a date on it.

### Getting a machine off beta

Move it back to Stable, and it lands on the stable release **that supersedes the
beta it is on** — not on today's stable.

This is deliberate. `allowDowngrade` stays off (see `electron/updater.js`)
because `sql/site` migrations are forward-only and applied once: an older app
opening a database that is already ahead of it fails in ways nothing detects at
the moment it happens. So the way off beta is forward.

In practice this is invisible, because **publishing a stable release also
promotes it onto `beta.yml`**. Semver puts `0.2.0-beta.1` below `0.2.0`, so the
tester rolls onto the stable release automatically and waits there for the next
beta. Without that promotion a beta tester would be stranded: `beta.yml` would
still name the version they are already running, they would see no update, and
the one machine you gave a customer to test on would quietly become the oldest
software on the estate.

`--no-promote` skips it, for a stable release testers must not receive. If a
newer beta is already published — `0.3.0-beta.1` out with testers while `0.2.1`
ships as a fix — promotion is skipped automatically and says so.

### Checking what is published

```powershell
curl https://updates.odysseysoftware.co.za/backoffice/latest.yml
curl https://updates.odysseysoftware.co.za/backoffice/beta.yml
```

### Pinning one machine without the control panel

```ini
ODYSSEY_UPDATE_CHANNEL=beta
```

Read from the environment by `electron/updateChannel.js` and it overrides the
control panel. For a developer checkout or a support session — it is **not** in
the `KEYS` list in `make-build-defaults.mjs`, so it cannot be baked into an
installer and a customer's build can never be born on beta.

### What a machine does when it cannot ask

It keeps the channel it last knew, cached in `update-channel` in userData. A
machine that has never had an answer is on stable. Every failure — no line, no
device id, a portal that is down — resolves to stable rather than to beta:
a tester who is briefly not testing gets noticed, and unreleased software
arriving on a counter because a fetch failed does not.

## Checking it works

```powershell
curl https://updates.odysseysoftware.co.za/backoffice/latest.yml
```

You should get the manifest, and the `path:` in it should be a filename that
`curl -I` finds. If the manifest names a file with dashes and the bucket holds
one with spaces, the artifact name and the safe name have diverged again — see
`artifactName` in `build-config/*.yml`.

On a machine, `%APPDATA%\odyssey-ai\logs` carries the `[updater]` lines: the
check, the version found, the download percentage, and the line saying it will
install on close. Downloads land in `%LOCALAPPDATA%\odyssey-<role>-updater\pending`.

To exercise it without cutting a release, point a dev checkout at a staging
prefix — the environment beats the baked value:

```powershell
$env:ODYSSEY_UPDATE_URL = 'https://staging.example/'
```

`npm run test:updater` covers the resolution itself (which folder each build
reads, the baked value working with an empty environment, trailing slashes) and
runs as part of `npm test`.

## Things worth knowing

**The first update has to be delivered by hand.** Every build cut before this
was written had the updater disabled by an ordering bug — it read the feed URL
out of `process.env` before `runtimeConfig.resolveEnv()` had put it there, found
an empty string, and latched. Machines in the field will therefore not pick this
up on their own. They need one manual install, and update themselves from then
on.

**The installers are not code-signed.** Auto-update still works — electron-updater
only verifies a publisher name when the installed app has one — but Windows
SmartScreen will warn on the manual install above, and `allowDowngrade` is off
in `electron/updater.js` partly because an unsigned build cannot be verified.
When signing is in place, that line should go.

**Odyssey Database Setup asks for administrator**, because registering a Windows
service is a machine-level act. Its updates therefore raise a UAC prompt at
quit, and on an unattended machine that means the update simply does not apply.
That is the right failure — it is a run-once technician tool, and it is the one
build a shop does not need current. Back Office and POS install per-user
(`perMachine: false`), so their updates need no elevation at all.

**Each build has its own download cache**, keyed off a per-product package name
set in `build-config/*.yml`. They used to share one, and the first thing either
does before downloading is empty it — so on an all-in-one running Back Office
and POS side by side, each deleted the other's finished download minutes before
quit would have applied it, and neither ever updated. `electron/main.js` pins
`app.setName('odyssey-ai')` so that splitting the package name could not move
`%APPDATA%\odyssey-ai` and take every shop's machine config with it.
