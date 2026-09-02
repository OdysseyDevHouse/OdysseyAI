import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { query, queryOne, execute } from './db'
import { keepsProfile, readSiteProfile, writeSiteProfile } from './site/siteProfile'

export type SiteRole = 'owner' | 'manager' | 'staff'

/**
 * Where this site's back office finds its database. Set per site in the control
 * panel, which is why it lives on cp2_sites rather than in any site database.
 *
 *  - `cloud`  — the back office connects to a server we run.
 *  - `local`  — it connects to a server on the shop's own premises.
 *  - `hybrid` — premises tills keep serving while the back office lives
 *               elsewhere. Not built yet; no site is set to it in anger.
 */
export type ConnectionType = 'cloud' | 'local' | 'hybrid'

export type Site = {
  id: number
  code: string
  companyName: string
  tradingName: string | null
  /** Name to show in the UI — trading name when set, else the registered one. */
  displayName: string
  registrationNumber: string | null
  vatNumber: string | null
  address1: string | null
  address2: string | null
  address3: string | null
  postalCode: string | null
  phone: string | null
  email: string | null
  contactName: string | null
  connectionType: ConnectionType
  /**
   * What KIND of shop this is — a row in cp2_site_types, set in the control
   * panel. Null on a site nobody has classified, which is most of them.
   *
   * Carried on the session's site rather than fetched where it is wanted,
   * because the first thing that wants it is the till's sign-in screen: it
   * picks the stock photograph behind the PIN pad from this. That screen stands
   * between a cashier and the till at 07:00, and a second round trip to the
   * control database to decide which picture to paint is a round trip somebody
   * waits through. It costs one more column on a SELECT that already runs.
   */
  siteTypeId: number | null
  isPaid: boolean
  status: 'active' | 'suspended' | 'archived'
  /** From cp2_user_sites — this user's role at this site. */
  role: SiteRole
  isDefault: boolean
}

type SiteRow = RowDataPacket & {
  id: number
  site_code: string
  company_name: string
  trading_name: string | null
  registration_number: string | null
  vat_number: string | null
  address1: string | null
  address2: string | null
  address3: string | null
  postal_code: string | null
  phone: string | null
  email: string | null
  contact_name: string | null
  connection_type: ConnectionType
  site_type_id: number | null
  is_paid: number
  status: 'active' | 'suspended' | 'archived'
  site_role: SiteRole
  is_default: number
}

function mapSite(r: SiteRow): Site {
  return {
    id: r.id,
    code: r.site_code,
    companyName: r.company_name,
    tradingName: r.trading_name,
    displayName: r.trading_name?.trim() || r.company_name,
    registrationNumber: r.registration_number,
    vatNumber: r.vat_number,
    address1: r.address1,
    address2: r.address2,
    address3: r.address3,
    postalCode: r.postal_code,
    phone: r.phone,
    email: r.email,
    contactName: r.contact_name,
    connectionType: r.connection_type,
    /* Coerced, not passed through: the column is a nullable int and MySQL hands
       it back as a string in some driver configurations, which would make
       `siteTypeId === 5` quietly false and every shop show the default picture. */
    siteTypeId: r.site_type_id === null ? null : Number(r.site_type_id) || null,
    isPaid: !!r.is_paid,
    status: r.status,
    role: r.site_role,
    isDefault: !!r.is_default,
  }
}

const SELECT_SITE = `
  SELECT s.id, s.site_code, s.company_name, s.trading_name, s.registration_number,
         s.vat_number, s.address1, s.address2, s.address3, s.postal_code,
         s.phone, s.email, s.contact_name, s.connection_type, s.site_type_id,
         s.is_paid, s.status,
         us.site_role, us.is_default
    FROM cp2_user_sites us
    INNER JOIN cp2_sites s ON s.id = us.site_id
`

/**
 * Every site this user may open, default first.
 *
 * This is the ONLY place site access is decided. Both the link row and the site
 * itself must be usable — a suspended link or an archived site drops out here,
 * so no caller has to remember to re-check.
 */
