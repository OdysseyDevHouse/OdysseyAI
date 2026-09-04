import 'server-only'
import type { ConnectionType } from './sites'

/**
 * Which shop a given front door may open.
 *
 * There are two back offices, and each one can reach exactly one kind of shop:
 *
 *   · OdysseyAI Back Office, the Windows EXE, opens LOCAL shops — the ones
 *     whose database sits on a machine in the store, on a LAN nothing outside
 *     the building can route to.
 *   · The web back office, in a browser, opens CLOUD shops — the ones whose
 *     database sits on a server we run.
 *
 * Neither can do the other's job, and the failure when one tries is the worst
 * shape a failure comes in: it works in the office where it was demonstrated
 * and times out at the customer. So the pairing is enforced, in one place, and
 * said in a sentence rather than discovered as a connection timeout on a
 * Monday morning.
 *
 * ── WHY BOTH DIRECTIONS, NOT JUST THE ONE ───────────────────────────────────
 *
 * The desktop half came first, because a back office EXE pointed at a cloud
 * site offers the customer nothing their browser does not already give them and
 * costs them a direct MySQL connection to the control database on 3306 — which
 * works on a whitelisted office IP and nowhere else. That is the wall the setup
 * wizard hit, and the reason electron/posApi.js exists.
 *
 * The web half is the same wall seen from the other side. A local shop's
 * trading data lives on `192.168.x.x` behind the shop's own router; a server in
 * a data centre has no route to it and never will. Listing that shop in the
 * browser's picker draws a door on a wall — the pick succeeds, the session
 * opens, and the first screen that wants a product dies on ETIMEDOUT with no
 * one able to say why.
 *
 * The TILL is deliberately not covered by either rule. A cloud till is a real
 * product — it sells, it holds a licence, and on a bad line it falls back to
 * its own offline store. Only the back office has a second front door doing the
 * same job.
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
 * and `npm run dev:desktop` runs `next dev` as its own process which never
 * receives the environment resolveEnv() assembles — so a developer pointed at a
 * cloud site keeps working.
 *
 * A developer who wants to exercise this puts ODYSSEY_ROLE=backoffice in
 * .env.local, which is the same seam ODYSSEY_ROLE already offers the till.
 */
export function isBackOfficeDesktop(): boolean {
  return process.env.APP_MODE === 'desktop' && process.env.ODYSSEY_ROLE === 'backoffice'
}

/**
 * Is this the web back office — the one people reach in a browser?
 *
 * Anything running under Electron is out by definition: that covers the back
 * office EXE (handled above), the till, and OdysseyAI Database Setup. What is
 * left is a Next server someone points a browser at, and that is the web back
 * office whether it is deployed or a developer's `next dev` — the two are the
 * same code serving the same pages over the same HTTP, and a rule that held in
 * only one of them would be a rule nobody could test before shipping it.
 *
 * ── THE ONE WAY OUT, AND WHO IT IS FOR ──────────────────────────────────────
 *
 * ODYSSEY_CLOUD_ONLY=0 says "this server really can reach a shop's own
 * database". Two situations where that is true rather than wishful:
 *
 *   · a developer working on a LOCAL install's screens from a machine on the
 *     same LAN as the shop's database, which is the only way that work can be
 *     done at all;
 *   · the testing VM, whose sites are marked `local` while their databases sit
 *     on the same box.
 *
 * The rule exists because a data centre has no route to a shop's LAN. Where
 * there demonstrably IS a route, refusing would be enforcing the reason against
 * the fact — so the opt-out exists, and it is deliberately something somebody
 * has to write down rather than a default that quietly applies to whoever is
 * not in production.
 *
 * Read from the environment the SERVER was started with, never from anything a
 * client sends, like every other decision in this file.
 */
export function isCloudBackOffice(): boolean {
  if (process.env.APP_MODE === 'desktop') return false
  return process.env.ODYSSEY_CLOUD_ONLY?.trim() !== '0'
}

/** Can this front door open a site with this connection type at all? */
export function opensHere(connectionType: ConnectionType): boolean {
  /* `hybrid` passes everywhere. Premises tills with the back office elsewhere
     have a local half AND a remote one, and no site is set to it in anger yet —
     refusing it from either side would be guessing at a product that does not
     exist. */
  if (connectionType === 'hybrid') return true
  if (isBackOfficeDesktop()) return connectionType === 'local'
  if (isCloudBackOffice()) return connectionType === 'cloud'
  /* A till, OdysseyAI Database Setup, or a web server told with
     ODYSSEY_CLOUD_ONLY=0 that it can reach a shop's own database. None of them
     is a back office choosing between two front doors, so none of them
     refuses. */
  return true
}

/**
 * What to tell somebody the desktop app turned away from a cloud store.
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

/**
 * And the same, for somebody the web back office turned away from a local
 * store.
 *
 * The remedy is the opposite one and has to be said as plainly: this is not a
 * fault to retry, and nothing they do in this browser will change it. The
 * store's data is on a machine in the store, and the app that reaches it runs
 * on a machine in the store.
 */
export function localSiteMessage(displayName?: string): string {
  const who = displayName?.trim() ? `${displayName.trim()} keeps` : 'This store keeps'
  return (
    `${who} its data on its own premises, where a website has no way to reach ` +
    `it. Open it in OdysseyAI Back Office on a computer in the store instead. ` +
    `The web back office is for stores whose data lives in the cloud.`
  )
}

/**
 * The refusal this front door issues, whichever one it is.
 *
 * For the screens that have to explain a refusal without being told which kind
 * it was — the login page and the site picker, both of which are reached by a
 * redirect carrying nothing but "that did not open here". They do not need the
 * connection type: a given build only ever refuses one kind, so knowing which
 * build is running is the same answer.
 */
export function wrongShellMessage(displayName?: string): string {
  return isCloudBackOffice() ? localSiteMessage(displayName) : cloudSiteMessage(displayName)
}
