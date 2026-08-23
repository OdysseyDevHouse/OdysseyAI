import 'server-only'
import { cookies, headers } from 'next/headers'
import {
  MOBILE_SHELL_COOKIE,
  MOBILE_SHELL_HEADER,
  MOBILE_SHELL_VALUE,
} from './mobileShellKeys'

/**
 * Is this request being rendered inside the mobile app's WebView?
 *
 * ── WHY A SIGNAL AND NOT A BREAKPOINT ───────────────────────────────────────
 *
 * Because the difference is not width, it is CHROME OWNERSHIP. In the app the
 * drawer, the title bar and the store switcher are drawn natively by the shell;
 * the web layer must not draw its own on top, or the user gets two menus and
 * two back buttons. A media query cannot know that — a browser window narrowed
 * to 390px still owns its own chrome and still wants the sidebar.
 *
 * ── WHY BOTH A HEADER AND A COOKIE ──────────────────────────────────────────
 *
 * The header is what the native shell actually sets, and it is the honest
 * signal: it rides on every request the WebView makes, including the first.
 *
 * The cookie exists because a WebView does not send custom headers on
 * TOP-LEVEL NAVIGATIONS it initiates itself — a link tapped inside the page, a
 * redirect, a form post. Only the initial load carries them. Without the cookie
 * the first screen would render bare and every screen after it would sprout a
 * desktop sidebar, which looks exactly like a rendering bug and is impossible
 * to reproduce in a browser.
 *
 * ── IT DECIDES PRESENTATION AND NOTHING ELSE ────────────────────────────────
 *
 * Deliberately NOT a security boundary, so it does not matter that a browser
 * can set either one by hand. Anybody who does simply gets the phone layout on
 * a desktop, which is a curiosity rather than an escalation: every capability
 * check, module gate and session check runs exactly as it does for any other
 * request. Nothing here grants access to anything.
 */

export {
  MOBILE_SHELL_HEADER,
  MOBILE_SHELL_COOKIE,
  MOBILE_SHELL_VALUE,
} from './mobileShellKeys'

export async function isMobileShell(): Promise<boolean> {
  const [h, jar] = await Promise.all([headers(), cookies()])
  if (h.get(MOBILE_SHELL_HEADER)?.toLowerCase() === MOBILE_SHELL_VALUE) return true
  return jar.get(MOBILE_SHELL_COOKIE)?.value === MOBILE_SHELL_VALUE
}
