import 'server-only'
import type { ConnectionType } from './sites'

/**
 * The one rule that makes OdysseyAI Back Office worth installing.
 *
 * ── WHY A CLOUD SITE IS REFUSED HERE ────────────────────────────────────────
 *
 * A back office EXE pointed at a cloud site offers the customer nothing their
 * browser does not already give them, and costs them a great deal: a direct
 * MySQL connection from a shop's Windows machine to the control database on
 * 3306, which works in an office whose IP is whitelisted and nowhere else. That
 * is the wall the setup wizard hit, and the reason electron/posApi.js exists.
 *
 * So the desktop back office is for LOCAL sites only. A cloud site's back
 * office is a web page, reachable from any browser on any line, with no
 * installer, no update to ship and no firewall to open. Refusing the sign-in
 * says that once, plainly, instead of letting somebody discover it as a
 * connection timeout on a Monday morning.
 *
 * The TILL is deliberately not covered by this. A cloud till is a real product
 * — it sells, it holds a licence, and on a bad line it falls back to its own
 * offline store. Only the back office has a browser that does the same job.
 *
 * ── WHY connection_type AND NOT THE BUILD ───────────────────────────────────
 *
 * `build/backend.txt` says what the INSTALLER believed; cp2_sites.connection_type
 * is what the site actually is, and support can change it without anybody
 * reinstalling anything. That split is already the design — see the docblock at
 * the top of electron/appRole.js — and this follows it rather than inventing a
 * second authority that could disagree.
 */

/**
 * Is this the packaged back office EXE?
 *
 * Both halves are read from the environment the SERVER was started with, never
 * from anything a client says. `ODYSSEY_ROLE` is assigned by
 * electron/runtimeConfig.js from the role baked into package.json at build time.
 *
 * ── ABSENT MEANS "NO", DELIBERATELY ─────────────────────────────────────────
 *
 * Unlike electron/appRole.js, a missing role here does NOT default to
 * `backoffice`. It cannot: this function decides whether to turn somebody away,
 * and the two contexts where the variable is absent are both ones that must
 * never be turned away —
 *
 *   · the WEB build, whose whole job is to serve cloud sites in a browser;
 *   · `npm run dev:desktop`, where `next dev` runs as its own process and never
 *     receives the environment resolveEnv() assembles, so a developer working
 *     against a cloud site keeps working.
 *
 * A developer who wants to exercise this puts ODYSSEY_ROLE=backoffice in
 * .env.local, which is the same seam ODYSSEY_ROLE already offers the till.
 */
export function isBackOfficeDesktop(): boolean {
  return process.env.APP_MODE === 'desktop' && process.env.ODYSSEY_ROLE === 'backoffice'
}

/** Can this machine open a site with this connection type at all? */
export function opensHere(connectionType: ConnectionType): boolean {
  if (!isBackOfficeDesktop()) return true
  /* `hybrid` passes. Premises tills with the back office elsewhere still have
     a local half for this app to serve, and no site is set to it in anger yet —
     refusing it would be guessing at a product that does not exist. */
  return connectionType !== 'cloud'
}

/**
 * What to tell somebody who was turned away.
 *
 * Names the store, because an account with several is the case where a bare
 * refusal is most confusing — one of their stores opens here and another does
 * not, and which is which is the entire question.
 */
export function cloudSiteMessage(displayName?: string): string {
  const who = displayName?.trim() ? `${displayName.trim()} keeps` : 'This store keeps'
  return (
    `${who} its data in the cloud, so this app has nothing to reach that a ` +
    `web browser cannot. Sign in to your back office in your browser instead. ` +
    `OdysseyAI Back Office is for stores whose data lives on their own premises.`
  )
}
