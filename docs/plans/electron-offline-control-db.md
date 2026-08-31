# Electron: stop calling the control database on every request

> **Status: implemented and measured.** All four changes are in, plus a fifth
> that only appeared once the counting started (`tabRouting`, below).
> Measured on the provisioned install on this machine — site 4, ODY-10003:
>
> | | control queries per page load |
> |---|---|
> | before | **4** — `cp2_sites`, `cp2_site_modules`, `cp2_billing_account_sites`, `cp2_devices` |
> | after, no lease yet | 3 |
> | after, lease held | **0** |
>
> `scripts/probe-control-calls.ts` produces that table;
> `scripts/probe-lease-expiry.ts` proves the seven-day lock still fires (8 checks);
> `scripts/test-licence-refresh.ts` guards the cadence contract (11 checks).

## The problem

The Next server runs **in-process inside Electron**, on the shop's counter. The
guard chain it inherited was designed for the cloud deployment, where the server
sits in the same rack as `odyssey_tickets` and a control query costs a fraction
of a millisecond.

On a shop's machine those same queries cross the internet. Measured from the
code, every page load and every server action runs:

| Call | Table | Memoised? |
|---|---|---|
| `sessionIsCurrent` | `cp2_user_sessions` | no |
| `getSite` / `getSiteForUser` | `cp2_sites`, `cp2_user_sites` | **no** |
| `entitlementsForSite` | `cp2_site_modules`, billing | per-request only |

That is 3–4 round trips per click. Stock list → edit product → back → edit again
is 30–50 round trips. At 50–150ms each, 150–600ms of waiting is added to every
interaction before the page does any work of its own.

The control DB is also IP-whitelisted to the office, so outside that building
these calls do not merely get slow — they fail, after a TCP timeout, on every
click.

## The shape of the fix

Not "build an API for everything". The machinery already exists and is wired in;
it is reached only from a `catch` block, so it never runs while the office
network makes the direct connection succeed.

`licence_lease` (`sql/site/178_licence_lease.sql`) is a singleton row in the
**shop's own MariaDB** holding licence status, held modules, per-module expiry,
and account status. `entitlementsForSite` already falls back to it
(`src/lib/control/modules.ts:258`), and `keepsLease()` already gates on
`APP_MODE === 'desktop'`.

The change is to make the lease the **primary** path in Electron and refresh it
on a timer, rather than treating it as a failure handler.

Two clocks, deliberately separate:

- **Refresh interval — 5 hours.** How often to *try* the control panel.
- **Lease expiry — 7 days.** How long a stale answer stays valid offline.
  `LEASE_DAYS = 7` already exists in `leaseRules.ts:18`.

~33 chances to reconnect before locking. A shop with a flaky line never notices;
a shop that unplugs the network to avoid paying still locks on schedule.

---

## Change 1 — Refresh the lease on a 5-hour timer

**Files:** `electron/main.js`, new `electron/licenceRefresh.js`

Precedent for the timer already exists: `electron/updater.js:106` runs a 4-hour
`setInterval`, and `electron/replicationTunnel.js:168` a 30-second heartbeat.

On a successful control read, `recordLease()` (`modules.ts:245`) already writes
the lease via `writeLease()` (`lease.ts:166`). The write path is done. What is
missing is a caller that runs on a clock instead of as a side effect of a
per-request read.

- Run once shortly after start (not blocking the window), then every 5 hours.
- Fire-and-forget. A failed refresh must never surface to the user — the lease
  is still valid for up to 7 days, and `WARN_WITHIN_DAYS = 2` already handles
  telling them it is running out.
- `checked_at` must continue to move **only** on a real successful round trip.
  That property is what makes the 7 days honest; nothing local may renew itself.

## Change 2 — Read the lease first, not only on failure

**File:** `src/lib/control/modules.ts` (`entitlementsForSite`, ~line 167)

Today: try control → on throw, read lease.
Wanted, when `keepsLease()`: read lease → if `current`, return it → only call
control when stale or absent.

`leasedEntitlements()` (`modules.ts:302`) already returns the right shape and
already returns `null` for "no usable lease", so the caller keeps its existing
fallback for a machine that has never made contact.

Leave the `catch` fallback in place. Cloud installs are unaffected —
`keepsLease()` is false there and the path is untouched.

Note `leasedEntitlements` deliberately returns `null` for an **expired** lease
rather than an empty module set, so the lock screen handles it rather than every
module silently vanishing. Preserve that.

## Change 3 — Do not enrol a `sid` in Electron

**File:** `src/lib/auth.ts` (~line 375)

`cp2_user_sessions` enforces one-live-session-per-user. On a desktop install the
licence is bound to the **machine serial** (`cp2_devices.serial_number`, mirrored
as `licence_lease.device_serial`), so the "ten tills on one login" abuse the
registry prevents cannot happen there. Tills are licensed per device instead.

