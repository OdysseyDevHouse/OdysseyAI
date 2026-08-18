/**
 * Tying the counter operator to ONE BROWSER TAB.
 *
 * ── THE PROBLEM THIS EXISTS FOR ───────────────────────────────────────────
 *
 * The till cookie answers "who is standing at this machine" and lasts eight
 * hours. That is the right life for a SHIFT, and the wrong one for a TAB: a
 * clerk finishes at the counter, closes the invoicing window and walks away,
 * and for the rest of those eight hours anybody who reopens that window is
 * still signed in as them. Every document typed carries their name, and the
 * screen never once asked who was there.
 *
 * Closing the window is the clearest "I am done here" a person ever gives us,
 * and until now the app ignored it.
 *
 * ── WHY sessionStorage AND NOT A SESSION COOKIE ───────────────────────────
 *
 * The obvious fix is a cookie with no `maxAge`, which browsers drop when the
 * BROWSER closes. It is not enough, twice over:
 *
 *   1. It survives a closed TAB. The browser is still running — on a shop's
 *      back-office PC it stays running all day — so the exact scenario above
 *      is untouched.
 *   2. "Continue where you left off" (on by default in Chrome, and the norm on
 *      a machine somebody actually works at) restores session cookies across a
 *      full restart, so it does not even reliably survive that.
 *
 * `sessionStorage` is the one store with genuinely per-tab lifetime: a new tab
 * starts empty, a closed tab's copy is gone, and it is never restored into a
 * tab the user opened themselves. So the tab mints a random id there, and the
 * till token is signed to that id. No id, or a different one, means a tab that
 * did not do the signing in — which is precisely the case we are refusing.
 *
 * ── AND WHY A SECOND, READABLE COOKIE ─────────────────────────────────────
 *
 * The check has to happen on the SERVER, because that is where the operator is
 * resolved and where a client-side gate could simply be skipped. But a server
 * cannot read `sessionStorage`. So the tab copies its id into a plain cookie
 * that the server compares against the signed claim in the till token.
 *
 * That cookie is deliberately NOT the security boundary and does not need to
 * be httpOnly or unguessable — forging it buys nothing, because the id must
 * MATCH the one signed into the till token, and that token is httpOnly and
 * signed. What the cookie carries is a claim about which tab is asking; what
 * makes it trustworthy is that the tab which signed in is the only one that
 * ever knew the value.
 *
 * ── ONE ID PER TAB, NOT PER WINDOW-NAME ───────────────────────────────────
 *
 * The till and invoicing both open into NAMED windows (see `openTill.ts`), so
 * pressing "Point of sale" twice reuses the same tab rather than opening a
 * second. That reuse keeps the tab alive, which keeps its `sessionStorage` and
 * therefore its sign-in — which is exactly right: the operator never left.
 * Closing it and pressing the button again is a new tab with a new id, and a
 * PIN pad.
 */

/**
 * The cookie the tab writes its id into, for the server to compare.
 *
 * Read on the server by `windowIdFromCookies`, written on the client by
 * `ensureWindowId`. Not httpOnly by necessity — the tab has to write it — see
 * the module note on why that costs nothing.
 */
export const WINDOW_COOKIE = 'odyssey_wid'

/** Where the tab keeps its own copy. Cleared by the browser when the tab dies. */
const STORAGE_KEY = 'odyssey_wid'

/**
 * This tab's id, minting one if it has none.
 *
 * Client only — it touches `sessionStorage` and `document.cookie`. Returns ''
 * on the server, which callers treat as "cannot answer yet" rather than as a
 * mismatch: a server render has no tab to ask.
 *
 * The cookie is rewritten on every call rather than only at mint. It is a
 * session cookie, so a browser restart that restores the TAB (and with it
 * `sessionStorage`) can still have dropped the cookie — rewriting means such a
 * tab keeps working instead of silently falling back to the PIN pad with a
 * perfectly good session behind it.
 */
export function ensureWindowId(): string {
  if (typeof window === 'undefined') return ''

  let id = ''
  try {
    id = window.sessionStorage.getItem(STORAGE_KEY) ?? ''
    if (!id) {
      id = newWindowId()
      window.sessionStorage.setItem(STORAGE_KEY, id)
    }
  } catch {
    /* sessionStorage can throw outright — Safari's private mode historically,
       and any browser with storage blocked for the site. Returning '' means the
       operator gets the PIN pad every time rather than a broken screen: the
       stricter of the two failures, which is the correct way for a lock to
       fail. */
    return ''
  }

  /* `SameSite=Lax`, no `Max-Age`: a session cookie, so it is ALSO dropped when
     the browser closes. Belt and braces — the sessionStorage id is what the
     rule actually rests on, but there is no reason to leave the weaker copy
     lying around longer than the stronger one. */
  document.cookie = `${WINDOW_COOKIE}=${encodeURIComponent(id)}; Path=/; SameSite=Lax`
  return id
}

/** This tab's id if it already has one, without minting. */
export function currentWindowId(): string {
  if (typeof window === 'undefined') return ''
  try {
    return window.sessionStorage.getItem(STORAGE_KEY) ?? ''
  } catch {
    return ''
  }
}

/**
 * Forgets this tab's id, so the next look asks for a PIN.
 *
 * Used when the operator signs out by hand. The till cookie is cleared by the
 * server action at the same moment; this clears the other half so a stale id
 * cannot be paired with a freshly minted token.
 */
export function clearWindowId(): void {
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    /* Nothing to do — the id is unreadable either way. */
  }
  document.cookie = `${WINDOW_COOKIE}=; Path=/; SameSite=Lax; Max-Age=0`
}

/**
 * A fresh id.
 *
 * `randomUUID` where it exists, which is everywhere this app runs; the fallback
 * is for an insecure origin (plain http on a shop's LAN), where `crypto` is
 * present but `randomUUID` is not. Unguessability is not what makes this safe —
 * see the module note — so a weaker fallback is acceptable where the alternative
 * is a till that cannot sign anybody in.
 */
function newWindowId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID()
    }
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
      const bytes = new Uint8Array(16)
      crypto.getRandomValues(bytes)
      return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
    }
  } catch {
    /* Fall through to the last resort below. */
  }
  return `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Whether a till token's window claim matches the tab that is asking.
 *
 * Pure and exported so the rule can be tested without a browser or a database,
 * and because it is the whole of the policy — every subtlety is in these four
 * lines and each one is a way to get it wrong:
 *
 *   • A token with NO claim (`undefined`) is accepted. Those are the tokens
 *     minted before this shipped, and refusing them would sign every counter in
 *     the country out at deploy time, mid-trade. They age out within eight
 *     hours on their own.
 *   • A token WITH a claim and a request with no cookie is refused. That is the
 *     case this feature exists for: a reopened tab has no `sessionStorage`, so
 *     it sends nothing, and the eight-hour cookie alone must not be enough.
 *   • Mismatched ids are refused — a second tab, or one whose storage was
 *     cleared.
 */
export function windowMatches(claim: string | undefined, cookie: string | null): boolean {
  if (!claim) return true
  if (!cookie) return false
  return claim === cookie
}
