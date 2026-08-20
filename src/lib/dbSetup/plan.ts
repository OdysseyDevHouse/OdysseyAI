import 'server-only'
import { getSiteDatabase, type SiteDatabase } from '../siteDb'
import { listSitesForUser, type ConnectionType, type Site } from '../sites'

/**
 * What Odyssey Database Setup should do on this machine.
 *
 * ── WHY A PLAN, SEPARATE FROM DOING IT ────────────────────────────────────
 *
 * Provisioning creates a database, a user and a password on somebody's server.
 * Deciding WHETHER to and WHAT to are questions with wrong answers that are
 * expensive — provisioning a cloud site would create a database nothing reads,
 * and provisioning the wrong purpose would create one the shop's installation
 * is not configured against.
 *
 * So the decision is a pure function of what the control panel says, returning
 * a value a human can be shown BEFORE anything is written. The installer prints
 * the plan and asks; only then does it act.
 *
 * ── THE THREE CONNECTION TYPES ────────────────────────────────────────────
 *
 *   cloud   — nothing to do. The server already exists and we run it. Saying so
 *             plainly is the whole job; installing a database here would leave
 *             a MariaDB nothing ever connects to.
 *   hybrid  — provision from the MANAGED `hybrid` record. That is the in-store
 *             box holding open tabs; the site's real master stays in the cloud.
 *   local   — provision from the site's own master record. The shop's machine
 *             IS the master.
 *
 * ── WHY THE TECHNICIAN NEVER SEES THE PASSWORD ────────────────────────────
 *
 * The credentials come from the control panel, which generated them. The
 * installer reads them over an authenticated connection and hands them straight
 * to MariaDB. A technician types an email and password they already have, and
 * at no point learns what the database password is — so they cannot reach the
 * shop's data afterwards.
 *
 * That is the same principle as the DPAPI sealing in electron/runtimeConfig.js,
 * extended from the customer to the person doing the install.
 */

/** Which record a connection type provisions from. */
const PURPOSE_FOR: Record<Exclude<ConnectionType, 'cloud'>, string> = {
  hybrid: 'hybrid',
  local: 'master',
}

export type SetupPlan =
  /**
   * Provision. Carries everything MariaDB needs and nothing it does not — in
   * particular the plaintext password, which is why this value must never be
   * logged or shown.
   */
  | {
      action: 'provision'
      siteId: number
      siteCode: string
      siteName: string
      connectionType: 'hybrid' | 'local'
      /** Which control-panel record this came from. */
      purpose: string
      host: string
      port: number
      databaseName: string
      username: string
      password: string
      /** True when a server is already installed here — see `Retrieve new details`. */
      alreadyInstalled: boolean
    }
  /** A cloud site. Not an error: there is genuinely nothing to install. */
  | { action: 'nothing'; siteId: number; siteCode: string; siteName: string; reason: string }
  /** Something is wrong that a person must fix before this can proceed. */
  | { action: 'refuse'; reason: string }

/**
 * The sites this user may provision, for the picker.
 *
 * A support engineer legitimately has several; a shop owner has one and should
 * not be asked. Reuses listSitesForUser, which is the ONE place site access is
 * decided — a second query here could disagree with it.
 */
export async function sitesForSetup(userId: number): Promise<Site[]> {
  return listSitesForUser(userId)
}

/**
 * What to do for one site.
 *
 * `alreadyInstalled` is passed in rather than detected here: whether MariaDB is
 * on this machine is a fact about the machine, which this module deliberately
 * cannot see. It changes the wording, never the decision — reapplying against
 * an existing server is the "Retrieve new details" path and is safe, because
 * ensureUserAndDb is CREATE-IF-NOT-EXISTS plus ALTER.
 */
export async function planFor(site: Site, alreadyInstalled: boolean): Promise<SetupPlan> {
  const common = { siteId: site.id, siteCode: site.code, siteName: site.displayName }

  if (site.connectionType === 'cloud') {
    return {
      action: 'nothing',
      ...common,
      reason:
        'This site is set to Cloud, so its database is on a server we run. ' +
        'Nothing needs to be installed on this machine.',
    }
  }

  const purpose = PURPOSE_FOR[site.connectionType]
  let record: SiteDatabase | null
  try {
    record = await getSiteDatabase(site.id, purpose)
  } catch (err) {
    return {
      action: 'refuse',
      reason: `The control panel could not be read: ${(err as Error).message}`,
    }
  }

  if (!record) {
    /* A hybrid site with no managed record has not been set up in the control
       panel yet. Guessing a database name here would create one the shop's
       installation is not configured against — which fails later, quietly, as
       a shop that cannot see its own tables. */
    return {
      action: 'refuse',
      reason:
        `${site.displayName} is set to ${site.connectionType} but has no "${purpose}" database ` +
        `record in the control panel. Add one there first — this installer must not invent it.`,
    }
  }

  /* credentialsUsable is false when the password column is missing or
     SECRETS_KEY cannot decrypt it. Those are very different from "no password",
     which is a legitimate configuration — siteDb draws that distinction and
     this must not flatten it. */
  if (!record.credentialsUsable) {
    return {
      action: 'refuse',
      reason:
        `The stored password for ${record.databaseName} could not be decrypted. ` +
        `This usually means ENCRYPTION_KEY does not match the backend that wrote it.`,
    }
  }

  if (!record.username) {
    return {
      action: 'refuse',
      reason:
        `The "${purpose}" record for ${site.displayName} has no username. ` +
        `The control panel must name the user this installer is to create.`,
    }
  }

  /* Caught here as well as in provisionStatements, so the technician is told
     before anything is confirmed rather than by a throw at the last step. A
     cloud-hosted record naming `root` is entirely reasonable — it just cannot
     be what a local installer creates. See RESERVED_USERS. */
  const { isReservedUser } = await import('./sql')
  if (isReservedUser(record.username)) {
    return {
      action: 'refuse',
      reason:
        `The "${purpose}" record for ${site.displayName} names "${record.username}", which ` +
        `administers the database server itself. Setting its password from here would lock ` +
        `this machine out of its own data. Give the site a database user of its own in the ` +
        `control panel first.`,
    }
  }

  return {
    action: 'provision',
    ...common,
    connectionType: site.connectionType,
    purpose,
    host: record.host,
    port: record.port,
    databaseName: record.databaseName,
    username: record.username,
    password: await passwordFor(record),
    alreadyInstalled,
  }
}

/**
 * The plaintext password for a record.
 *
 * Separated so the one place that decrypts is obvious. `credentialsUsable` has
 * already been checked by the caller, so this cannot be the branch that fails.
 */
async function passwordFor(record: SiteDatabase): Promise<string> {
  const { decryptSecret } = await import('../crypto/secrets')
  const { queryOne } = await import('../db')
  const row = await queryOne<{ db_password_enc: string | null }>(
    'SELECT db_password_enc FROM cp2_site_databases WHERE id = ? LIMIT 1',
    [record.id],
  )
  return decryptSecret(row?.db_password_enc ?? null)
}

/**
 * A plan with its password removed, for logging and for the screen.
 *
 * Everything the technician needs to confirm they are about to do the right
 * thing, and nothing they could use to reach the database afterwards. Use this
 * anywhere a plan is displayed, written down, or sent anywhere.
 */
export function redact(plan: SetupPlan): Record<string, unknown> {
  if (plan.action !== 'provision') return { ...plan }
  const { password, ...rest } = plan
  return { ...rest, password: password ? '(set)' : '(none)' }
}