The mechanism is already there: a token with **no `sid`** is never evicted
(`session.ts:26`). Two paths already omit it deliberately —
`localSignIn.ts:144` and the till's PIN unlock — with exactly this reasoning
written down. `trySignInOffline` (`auth.ts:257`) also skips `claimSession`.

So this is "don't enrol", not a new branch in the hot path: `requireSession`
already short-circuits on `session.sid &&`.

Side benefit: fixes the lockout where a headless-Chrome or dev-server sign-in
steals the desktop app's seat and evicts it.

## Change 4 — Skip the per-request `getSite` in Electron

**File:** `src/lib/auth.ts` (`requireSite`, ~line 645–691)

A desktop back office can only open a `local` or `hybrid` site — `opensHere()`
(`desktopBackOffice.ts:61`) refuses `cloud`, and it is enforced at three gates
before any page renders: `select-site/page.tsx:37`, `select-site/actions.ts:35`,
and `(app)/layout.tsx:162`.

So by the time `requireSite` re-checks at `auth.ts:691`, the answer was settled
at sign-in. On that machine the site row is static configuration.

`site_profile` (`sql/site/238_site_profile.sql`) already mirrors it locally and
was built for this — its own comment describes it as "exactly the shape
`licence_lease` already uses". Read it via `readSiteProfile()`
(`src/lib/site/siteProfile.ts:165`).

**Accepted trade:** the comment at `auth.ts:653` defends the per-request read so
a site migrated to cloud is caught immediately. After this change that shop
keeps trading locally until the next 5-hour refresh. A cloud migration is a
scheduled act that involves moving the data, so a few hours' lag is acceptable —
but it is a deliberate trade, not an oversight.

## Change 5 — `tabsAreLocal` reads the local mirror (found by measuring)

**File:** `src/lib/site/tabRouting.ts`

Not in the original plan, and it is the reason measuring was worth doing rather
than reasoning from the code.

With changes 1–4 in place the count fell from 4 to 2, not to 0 — and the two
survivors were both `cp2_sites`, from a function the plan never mentioned.
`leasePurpose()` (`lease.ts:71`) calls `tabsAreLocal()` on every lease read to
decide whether a hybrid site's lease lives on the box. That query went to the
control database.

So **reading the lease was itself reaching the control panel** — the exact
dependency the lease exists to remove, hidden one call deeper than the plan
looked. An offline machine would have paid a TCP timeout per page load to find
out where to read its own offline answer from.

`site_profile` already mirrors `connection_type`, so the fix is the same shape
as changes 2 and 4: read the mirror first on desktop, fall through to the
control database otherwise.

---

## Result

Steady state on a desktop install: **zero control-DB calls per click.** One
scheduled call every 5 hours, with the 7-day lease as the accountability
backstop.

Unchanged: the lock screen and telephone unlock (`lockState.ts`, wired at
`(app)/layout.tsx:124`), which already read the same lease and already run per
request against the **local** database.

## What this does NOT cover

Genuine control-panel work still needs the direct connection or a portal
endpoint — billing screens, device registration, module purchases, multi-store
reporting (`storeGroups.ts`). Those are deliberate, occasional acts, not
per-click traffic, and the six licence endpoints already exist via
`portalApi.ts`.

## Verification

Done:

- **4 → 0 control queries per page load**, measured on site 4 with
  `scripts/probe-control-calls.ts`. The intermediate readings are as
  informative as the final one: 4 with `APP_MODE` unset, 2 after changes 1–4
  (which is what exposed change 5), 0 once a lease is held.
- **The lock still fires.** `scripts/probe-lease-expiry.ts` walks a real lease
  backwards through the site's own database: fresh at 1 hour, stale but still
  trading past the refresh window, current at 6 days, **locked at 8 days and at
  90 days**. Unplugging the cable buys nothing.
- **A cloud install is untouched.** Both new primary paths are behind
  `keepsLease()` / `keepsProfile()`, which are `APP_MODE === 'desktop'`; the
  same probe with `APP_MODE` unset still makes all 4 queries.
- **`checked_at` moves only on a real answer.** `refreshEntitlements()`
  deliberately calls `readEntitlementsFromControl()` rather than
  `entitlementsForSite()` — going through the latter would read its own lease,
  renew nothing, and advance the clock from local state.
- **The route is reachable and refuses properly.** `POST /api/licence/refresh`
  on loopback answers 200; the same call with a spoofed `Host` answers 403. It
  does not 307 to the login page, which is what a missing `PUBLIC_PREFIXES`
  entry would have caused.

Left open:

- The dev-server measurements were taken by calling the guard functions
  directly rather than by driving a signed-in browser, so they count the guard
  chain alone. A page also runs its own site-database queries — those are local
  and unaffected, but the end-to-end figure has not been observed in the UI.
- Unrelated, found while running the suites: **migration 234 has not been
  applied to any site** (`pos_table_order_lines.batch_no` is missing on sites
  1, 2 and 33), so `test:pos-tables` fails before its first assertion. Nothing
  to do with this work — see the house rule about migrations being applied
  rather than suggested.