export async function listSitesForUser(userId: number): Promise<Site[]> {
  const rows = await query<SiteRow>(
    `${SELECT_SITE}
      WHERE us.user_id = ?
        AND us.status = 'active'
        AND s.status IN ('active','suspended')
      ORDER BY us.is_default DESC, s.company_name ASC`,
    [userId],
  )
  return rows.map(mapSite)
}

/**
 * One site, but only if this user may open it. Returns null otherwise — which
 * is what makes a tampered site id in a cookie harmless.
 */
/**
 * One site, without asking which user may open it.
 *
 * ── WHY THIS IS NOT A HOLE IN THE ONE PLACE ACCESS IS DECIDED ──────────────
 *
 * `listSitesForUser` is that place and stays that place. This exists for the
 * one caller where the question does not apply: a LOCAL install, where the
 * machine serves exactly one shop and the person signing in is a row in that
 * shop's own `users` table — not a control-panel account at all.
 *
 * Asking cp2_user_sites there compares a site `users.id` against
 * `cp2_user_sites.user_id`, two unrelated id spaces that happen to both be
 * small integers. It matches nothing, and the shop owner is bounced to a
 * picker offering shops this machine cannot open. Which is exactly what it did.
 *
 * The access decision has already been made, earlier and more strictly: this
 * machine was provisioned for this site, and the session was minted against
 * that site's own users. Re-asking the control panel adds nothing and, on a
 * shop with no line that morning, cannot be answered at all.
 *
 * Suspended sites are still returned so a caller can say WHICH kind of no it
 * is; archived ones are gone rather than withheld.
 */
/**
 * A desktop machine that has never once reached the control panel.
 *
 * ── WHY THIS IS A TYPE AND NOT JUST A MESSAGE ───────────────────────────────
 *
 * It used to be a bare `new Error(...)` with the explanation in the string, and
 * the explanation was good — but nothing could TELL it apart from a genuine
 * fault, so it landed on global-error.tsx, which is a diagnostic screen. A shop
 * owner opening their back office for the first time got a stack trace naming
 * three Turbopack chunks above a sentence they had to read past.
 *
 * The condition is not a fault. It is an ordinary state with one remedy, known
 * in advance, and it wants the same treatment as an expired lease: a screen
 * that says what happened and what to do. Being a distinguishable type is what
 * lets `(app)/layout.tsx` catch exactly this and nothing else — importantly not
 * the redirect() signal, which is also a throw and must be allowed past.
 *
 * The remedy runs out exactly once per machine: after one successful sign-in
 * with a working line, writeSiteProfile() has a mirror and this branch is
 * unreachable for good.
 */
export class StoreDetailsUnavailableError extends Error {
  /* A property rather than relying on instanceof alone: the server bundle and
     a route chunk can end up with separate copies of a class, and a check that
     silently stops matching would put the stack trace back on screen. */
  readonly storeDetailsUnavailable = true

  constructor(options?: { cause?: unknown }) {
    super(
      'This machine has not yet stored its store details, so it cannot open without an ' +
        'internet connection. Connect it to the internet and sign in once — after that it ' +
        'will work offline.',
      options,
    )
    this.name = 'StoreDetailsUnavailableError'
  }
}

/**
 * The socket errors a machine with no line produces.
 *
 * ENETUNREACH is the one that started this — `connect ENETUNREACH 105.30.57.88:3306`
 * on a shop's screen, twice, from two different unguarded control reads. The
 * rest are the same condition wearing a different coat depending on where the
 * connection died: no route, no DNS, a firewall that refuses rather than drops,
 * or one that drops rather than refuses.
 *
 * Checked down the `cause` chain because mysql2 wraps, and because
 * StoreDetailsUnavailableError deliberately carries the original as its cause.
 */
const OFFLINE_CODES = new Set([
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNRESET',
  'EPIPE',
  'PROTOCOL_CONNECTION_LOST',
  'ER_GET_CONNECTION_TIMEOUT',
])

/**
 * Could this machine simply not reach the control panel?
 *
 * The question a gate screen asks. It is deliberately BROADER than
 * isStoreDetailsUnavailable: that names one known state, this names the whole
 * family of "the line is down", which is what a shop owner actually sees and
 * what they can actually act on.
 *
 * Never used to decide whether to TRUST something — only whether to show a
 * sentence instead of a stack trace. A false positive here costs a friendlier
 * error message on a genuine fault; the same guess used to grant access would
 * be a security decision, and it is not made anywhere.
 */
