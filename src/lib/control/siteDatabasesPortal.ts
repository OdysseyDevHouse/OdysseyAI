import 'server-only'
import { portalConfig, send } from './portalApi'
import { openPortalEnvelope } from './payloadEnvelope'

/**
 * Where this shop's OTHER databases live, asked over HTTPS instead of a MySQL
 * socket.
 *
 * ── THE ONE LOOKUP givenConnection COULD NOT COVER ──────────────────────────
 *
 * A desktop install is handed its own database in the environment, and
 * siteDb.givenConnection() answers from those values without asking anybody.
 * That covers the `master` purpose, which is almost every query a shop makes —
 * and it is why an adopted install can trade with the line down.
 *
 * It stops at master, deliberately. A HYBRID site keeps its open tabs on an
 * in-store box: a second cp2_site_databases row, with its own credentials and
 * its own lifecycle. givenConnection() returns null for it rather than handing
 * back the master's details under another purpose's name, so that one lookup
 * fell through to a direct read of the control database — the last live 3306
 * call an adopted install makes in normal operation, measured.
 *
 * This is the same question over the transport a shop's line actually allows.
 *
 * ── null MEANS "ASK THE DATABASE YOURSELF" ──────────────────────────────────
 *
 * As in entitlementsPortal and devicesPortal: no key, no line, or an answer
 * that was not one. The caller then runs the query it always ran, which on a
 * cloud install is the ordinary path and the right one. A refusal lands here
 * too — the caller's next step is the same either way, and treating a refusal
 * as "this site has no such database" would send a hybrid till to write its
 * tabs into the cloud.
 */

/** One row, as the portal shapes it. Mirrors shapeDatabase on the server. */
type WireDatabase = {
  id: number
  purpose: string
  locationName: string
  serverHost: string
  serverPort: number
  databaseName: string
  dbUsername: string | null
  dbEngine: string
  isManaged: boolean
  status: 'active' | 'inactive'
  hasPassword: boolean
  /** `pos:v1:` sealed to this build's payload key. Null when none is stored. */
  password: string | null
  passwordError?: string | null
}

type Payload = { databases: WireDatabase[] }

/**
 * What the caller gets: the connection, with its password already opened.
 *
 * Deliberately NOT the app's `SiteDatabase` type. That one carries
 * `credentialsUsable` and expects the password to be read separately from an
 * ENCRYPTION_KEY-sealed column; here the password arrives in the same answer,
 * sealed to the build's payload key instead. Keeping the shapes apart stops a
 * caller from assuming the two are interchangeable — see siteDb.ts, which maps
 * this into its own type at the one place it is used.
 */
export type PortalSiteDatabase = {
  id: number
  purpose: string
  locationName: string
  host: string
  port: number
  databaseName: string
  username: string | null
  engine: string
  status: 'active' | 'inactive'
  /** Plaintext, opened from the `pos:v1:` envelope. Null when none was sent. */
  password: string | null
}

/** Is there anything to ask? Read per call so a test can flip the env. */
export function portalAvailable(): boolean {
  return portalConfig() !== null
}

/**
 * The active databases for this site, or null to fall back to SQL.
 *
 * `purpose` narrows the answer server-side. It is passed as a query parameter
 * rather than a body because this is a GET, and the signature covers the URL's
 * PATHNAME only — so the narrowing cannot break the signature no matter what it
 * contains.
 */
export async function siteDatabases(
  purpose?: string,
): Promise<PortalSiteDatabase[] | null> {
  if (!portalAvailable()) return null

  const path = purpose
    ? `/site-databases?purpose=${encodeURIComponent(purpose)}`
    : '/site-databases'

  const result = await send<Payload>('GET', path)
  if (!result.ok) return null

  const rows = result.data?.databases
  if (!Array.isArray(rows)) return null

  const out: PortalSiteDatabase[] = []
  for (const r of rows) {
    /* A row we cannot open is dropped rather than returned with a null
       password. Handing back a connection with no credential would produce an
       "Access denied" from MariaDB — which reads as a wrong password rather
       than as a credential that never arrived, and sends whoever is debugging
       it to the wrong place entirely. */
    let password: string | null = null
    if (r.password) {
      try {
        password = openPortalEnvelope(r.password)
      } catch {
        continue
      }
    } else if (r.hasPassword) {
      /* The portal holds one and could not prepare it — `password: null` with
         `hasPassword: true`. That is a row somebody has to look at, and it is
         not usable here. */
      continue
    }

    out.push({
      id: Number(r.id),
      purpose: String(r.purpose),
      locationName: String(r.locationName ?? ''),
      host: String(r.serverHost),
      port: Number(r.serverPort) || 3306,
      databaseName: String(r.databaseName),
      username: r.dbUsername ?? null,
      engine: String(r.dbEngine ?? 'mariadb'),
      status: r.status === 'inactive' ? 'inactive' : 'active',
      password,
    })
  }
  return out
}

/** The one active database for a purpose, or null to fall back to SQL. */
export async function siteDatabaseFor(
  purpose: string,
): Promise<PortalSiteDatabase | null> {
  const rows = await siteDatabases(purpose)
  if (!rows) return null
  return rows.find((r) => r.purpose === purpose && r.status === 'active') ?? null
}
