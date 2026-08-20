import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { query, queryOne } from './db'

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
    isPaid: !!r.is_paid,
    status: r.status,
    role: r.site_role,
    isDefault: !!r.is_default,
  }
}

const SELECT_SITE = `
  SELECT s.id, s.site_code, s.company_name, s.trading_name, s.registration_number,
         s.vat_number, s.address1, s.address2, s.address3, s.postal_code,
         s.phone, s.email, s.contact_name, s.connection_type, s.is_paid, s.status,
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
