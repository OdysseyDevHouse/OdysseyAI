/**
 * The statements OdysseyAI Database Setup runs on a shop's server.
 *
 * These build DDL by string interpolation, because MariaDB does not allow
 * placeholders in CREATE USER or CREATE DATABASE. That makes the quoting the
 * only thing standing between a control-panel password and a statement that
 * means something else — so it is tested directly rather than inspected.
 *
 *   npx tsx scripts/test-db-setup.ts
 */
import {
  provisionStatements,
  quoteIdent,
  quoteString,
  isPlausibleName,
  isReservedUser,
} from '../src/lib/dbSetup/sql'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) console.log(`  PASS  ${name}`)
  else {
    failures++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('\nDatabase setup — SQL\n')

/* ── Quoting ─────────────────────────────────────────────────────────────── */

check('a plain password is quoted', quoteString('abc123') === "'abc123'")
check("a single quote is escaped", quoteString("a'b") === "'a\\'b'")
check('a backslash is escaped', quoteString('a\\b') === "'a\\\\b'")
check('a double quote is escaped', quoteString('a"b') === "'a\\\"b'")
check('a newline is escaped', quoteString('a\nb') === "'a\\nb'")
check('a NUL is escaped', quoteString('a\0b') === "'a\\0b'")

/* The attack this exists to stop: a password that closes the string and adds a
   statement. After escaping there must be no unescaped quote left to close it. */
{
  const evil = "x'; DROP DATABASE shop; --"
  const quoted = quoteString(evil)
  const inner = quoted.slice(1, -1)
  check(
    'a password cannot close its own string',
    !/(^|[^\\])'/.test(inner),
    `got ${quoted}`,
  )
}

check('an identifier is backticked', quoteIdent('ody10000_hybrid') === '`ody10000_hybrid`')
check('an embedded backtick is doubled', quoteIdent('a`b') === '`a``b`')

/* ── Name plausibility ───────────────────────────────────────────────────── */

check('a normal database name is fine', isPlausibleName('ody10000_hybrid'))
check('a hyphen is fine', isPlausibleName('ody-10000'))
check('a space is not a name', !isPlausibleName('my database'))
check('a semicolon is not a name', !isPlausibleName('shop; DROP'))
check('an empty name is not a name', !isPlausibleName(''))
check('a backtick is not a name', !isPlausibleName('a`b'))
check('65 characters is too long', !isPlausibleName('a'.repeat(65)))
check('64 characters is allowed', isPlausibleName('a'.repeat(64)))

/* ── The statements ──────────────────────────────────────────────────────── */

const sql = provisionStatements({
  databaseName: 'ody10000_hybrid',
  username: 'ody10000_hybrid',
  password: "p@ss'w0rd",
  allowFrom: ['127.0.0.1', '192.168.1.%'],
})
const joined = sql.join('\n')

check('the database is created', joined.includes('CREATE DATABASE IF NOT EXISTS `ody10000_hybrid`'))
check('utf8mb4, like every other database here', joined.includes('utf8mb4_unicode_ci'))

/* Idempotence is what makes "Retrieve new details" safe to run against a server
   already holding a shop's trading data. */
check('every CREATE is IF NOT EXISTS', !/CREATE (DATABASE|USER) (?!IF NOT EXISTS)/.test(joined))
check('nothing is ever dropped', !/\bDROP\b/i.test(joined))
check('nothing is truncated', !/\bTRUNCATE\b/i.test(joined))

/* The rotation path: without ALTER, a password changed in the control panel
   would never reach the server, because CREATE USER IF NOT EXISTS is a no-op. */
check('the password can be rotated', joined.includes('ALTER USER'))

check('the user is created for each host', (joined.match(/CREATE USER/g) || []).length === 2)
check('the LAN host is included', joined.includes("'192.168.1.%'"))

/* Scoped to one database, unlike the local backend's app user. A box that holds
   open tabs never creates a database. */
check('the grant is scoped to the one database', joined.includes('ON `ody10000_hybrid`.*'))
check('no global grant', !joined.includes('ON *.*'))

/* The password in the statements must be the escaped form. */
check('the password is escaped in the statement', joined.includes("'p@ss\\'w0rd'"))

/* ── Refusals ────────────────────────────────────────────────────────────── */

function refuses(name: string, fn: () => unknown) {
  try {
    fn()
    check(name, false, 'did not throw')
  } catch {
    check(name, true)
  }
}

refuses('a hostile database name is refused', () =>
  provisionStatements({
    databaseName: 'shop`; DROP DATABASE x; --',
    username: 'u',
    password: 'p',
    allowFrom: ['127.0.0.1'],
  }),
)
refuses('a hostile username is refused', () =>
  provisionStatements({
    databaseName: 'shop',
    username: "u'; GRANT ALL",
    password: 'p',
    allowFrom: ['127.0.0.1'],
  }),
)
refuses('a user with no host is refused', () =>
  provisionStatements({ databaseName: 'shop', username: 'u', password: 'p', allowFrom: [] }),
)

/* ── The superuser ───────────────────────────────────────────────────────── */

/* NOT hypothetical: a real site in the control panel names `root` on its master
   record, which is sensible for a cloud-hosted database and catastrophic here.
   Unguarded, this installer would ALTER the local superuser's password to a
   value nobody on the machine knows, then GRANT it to the shop's LAN. */
check('root is reserved', isReservedUser('root'))
check('ROOT is reserved regardless of case', isReservedUser('ROOT'))
check('the mariadb system accounts are reserved', isReservedUser('mariadb.sys'))
check('an ordinary user is not reserved', !isReservedUser('ody10000_hybrid'))

refuses('provisioning refuses to touch root', () =>
  provisionStatements({
    databaseName: 'ody10001_master',
    username: 'root',
    password: 'p',
    allowFrom: ['127.0.0.1'],
  }),
)

console.log(`\n${failures === 0 ? 'Database setup SQL holds.' : `${failures} FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
