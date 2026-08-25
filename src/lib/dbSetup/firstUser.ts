import 'server-only'
import { createUser, listUsers } from '../site/users'
import { siteQueryOne } from '../siteDb'
import type { RowDataPacket } from 'mysql2'

/**
 * The one user a freshly provisioned shop has to start with.
 *
 * ── WHY PROVISIONING CANNOT END WITHOUT THIS ────────────────────────────────
 *
 * Odyssey Database Setup creates a database and fills it with 254 migrations'
 * worth of tables, and every one of those tables is empty — `users` included.
 * A technician who stopped there would hand over a machine nobody can sign in
 * to, and no way to fix it short of running the wizard again.
 *
 * So the last thing the wizard does is ask for a name and a PIN, and write the
 * store owner. From that moment the shop is self-sufficient: that person opens
 * Setup → Users and creates everybody else, on the machine, with no control
 * panel involved. See docs/plans/database-setup-app.md.
 *
 * ── WHY NOT COPIED DOWN FROM cp2_users ──────────────────────────────────────
 *
 * Because a local install has no relationship with control-panel accounts. The
 * email and password typed at the start of the wizard is a PROVISIONING KEY —
 * it answers "which shop is this machine" and nothing else. Seeding it as a
 * login would make one credential a working back-office account on every
 * machine it had ever provisioned, which is the opposite of what it is for.
 */

type OwnerRoleRow = RowDataPacket & { id: number }

export type FirstUserResult = { ok: true; id: number } | { ok: false; error: string }

/**
 * The owner role, created by `041_users_roles.sql` as part of the schema.
 *
 * Looked up rather than assumed to be id 1: the migrations decide, and an
 * ordering change upstream should not silently make the store owner a cashier.
 */
export async function ownerRoleId(siteId: number): Promise<number | null> {
  const row = await siteQueryOne<OwnerRoleRow>(
    siteId,
    'SELECT id FROM roles WHERE is_owner = 1 LIMIT 1',
  )
  return row?.id ?? null
}

/**
 * Has anybody been created here yet?
 *
 * The wizard asks this before offering to create an owner. A machine that
 * already has users is one somebody is re-running Setup on — the "retrieve new
 * details" path — and creating a second owner there would be confusing at best
 * and a way to grant yourself access at worst.
 */
export async function hasAnyUser(siteId: number): Promise<boolean> {
  const users = await listUsers(siteId)
  return users.length > 0
}

/**
 * Write the store owner.
 *
 * Goes through `createUser` rather than its own INSERT so it inherits every
 * rule the shop's own Users screen enforces — PIN length, the guessable-PIN
 * refusals, uniqueness across active users, and the device verifiers minted so
 * the PIN works at a till that is offline. A second INSERT here would be a
 * second set of rules to keep in step.
 */
export async function createStoreOwner(
  siteId: number,
  name: string,
  pin: string,
  email: string | null = null,
): Promise<FirstUserResult> {
  if (await hasAnyUser(siteId)) {
    return {
      ok: false,
      error: 'This shop already has users. Sign in as one of them rather than creating another owner.',
    }
  }

  const roleId = await ownerRoleId(siteId)
  /* No owner role means the schema did not finish. Better to say that than to
     create a user with no permissions, who can sign in and then find every
     screen refused — a failure that looks like a broken app rather than an
     unfinished install. */
  if (roleId === null) {
    return {
      ok: false,
      error: 'This database has no owner role. The schema did not finish installing.',
    }
  }

  return createUser(siteId, {
    name,
    email,
    mobile: null,
    /* back_office, so this person can open the office at all. They also get a
       PIN, which means they can work a till too — correct for a shop owner,
       who is frequently the person behind the counter on a Saturday. */
    userType: 'back_office',
    roleId,
    salesRepId: null,
    pin,
    isActive: true,
    /* Said explicitly, because this wizard cannot be recognised by what it is
       running as: it is a CLOUD client — reading the control panel is its whole
       job — building a LOCAL site. Left to infer, validate() asks whether THIS
       machine is a local install, gets "no", and demands an email address the
       technician was never asked for and does not have. */
    pinIsCredential: true,
  })
}
