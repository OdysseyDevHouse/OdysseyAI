/**
 * The statements that provision a shop's database.
 *
 * Pure string building, deliberately: it is unit-testable without a server, and
 * the quoting below is the kind of thing that must be looked at rather than
 * trusted. No 'server-only' — the tests import it directly.
 *
 * ── WHY QUOTING MATTERS HERE MORE THAN USUAL ──────────────────────────────
 *
 * These values come from the CONTROL PANEL, not from this machine. The password
 * was generated somewhere else and arrives encrypted, so nothing here can
 * assume a safe alphabet — and `CREATE USER ... IDENTIFIED BY '<password>'`
 * cannot be a prepared statement, because MariaDB does not allow placeholders
 * in DDL. A password containing a quote would end the string early and change
 * what the statement means.
 *
 * electron/localDb.js interpolates these values directly. It gets away with it
 * because it generates its own passwords from a restricted alphabet
 * (generateDbPassword strips +/=). Nothing guarantees that for a control-panel
 * password, so this path escapes properly instead of hoping.
 */

/**
 * A MariaDB string literal.
 *
 * Backslash-escaping, matching MariaDB's default NO_BACKSLASH_ESCAPES=off. The
 * newline/return/NUL cases are not paranoia about attacks so much as about a
 * value that was pasted with a stray character and would otherwise produce a
 * syntax error nobody can read.
 */
export function quoteString(value: string): string {
  const escaped = value.replace(/[\0\b\n\r\t\x1a\\'"]/g, (ch) => {
    switch (ch) {
      case '\0':
        return '\\0'
      case '\b':
        return '\\b'
      case '\n':
        return '\\n'
      case '\r':
        return '\\r'
      case '\t':
        return '\\t'
      case '\x1a':
        return '\\Z'
      default:
        return `\\${ch}`
    }
  })
  return `'${escaped}'`
}

/**
 * A MariaDB identifier — a database or user name.
 *
 * Backticks, with any embedded backtick doubled. Identifiers cannot be
 * parameterised either, and a database name is just as much control-panel input
 * as the password is.
 */
export function quoteIdent(value: string): string {
  return `\`${value.replace(/`/g, '``')}\``
}

/**
 * Reject a name that has no business being one.
 *
 * Belt and braces alongside quoteIdent: a database called `; DROP` would be
 * quoted correctly and still be a name somebody has to explain later. Refusing
 * early gives a clear message instead of a strange database.
 */
export function isPlausibleName(value: string): boolean {
  return /^[A-Za-z0-9_$-]{1,64}$/.test(value)
}

/**
 * Accounts this installer must never create, alter, or grant.
 *
 * ── THIS IS NOT THEORETICAL ───────────────────────────────────────────────
 *
 * A real site in the control panel today names `root` as the username on its
 * master record — which is a perfectly sensible thing for a CLOUD-hosted
 * database, where root is the account we administer it with. Fed to this
 * installer unguarded it would emit
 *
 *     ALTER USER 'root'@'127.0.0.1' IDENTIFIED BY '<control panel password>'
 *
 * on the technician's own machine, changing the superuser's password to
 * something nobody there knows — and then GRANT it to the shop's LAN. A shop
 * locked out of its own database server, from a tool whose whole purpose is
 * setting one up.
 *
 * `secureRoot` in electron/localDb.js is the one place root's password is set,
 * once, at first initialisation, from a value escrowed to the control panel.
 * Nothing else may touch it.
 */
const RESERVED_USERS = new Set([
  'root',
  'mysql',
  'mariadb.sys',
  'mysql.sys',
  'mysql.session',
  'mysql.infoschema',
])

export function isReservedUser(value: string): boolean {
  return RESERVED_USERS.has(value.trim().toLowerCase())
}

export type ProvisionSql = {
  databaseName: string
  username: string
  password: string
  /**
   * Which hosts the user may connect from.
   *
   * '127.0.0.1' for a machine serving only itself — the local backend's own
   * app. A HYBRID box is different: ten tills on the shop LAN connect to it, so
   * it must accept its own subnet. That is a real widening and the caller must
   * ask for it explicitly rather than get it by default.
   */
  allowFrom: string[]
}

/**
 * CREATE DATABASE, CREATE USER, GRANT — idempotent, and safe to re-run.
 *
 * ── EVERY STATEMENT IS IF-NOT-EXISTS OR AN ALTER ──────────────────────────
 *
 * This is what makes "Retrieve new details" safe. A technician re-running setup
 * against a server that already holds the shop's trading data must reconcile it
 * toward the control panel, never re-initialise it. There is deliberately no
 * DROP here, of anything, ever.
 *
 * ── AND WHY ALTER USER IS PRESENT AT ALL ──────────────────────────────────
 *
 * CREATE USER IF NOT EXISTS does nothing when the user is already there — which
 * means a password rotated in the control panel would never take effect. The
 * ALTER is how a rotation reaches the server, and it is the one statement here
 * that changes something that already existed.
 *
 * It is also the statement that could lock a shop out of its own data if it ran
 * with the wrong password, which is why the caller verifies the plan first.
 */
export function provisionStatements(input: ProvisionSql): string[] {
  if (!isPlausibleName(input.databaseName)) {
    throw new Error(`Refusing to create a database named "${input.databaseName}".`)
  }
  if (!isPlausibleName(input.username)) {
    throw new Error(`Refusing to create a user named "${input.username}".`)
  }
  if (isReservedUser(input.username)) {
    throw new Error(
      `Refusing to touch the "${input.username}" account. It administers the database server ` +
        `itself, and changing its password here would lock this machine out of its own data. ` +
        `Give this site's database record a username of its own in the control panel.`,
    )
  }
  if (input.allowFrom.length === 0) {
    throw new Error('A database user with no host to connect from cannot be used.')
  }

  const db = quoteIdent(input.databaseName)
  const user = quoteString(input.username)
  const pw = quoteString(input.password)

  const statements = [
    `CREATE DATABASE IF NOT EXISTS ${db} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`,
  ]

  for (const host of input.allowFrom) {
    const h = quoteString(host)
    statements.push(
      `CREATE USER IF NOT EXISTS ${user}@${h} IDENTIFIED BY ${pw};`,
      /* The rotation path. See the note above. */
      `ALTER USER ${user}@${h} IDENTIFIED BY ${pw};`,
      /* Scoped to this ONE database, unlike the local backend's app user which
         needs *.* because it creates site databases at runtime. A hybrid box
         holds open tabs and nothing else; it never creates a database, so
         granting it the right to would be handing out an ability with no use. */
      `GRANT ALL PRIVILEGES ON ${db}.* TO ${user}@${h};`,
    )
  }

  statements.push('FLUSH PRIVILEGES;')
  return statements
}