export function isControlUnreachable(err: unknown): boolean {
  if (isStoreDetailsUnavailable(err)) return true
  let cur: unknown = err
  for (let depth = 0; cur && depth < 5; depth++) {
    /* ── A DESKTOP BUILD REFUSING ITS OWN SOCKET COUNTS AS UNREACHABLE ──────
     *
     * ControlDbUnavailableOnDesktop is thrown by pool() rather than raised by a
     * network stack, so it carries no errno and the code walk below never sees
     * it. It belongs here all the same: to the person reading the screen it is
     * the SAME situation as a dead line — something this machine needed from us
     * is out of reach, the shop's own data is fine, and the remedy is a
     * connection.
     *
     * The distinction that does matter is kept elsewhere. A raw ECONNREFUSED
     * means the line is down; this means the answer must come from the POS API
     * and no route served it. Both send the owner to the same screen, and both
     * leave a named error in the log for whoever has to fix the route. */
    if ((cur as { name?: unknown }).name === 'ControlDbUnavailableOnDesktop') return true
    const code = (cur as { code?: unknown }).code
    if (typeof code === 'string' && OFFLINE_CODES.has(code)) return true
    cur = (cur as { cause?: unknown }).cause
  }
  return false
}

/** One link in a `cause` chain, flattened to strings a screen can render. */
export type ErrorLink = { name: string; code: string | null; message: string }

/**
 * The whole `cause` chain, as plain strings.
 *
 * Same walk and same depth limit as isControlUnreachable — and for the same
 * reason: mysql2 wraps, and StoreDetailsUnavailableError deliberately carries
 * the original underneath. The useful sentence is rarely the outermost one.
 * `connect ECONNREFUSED 127.0.0.1:3306` is two links down and names both the
 * fault and the address that produced it.
 *
 * Strings rather than the Error itself because this crosses into a rendered
 * screen: an Error is not serialisable, and a stack is not what a person
 * commissioning a server needs — the code and the address are.
 */
export function describeErrorChain(err: unknown, maxDepth = 5): ErrorLink[] {
  const chain: ErrorLink[] = []
  let cur: unknown = err
  for (let depth = 0; cur && depth < maxDepth; depth++) {
    const e = cur as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown }
    chain.push({
      name: typeof e.name === 'string' ? e.name : typeof cur,
      code: typeof e.code === 'string' ? e.code : null,
      message: typeof e.message === 'string' ? e.message : String(cur),
    })
    cur = e.cause
  }
  return chain
}

/** Is this the first-run-with-no-line case, rather than a real failure? */
export function isStoreDetailsUnavailable(err: unknown): err is StoreDetailsUnavailableError {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { storeDetailsUnavailable?: unknown }).storeDetailsUnavailable === true
  )
}

