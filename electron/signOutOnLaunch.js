// Every launch of the .exe starts at the login screen.
//
// ── WHY THE DESKTOP APP CANNOT BEHAVE LIKE THE WEBSITE ──────────────────────
//
// On the web a twelve-hour session is a convenience: the tab belongs to one
// person, on one machine, and coming back to it an hour later and still being
// signed in is the whole point of a session cookie.
//
// A shop's back-office PC is the opposite of that. It is a SHARED machine — the
// owner, the bookkeeper and whoever is covering the counter all sit at the same
// keyboard through the day — and closing the app is how a person there says
// "I have finished". If the session survived that, the next person to double
// click the icon would be signed in as the last one: their name on every
// document they issue, their capabilities in every menu, and no moment anywhere
// at which anyone chose to be them.
//
// So the session cookie is dropped from Chromium's jar at every startup, before
// the window is pointed at the app. `getSession()` then finds nothing, the root
// route renders the login form, and the first thing the .exe shows is a person
// being asked who they are.
//
// ── WHY THIS IS DONE HERE AND NOT IN THE SERVER ─────────────────────────────
//
// The Next server has no idea it is being started rather than merely serving a
// request — and on a hybrid site it is not restarted at all, because the box on
// the shop LAN keeps running while the front-of-house PC is switched off and
// on. "The app has just been opened" is a fact only the shell holds, so the
// shell is what acts on it.
//
// It also keeps the web deployment completely untouched. Nothing about
// `setSessionCookie` changes, so a browser session is still twelve hours.
//
// ── WHY NOT session.clearStorageData() ──────────────────────────────────────
//
// Because that would take the machine's identity with it. localStorage holds
// the device id the licence is issued against, the offline outbox of sales not
// yet uploaded, and the cached catalogue. Wiping those to achieve a login
// prompt would un-license the machine and lose trade, which is a spectacular
// price for a sign-out. Named cookies only.

const AUTH_COOKIES = [
  /* The back office session — the one that decides whether `/` is the login
     form or the dashboard. */
  'odyssey_session',
  /* Who is standing at the till. Eight hours, and it is a SECOND identity: a
     back-office session cleared without this one would leave the previous
     cashier still attributed on the next sale. Cleared together or not at
     all. */
  'odyssey_till',
  /* The tab marker the till session is bound to. Stale rather than dangerous —
     `windowMatches` fails closed — but leaving it behind serves no purpose once
     the session it names is gone. */
  'odyssey_wid',
]

/**
 * Drop the signed-in state from the Chromium profile.
 *
 * `url` is the origin the cookies were set on. It is required rather than
 * guessed: Chromium stores cookies per host, and `cookies.remove` matches on
 * the URL, so removing them from the wrong origin silently succeeds and
 * removes nothing — the failure mode being the exact bug this file exists to
 * prevent, presenting as "it still remembers me".
 *
 * Best-effort by design. A profile that cannot be read is not a reason to
 * refuse to start the shop; the worst case is the behaviour we had before this
 * existed.
 */
async function signOutOnLaunch(session, url) {
  if (!session || !url) return

  for (const name of AUTH_COOKIES) {
    try {
      /* Removed by NAME rather than by listing and filtering: a cookie set with
         a different path or domain than we expect still has to go, and
         `cookies.get({name})` returning nothing is a legitimate state — the
         first ever launch — rather than something to log about. */
      const found = await session.cookies.get({ url, name })
      for (const cookie of found) {
        await session.cookies.remove(url, cookie.name)
      }
    } catch {
      /* One cookie failing must not stop the others being cleared. */
    }
  }
}

module.exports = { signOutOnLaunch, AUTH_COOKIES }
