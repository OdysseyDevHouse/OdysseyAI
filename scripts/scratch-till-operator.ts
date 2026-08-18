/*
 * A throwaway till operator on site 2, so the unclaimed-till screen can be
 * driven in a browser.
 *
 *   npx tsx --conditions=react-server --env-file=.env scripts/scratch-till-operator.ts create
 *   npx tsx --conditions=react-server --env-file=.env scripts/scratch-till-operator.ts remove
 *
 * ── WHY IT MUST BE REMOVED AGAIN ──────────────────────────────────────────
 *
 * A PIN is UNIQUE across a site's active users — `pinInUse` loops every hash to
 * enforce it. A scratch operator left behind therefore does not merely litter:
 * it occupies a PIN, and the next suite that creates a user with the same one
 * fails on an unrelated assertion with no hint of where the collision came
 * from. See odyssey-test-litter-fakes-failures.
 */
import { activeSiteIds } from '../src/lib/sites'
import { siteQuery, siteExecute } from '../src/lib/siteDb'
import { hashPassword } from '../src/lib/password'

const SITE = Number(process.env.TILL_SITE_ID || 2)
const NAME = 'ZZ Scratch Till Operator'
const PIN = '481624'

async function roleWithTill(siteId: number): Promise<number | null> {
  /* Any role that can work a till. Read rather than created: a scratch ROLE
     would be a second thing to clean up, and every site already has one.

     The table is `role_permissions` with an `allowed` flag, and an OWNER role
     holds every capability implicitly — it has no rows at all. Missing that
     second case is what made the first version of this report "no role holding
     sales.till" on a site whose owner can obviously use the till. */
  const rows = await siteQuery<{ id: number; name: string }>(
    siteId,
    `SELECT r.id, r.name
       FROM roles r
       LEFT JOIN role_permissions rp
         ON rp.role_id = r.id AND rp.capability = 'sales.till' AND rp.allowed = 1
      WHERE r.is_owner = 1 OR rp.capability IS NOT NULL
      ORDER BY r.is_owner DESC
      LIMIT 1`,
  ).catch((e) => {
    console.error(`  reading roles failed: ${e.message}`)
    return [] as { id: number; name: string }[]
  })
  return rows[0]?.id ?? null
}

async function main() {
  const mode = process.argv[2]
  if (mode !== 'create' && mode !== 'remove') {
    console.error('usage: scratch-till-operator.ts create|remove')
    process.exit(1)
  }

  if (!(await activeSiteIds()).includes(SITE)) {
    console.error(`site ${SITE} is not active`)
    process.exit(1)
  }

  if (mode === 'remove') {
    const res = await siteExecute(SITE, 'DELETE FROM users WHERE name = ?', [NAME])
    console.log(`removed ${res.affectedRows} scratch user(s) from site ${SITE}`)
    process.exit(0)
  }

  const roleId = await roleWithTill(SITE)
  if (!roleId) {
    console.error(`site ${SITE} has no role holding sales.till — cannot make an operator`)
    process.exit(1)
  }

  /* Idempotent: re-running create must not leave two operators sharing a PIN,
     which is the exact collision this script is careful about elsewhere. */
  await siteExecute(SITE, 'DELETE FROM users WHERE name = ?', [NAME])

  const hash = await hashPassword(PIN)
  /* Columns copied from `createUser` in src/lib/site/users.ts rather than
     guessed — there is no `password_hash` here; a POS-only user has a PIN and
     nothing else, which is the whole point of `user_type`. */
  await siteExecute(
    SITE,
    `INSERT INTO users (name, email, user_type, role_id, sales_rep_id, pin_hash, is_active)
     VALUES (?, NULL, 'pos_only', ?, NULL, ?, 1)`,
    [NAME, roleId, hash],
  )
  console.log(`created "${NAME}" on site ${SITE} with PIN ${PIN} (role ${roleId})`)
  console.log('REMEMBER: run with "remove" when finished.')
  process.exit(0)
}

main()