export async function getSite(siteId: number): Promise<Site | null> {
  /* ── ON A DESKTOP INSTALL THE MIRROR IS THE PRIMARY ANSWER ───────────────
   *
   * requireSite() calls this on every authenticated page and it is not
   * memoised, so read from the control database it was a round trip per click
   * — over a line that database is IP-whitelisted away from.
   *
   * What it answers is "which shop is this machine", and on a machine Setup
   * provisioned for one shop that is static configuration. The one field that
   * can change underneath a session is connection_type, and a desktop back
   * office cannot open a cloud site at all: opensHere() refuses it at the site
   * picker, at selectSiteAction and in the (app) layout, all before a page
   * renders. So a migration is caught at the next sign-in or refresh rather
   * than mid-request — a scheduled act that involves moving the data, not a
   * surprise.
   *
   * Freshness is deliberately NOT checked. Unlike the licence lease, nothing
   * here gates trading, so a stale shop name is a cosmetic wrong and a round
   * trip per click is not worth avoiding it. writeSiteProfile() below refreshes
   * the mirror whenever the control database is read for any other reason.
   */
  if (keepsProfile()) {
    const mirrored = await readSiteProfile(siteId)
    if (mirrored) return mirrored.site
  }

  let row: SiteRow | null
  try {
    row = await queryOne<SiteRow>(
      `SELECT s.id, s.site_code, s.company_name, s.trading_name, s.registration_number,
              s.vat_number, s.address1, s.address2, s.address3, s.postal_code,
              s.phone, s.email, s.contact_name, s.connection_type, s.site_type_id,
              s.is_paid, s.status,
              NULL AS site_role, 1 AS is_default
         FROM cp2_sites s
        WHERE s.id = ?
          AND s.status IN ('active','suspended')
        LIMIT 1`,
      [siteId],
    )
  } catch (err) {
    /* ── THE CONTROL DATABASE IS UNREACHABLE ────────────────────────────────
     *
     * On an adopted local install this is the ordinary state of a shop whose
     * line is down, and it used to be fatal: requireSite() calls this on every
     * authenticated page, so a machine holding all of its own trading data
     * could sign in against its own users table and then fail to draw a stock
     * screen — because it could not find out what the shop was called.
     *
     * The mirror is the last thing the control panel said, written on every
     * successful read above. Desktop only, and it answers "which shop is this
     * machine" rather than "which shops may this person open" — which is why
     * the fallback is here and NOT in getSiteForUser below, where it would be
     * a stale copy standing in for an access check.
     *
     * Null when there is nothing to trust: no mirror yet, or one belonging to a
     * different shop. The throw is then re-raised, so the failure is reported
     * as what it is — a database that could not be reached — rather than as a
     * missing site. See lib/site/siteProfile.ts and sql/site/238.
     */
    const mirrored = await readSiteProfile(siteId)
    if (mirrored) return mirrored.site

    /* Nothing mirrored yet. On a desktop install that is a real state with a
       real remedy, and an ENETUNREACH stack trace names neither — so it is
       said in a sentence instead. It happens exactly once per machine: until
       this shop has been opened with a working line at least once, there is
       nothing for the offline copy to have copied. */
    if (keepsProfile()) {
      throw new StoreDetailsUnavailableError({ cause: err })
    }
    throw err
  }

  if (!row) return null
  const site = mapSite(row)
  /* Unawaited: the answer is already in hand, and a request that got it must
     never be failed by a failure to write it down. */
  void writeSiteProfile(site)
  return site
}

export async function getSiteForUser(userId: number, siteId: number): Promise<Site | null> {
  const row = await queryOne<SiteRow>(
    `${SELECT_SITE}
      WHERE us.user_id = ?
        AND us.site_id = ?
        AND us.status = 'active'
        AND s.status IN ('active','suspended')
      LIMIT 1`,
    [userId, siteId],
  )
  return row ? mapSite(row) : null
}

/**
 * The shop's public name, for the storefront header.
 *
 * Returns ONLY the name — deliberately not a `Site`, which carries the VAT
 * number, registration number, contact email and postal address. None of that
 * belongs in a public page's props, and returning the whole record here would
 * put it one careless `JSON.stringify` away from being served to shoppers.
 *
 * Not user-scoped, because a storefront visitor has no account. The caller has
 * already proved which site it may serve by verifying the signed store token.
 */
export async function publicSiteName(siteId: number): Promise<string | null> {
  const row = await queryOne<{ company_name: string; trading_name: string | null }>(
    `SELECT company_name, trading_name FROM cp2_sites
      WHERE id = ? AND status = 'active' LIMIT 1`,
    [siteId],
  )
  if (!row) return null
  return row.trading_name?.trim() || row.company_name
}

/**
 * The ids of every active site, for unattended background work.
 *
 * Ids only, and deliberately so: this is for a scheduler sweeping sites with no
 * user in the picture, and it must not become a way to enumerate company
 * details. Anything needing more than an id should go through the user-scoped
 * functions above.
 *
 * Suspended sites are EXCLUDED — unlike `listSitesForUser`, which includes them
 * so their owner can still sign in and settle the account. A suspended site
 * should stop emailing reports out, not carry on as though nothing happened.
 */
export async function activeSiteIds(): Promise<number[]> {
  const rows = await query<{ id: number }>(
    `SELECT id FROM cp2_sites WHERE status = 'active' ORDER BY id`,
  )
  return rows.map((r) => Number(r.id))
}

