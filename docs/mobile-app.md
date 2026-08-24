# The mobile app

An iOS and Android app that is a native shell around the existing back office.
The chrome is the app's; the screens are the same Next pages a browser gets,
rendered in a WebView that is already signed in before it is ever shown.

## What it is, and what it deliberately is not

It is **not** a second front end. There is one dashboard, one widget renderer,
one set of permission checks, and the phone reads all of them. A screen added to
the back office is a screen the app can show; a figure corrected in the back
office is corrected everywhere at once.

It is **not** a browser with an icon either. The refresh token, the biometric
unlock, the back gesture and the store switcher are native, and the person using
it never meets a login form after the first run.

## The parts

| Piece | Where | What it does |
| --- | --- | --- |
| Device register | `sql/tickets/014_mobile_devices.sql` | One row per enrolled phone, holding a hashed refresh token |
| Token library | `src/lib/control/mobileDevices.ts` | Enrol, resolve, list, revoke |
| Auth endpoints | `src/app/api/mobile/auth/` | `login` (once), `session` (every launch), `revoke` |
| Shell signal | `src/lib/mobileShell.ts`, `mobileShellKeys.ts` | Decides which chrome the layout draws |
| Phone chrome | `src/components/MobileTopBar.tsx` | Title bar and drawer, filtered by the real capabilities |
| Stacked dashboard | `src/app/(app)/dashboard/MobileDashboard.tsx` | The same widgets, one column, no drag |
| Revoke list | Setup → Users → the phone icon | Cuts a lost device off |
| Contract test | `scripts/test-mobile-auth-contract.ts` | Locks the three endpoints two apps depend on |
| Native shell | `capacitor.config.ts`, `android/app/src/main/java/…/` | Login, unlock, session exchange, WebView |

### Why the native half is written twice

`LoginActivity` and `OdysseyAuth` are Java, and iOS will need the same thing in
Swift. A shared TypeScript implementation was tried and removed, because it
cannot work:

- **The exchange has to finish before any web content loads.** A JavaScript
  shell is itself a loaded WebView, so it could only hide one login screen
  behind another.
- **A bundled shell runs at its own origin** (`https://localhost`), so a session
  cookie set from a fetch there is a THIRD-PARTY cookie relative to the page
  that needs it — increasingly blocked on Android, blocked by default under iOS
  ITP. The shell could authenticate perfectly and the WebView still not be
  signed in. `CookieManager` writes to the jar directly and has no origin
  problem at all.
- **Biometric unlock belongs before the web layer exists.** If somebody picks up
  an unlocked phone, nothing should render until a face or fingerprint clears.

What IS shared is the contract — three endpoints with fixed field names, and
`npm run test:mobile-auth-contract` asserting them, so a rename fails on the
machine of whoever renamed it rather than in an app-store review queue. The
rules that matter (who may sign in, lockout, 2FA, what a token buys, when it is
revoked) all live on the server and are shared already. What gets duplicated is
an HTTP client with a test behind it.

## How a launch works

```
first run:  tap → native login form → POST /login → token in the Keystore → ↓
every run:  tap → biometric unlock  → POST /session → cookie → WebView at /dashboard
                       (device)         (token → session)      (already signed in)
```

`LoginActivity` is the launcher, not `MainActivity`. That is the whole
arrangement in one line: the WebView is only ever started once a session exists.
A returning device never sees the form — straight from the biometric prompt to
the dashboard.

The exchange runs on **every cold start**, not as a fallback. WKWebView's cookie
store is not reliable across restarts and ITP can evict on its own schedule, so
an app trusting a persisted cookie would show a login form at unpredictable
intervals with nothing to explain it. It also re-runs on resume and on any 401,
because the session is twelve hours and a shift is longer than that.

## Decisions worth not re-litigating

**Cloud-hosted sites only.** Local-backend sites serve plain HTTP over a LAN and
iOS App Transport Security refuses it. The workaround — `NSAllowsArbitraryLoads`
— needs a justification at review and weakens transport security for *every*
customer, including the cloud majority, to accommodate the few on a LAN. Those
sites can join once they can be reached over TLS: either a bundled terminator
with a real certificate, or through the existing WebSocket tunnel in
`server/replicaHost.mjs`.

**Capacitor, not hand-written Kotlin and Swift.** Two hand-written shells means
every drawer tweak is two tickets, for ever. The cost is that the drawer is
web-rendered rather than UIKit — but what actually gives a wrapper away is
scroll bounce, keyboard handling and login screens, none of which are the menu.

