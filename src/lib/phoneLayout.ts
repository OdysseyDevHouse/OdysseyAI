import 'server-only'
import { cookies, headers } from 'next/headers'
import { isMobileShell } from './mobileShell'
import {
  LAYOUT_PREF_COOKIE,
  LAYOUT_PREF_DESKTOP,
  LAYOUT_PREF_PHONE,
} from './phoneLayoutKeys'

/**
 * Should this request be drawn as a PHONE?
 *
 * ── WHY THIS IS NOT `isMobileShell` ─────────────────────────────────────────
 *
 * `isMobileShell()` answers "am I inside the app's WebView", and that governs
 * CHROME OWNERSHIP: in the app the back gesture, biometric unlock and status
 * bar are drawn natively, so the web layer must not draw its own on top.
 *
 * This answers a different question — "is this a 390px screen" — and the two
 * came apart the moment a customer opened the back office in Safari on their
 * phone. That request owns its own chrome (it has a browser's back button and
 * address bar) but wants exactly the same one-column layout. Answering both
 * questions with one boolean means either the phone browser gets a sidebar it
 * cannot fit, or the app grows a second back button.
 *
 * So: `isMobileShell()` for anything genuinely native, `isPhoneLayout()` for
 * everything about how the page is SHAPED. Every current shell caller wanted
 * the shape, which is why they now read this instead.
 *
 * ── THE ORDER IS THE DESIGN ─────────────────────────────────────────────────
 *
 *   1. An explicit choice        — the person told us; nothing outranks that
 *   2. The app's own signal      — the shell says so on every cold start
 *   3. Client hints, then the UA — a guess, and guesses are wrong sometimes
 *
 * Sniffing is last because it is the only step that can be wrong about a real
 * device, and step 1 exists precisely so that being wrong is a one-tap fix
 * rather than a support call. A layout guess with no override is a bug you
 * cannot ship a remedy for.
 *
 * ── WHY THE SERVER DECIDES, AND NOT A MEDIA QUERY ───────────────────────────
 *
 * Because the thing being switched is a SERVER COMPONENT tree — the layout
 * picks MobileTopBar or Sidebar, and the dashboard picks a whole different
 * component. A width check in the browser can only run after that choice has
 * already been rendered and sent, so the phone would paint the desktop sidebar
 * and then throw it away: a flash of the wrong shell on every single load, plus
 * a hydration mismatch, plus both component trees in the payload.
 *
 * A breakpoint is still the right tool INSIDE a page, and pages should keep
 * using one. This is for the shell-level fork that has to be made before a
 * single byte is sent.
 *
 * ── PRESENTATION ONLY ───────────────────────────────────────────────────────
 *
 * As with the shell signal, deliberately not a security boundary: forging any
 * of this gets you a narrow layout on a desktop, which is a curiosity rather
 * than an escalation. Every capability check, module gate and session check
 * runs identically either way.
 */
export async function isPhoneLayout(): Promise<boolean> {
  const jar = await cookies()

  /*
   * 1. What the person actually asked for.
   *
   * Read first and returned immediately — a preference that only applies when
   * the sniffer already agrees is not a preference, it is a decoration.
   */
  const pref = jar.get(LAYOUT_PREF_COOKIE)?.value
  if (pref === LAYOUT_PREF_PHONE) return true
  if (pref === LAYOUT_PREF_DESKTOP) return false

  // 2. The app. Its own signal is honest and needs no guessing.
  if (await isMobileShell()) return true

  // 3. A guess, from the least-bad evidence available.
  return isPhoneRequest(await headers())
}

/**
 * Does this request come from a handset?
 *
 * Split out from `isPhoneLayout` so the proxy — which has a `NextRequest` and
 * not `next/headers` — can ask the same question with the same answer. Two
 * copies of a UA regex is two copies that drift.
 *
 * ── SEC-CH-UA-MOBILE FIRST ──────────────────────────────────────────────────
 *
 * It is a low-entropy client hint, so Chromium sends it unprompted — no
 * `Accept-CH` round trip, and it is therefore present on the FIRST request,
 * which is the one that renders the shell. It is also a direct statement of
 * what we want to know ("is this a mobile device") rather than something to be
 * inferred from a product string.
 *
 * `?0` is trusted as a NO for the same reason `?1` is trusted as a yes: a
 * browser that sends the hint has answered the question, and second-guessing
 * it with a UA regex would only let the regex overrule better evidence.
 *
 * ── AND A USER-AGENT FALLBACK, RELUCTANTLY ──────────────────────────────────
 *
 * Safari and Firefox send no client hints at all, and Safari on iOS is most of
 * this feature's audience — a customer opening the shop's back office on their
 * own phone. So the fallback is not an edge case, it is half the traffic.
 *
 * `Android` is deliberately paired with `Mobile`: Android tablets send the same
 * platform token and drop `Mobile`, which is exactly the distinction wanted.
 *
 * ── A TABLET IS A DESKTOP HERE ──────────────────────────────────────────────
 *
 * No iPad, no bare Android. A tablet has room for the sidebar and the tables,
 * and giving it the one-column phone layout would waste two thirds of the
 * screen to save a fork nobody asked for. iPadOS also reports itself as a Mac
 * by default, so an iPad rule would be a rule that mostly does not fire.
 */
export function isPhoneRequest(h: {
  get(name: string): string | null
}): boolean {
  const hint = h.get('sec-ch-ua-mobile')
  if (hint === '?1') return true
  if (hint === '?0') return false

  return /iPhone|iPod|Android.*Mobile|Windows Phone/i.test(h.get('user-agent') ?? '')
}

export {
  LAYOUT_PREF_COOKIE,
  LAYOUT_PREF_PHONE,
  LAYOUT_PREF_DESKTOP,
} from './phoneLayoutKeys'