/**
 * The fields a shop may change about itself.
 *
 * Deliberately NOT the whole row. `connection_type`, `status`, `is_paid`,
 * `site_code` and `site_type_id` are decisions made ABOUT a shop by the people
 * who run the platform — a customer who could set their own `is_paid` or flip
 * themselves to `local` would be editing their bill and their licence, not
 * their letterhead. Those stay in the control panel, where they always were.
 */
export type SiteDetails = {
  companyName: string
  tradingName: string | null
  registrationNumber: string | null
  vatNumber: string | null
  address1: string | null
  address2: string | null
  address3: string | null
  postalCode: string | null
  phone: string | null
  email: string | null
  contactName: string | null
}

/**
 * What each editable field may hold, straight from the live column widths.
 *
 * Checked here rather than trusted to `maxLength` on the input: an over-long
 * value silently TRUNCATES on the way into MySQL, so a VAT number typed one
 * character too long would be saved wrong rather than refused — and it prints
 * on every tax invoice after that. The numbers match `SHOW COLUMNS FROM
 * cp2_sites`; a widened column is a one-line change here.
 */
export const SITE_DETAIL_LIMITS = {
  companyName: 255,
  tradingName: 255,
  registrationNumber: 60,
  vatNumber: 60,
  address1: 255,
  address2: 255,
  address3: 255,
  postalCode: 20,
  phone: 50,
  email: 255,
  contactName: 150,
} as const satisfies Record<keyof SiteDetails, number>

/**
 * Change what this shop says it is.
 *
 * ── WHY THIS REPO WRITES A TABLE THE v2 BACKEND OWNS ────────────────────────
 *
 * cp2_sites is the v2 backend's, and this app has only ever read it. That was
 * fine while a shop's own address could only be corrected by support, and it
 * stopped being fine the moment the shop was asked to keep it right: the
 * details print on every invoice, statement and purchase order the business
 * sends out, and "ring us and we will change it" is not a way to run a
 * letterhead.
 *
 * So this writes the same columns v2 writes, rather than inventing a second
 * place. A shop's address is one fact; two tables holding it is two answers,
 * and the one that prints would be whichever the reader happened to pick. The
 * identity half stays put — see SiteDetails above for what a shop may NOT set
 * about itself.
 *
 * ── AND WHY ONLY A CLOUD SITE MAY CALL IT ───────────────────────────────────
 *
 * Not enforced here — the caller does it, because the caller is the one that
 * can say why in a sentence the person reads. But the reason belongs with the
 * write: on a local install the control database is across a line that is
 * routinely down, so this either throws or, worse, succeeds against a shop that
 * cannot then be told its own answer changed. The mirror flows one way, control
 * panel → shop, and this keeps it that way.
 *
 * Returns false when no row moved — an archived site, or an id that is gone.
 */
export async function updateSiteDetails(
  siteId: number,
  details: SiteDetails,
  updatedBy: number | null = null,
): Promise<boolean> {
  const result = await execute(
    `UPDATE cp2_sites
        SET company_name = ?, trading_name = ?, registration_number = ?, vat_number = ?,
            address1 = ?, address2 = ?, address3 = ?, postal_code = ?,
            phone = ?, email = ?, contact_name = ?,
            updated_by = COALESCE(?, updated_by), updated_at = NOW()
      WHERE id = ? AND status IN ('active','suspended')`,
    [
      details.companyName,
      details.tradingName,
      details.registrationNumber,
      details.vatNumber,
      details.address1,
      details.address2,
      details.address3,
      details.postalCode,
      details.phone,
      details.email,
      details.contactName,
      updatedBy,
      siteId,
    ],
  )

  if (result.affectedRows === 0) return false

  /*
   * Re-read and re-mirror, rather than writing the mirror from `details`.
   *
   * getSite() writes the mirror off the back of a successful read, so this both
   * confirms what actually landed and keeps ONE piece of code responsible for
   * the copy. Writing the mirror from the input would record what we asked for
   * — including any value the column truncated — as though the control panel
   * had said it.
   *
   * Unawaited failure is fine: the row is changed either way, and a mirror one
   * page load stale is what every other read already tolerates.
   */
  await getSite(siteId).catch(() => null)
  return true
}
