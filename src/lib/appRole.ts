'use client'

/**
 * Which desktop installer this machine is running, as seen from the renderer.
 *
 * Electron's preload exposes it; a browser exposes nothing, and that is the
 * important case rather than an edge one. The web build genuinely HAS a back
 * office, so an unknown role must keep every button — never hide one on the
 * assumption that the shell would have said otherwise.
 *
 * ── PRESENTATION ONLY ─────────────────────────────────────────────────────
 *
 * This hides what a machine cannot usefully do. It is not what STOPS it: the
 * till build's real constraint is the will-navigate guard in electron/main.js,
 * and the actual authority over what anybody may do is capabilities on the
 * server. Nothing here should ever be the only thing preventing an action.
 */

export type AppRole = 'backoffice' | 'pos' | 'database'

type OdysseyBridge = {
  isDesktop?: boolean
  role?: AppRole
}

function bridge(): OdysseyBridge | undefined {
  if (typeof window === 'undefined') return undefined
  return (window as unknown as { odyssey?: OdysseyBridge }).odyssey
}

/**
 * The role, or null when nothing said — SSR, or a browser.
 *
 * Null is not "unknown, assume the worst". It means "this is not a
 * purpose-built desktop install", which for a browser is simply true.
 */
export function appRole(): AppRole | null {
  return bridge()?.role ?? null
}

/**
 * Is this the till build — the one with no back office to reach?
 *
 * False during SSR and in a browser, so a screen rendered on the server keeps
 * its full shape and does not flicker a button away on hydration.
 */
export function isPosBuild(): boolean {
  return appRole() === 'pos'
}