**A refresh token, not a long-lived cookie.** The cookie stays the same twelve
hours a browser gets; the thing that survives is an opaque token in the
Keychain/Keystore. That way the credential an attacker could take from the
server side is short-lived, and the one on the device is revocable.

**Mobile sessions carry no `sid`.** They are not enrolled in `cp2_user_sessions`,
so signing in on a phone does not evict the manager's desktop session. The
till's PIN unlock takes the same exit for the same reason — see the field's own
comment in `src/lib/session.ts`. Revocation lives on the device row instead.

**`odyssey_mobile_devices`, never `cp2_devices`.** The latter is where a POS
licence is *sold*, belongs to the v2 backend, and this codebase never creates
rows in it. A phone consumes no licence and must not eat a till seat.

**The dashboard stacks, it does not re-flow.** Measured at 390px, the desktop
grid gave its sidebar 66% of the screen, the narrowest widget one pixel, and
pushed six widgets off the side. A phone breakpoint on that grid would silently
rewrite the arrangement somebody built at their desk, because the layout is a
saved user preference — and drag-to-resize fights the scroll it sits in.

**Read-only, for now.** Dashboard, and later reports and stock lookups. Writing
documents from a phone puts document-number allocation on an unreliable
connection, and a half-submitted purchase order is a genuinely bad failure.

## Building it

Requires Android Studio (which brings its own JDK 21) and, for iOS, a Mac with
Xcode. Nothing else — there is no separate JDK to install.

### First time in a fresh checkout

Two files the build needs are **generated, not committed**, so a clone or a
merge arrives without them and Gradle fails in a way that reads like a broken
project. Both are one command each:

```sh
npm install

# 1. Name the SDK. Gitignored, because it is a path on one machine.
#    FORWARD slashes — Java properties treat a backslash as an escape.
echo "sdk.dir=C:/Users/<you>/AppData/Local/Android/Sdk" > android/local.properties

# 2. Regenerate android/capacitor-cordova-android-plugins/ and the plugin list.
#    Without it: "Could not read script cordova.variables.gradle".
npm run mobile:sync
```

### Every time after that

```sh
npm run mobile:apk     # APK in android/app/build/outputs/apk/debug/
npm run mobile:android # or open it in Android Studio
```

Re-run `npm run mobile:sync` whenever a Capacitor plugin is added or removed, or
`capacitor.config.ts` changes — that is what copies the config into the app.

To point a build at a different server:

```sh
ODYSSEY_APP_URL=https://shop.example.com npm run mobile:sync
```

### iOS (Mac only)

```sh
npx cap add ios && npx cap open ios
```

### Why the app ships no web assets

`webDir` points at `mobile/www`, which holds one placeholder page that is never
shown. Capacitor's CLI requires the directory to exist, but `server.url` wins:
the app loads the live server, because what is being wrapped is a Next app with
server components and a database behind it. There is no static export of that,
and there could not be one without rebuilding the product as an SPA.

If that placeholder ever appears on a device, the build was pointed at a host it
could not reach.

## Verifying a mobile screen

The screenshot script takes `SHOT_HEADERS`, which is how a mobile screen gets
photographed as itself:

```sh
SHOT_VIEWPORT=390x844 SHOT_HEADERS='{"x-odyssey-shell":"mobile"}' npm run shot -- /dashboard
```

A probe cannot stand in for the header. `fetch()` from inside the page only
proves what the server *would* return, and reloading to apply the resulting
cookie tears down the CDP evaluation context mid-call — the run dies with
"Inspected target navigated or closed".

Two traps when writing such a probe:

- Assert on the **rendered** `.react-grid-layout` class, not the string. The
  string also matches a source comment and a type-only import that compiles away.
- Fetch the **desktop** control first. Two fetches in one probe share cookies,
  so a mobile fetch's cookie makes the desktop check look broken.

## Still to do

- iOS project (`npx cap add ios`) — needs a Mac, plus a Swift port of
  OdysseyAuth/LoginActivity against the same contract.
- Reports and stock lookups in the mobile shell.
- Push notifications. Worth doing before App Store review: Guideline 4.2 rejects
  "repackaged websites", and biometric auth plus push is the difference.
- Hide `/upgrade` in the mobile shell, or Apple will require In-App Purchase for
  a subscription sold outside the app.
