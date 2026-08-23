'use server'

import { revalidatePath } from 'next/cache'
import { requireSiteUser } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import {
  createRole,
  updateRole,
  deleteRole,
  setCapability,
} from '@/lib/site/permissions'
import {
  createUser,
  updateUser,
  clearPin,
  getUser,
  linkControlAccount,
  type UserInput,
} from '@/lib/site/users'
import {
  provisionControlAccount,
  revokeSiteAccess,
  findControlAccountByEmail,
} from '@/lib/controlUsers'

/**
 * Every action here re-checks `setup.users` rather than trusting the screen
 * that offered the button. A server action is a public endpoint: the only
 * check that counts is the one a client cannot skip, and this particular
 * capability is the one that can grant every other.
 */
async function requireUserAdmin() {
  const ctx = await requireSiteUser()
  if (!can(ctx.capabilities, 'setup.users')) return null
  return ctx
}

type Result = { ok: true; message: string } | { ok: false; error: string }

const DENIED = { ok: false as const, error: 'You do not have permission to manage users.' }

export type SaveUserInput = UserInput & {
  /** Back-office half. Absent for a POS-only user. */
  control?: {
    password: string | null
    siteIds: number[]
    defaultSiteId: number | null
    role: 'owner' | 'manager' | 'staff'
  }
}

export async function saveUserAction(
  userId: number | null,
  input: SaveUserInput,
): Promise<{ ok: true; id: number; message: string } | { ok: false; error: string }> {
  const ctx = await requireUserAdmin()
  if (!ctx) return DENIED
  const { site, user: actor } = ctx

  // A back-office user needs an account in the control database to sign in
  // with. That is a DIFFERENT database with no shared transaction, so the two
  // halves are written in sequence and reconciled by control_user_id — the
  // control row first, because a local row pointing at nothing is recoverable
  // (the next save links it) while a control account nobody can see is not.
  let controlUserId: number | null = null

  if (input.userType === 'back_office') {
    if (!input.control) {
      return { ok: false, error: 'Choose at least one store this person may open.' }
    }

    const email = input.email?.trim().toLowerCase() ?? ''
    const existing = userId ? await getUser(site.id, userId) : null
    const linked =
      existing?.controlUserId ?? (email ? (await findControlAccountByEmail(email))?.id ?? null : null)

    const provisioned = await provisionControlAccount(actor.controlUserId ?? 0, linked, {
      email,
      fullName: input.name,
      password: input.control.password,
      siteIds: input.control.siteIds,
      defaultSiteId: input.control.defaultSiteId,
      role: input.control.role,
      isActive: input.isActive,
    })
    if (!provisioned.ok) return provisioned
    controlUserId = provisioned.controlUserId
  }

  const result = userId
    ? await updateUser(site.id, userId, input)
    : await createUser(site.id, input)
  if (!result.ok) return result

  if (controlUserId !== null) {
    await linkControlAccount(site.id, result.id, controlUserId, input.email!.trim().toLowerCase())
  }

  revalidatePath('/setup/users')
  return {
    ok: true,
    id: result.id,
    message: userId ? 'User saved.' : `${input.name.trim()} can now sign in.`,
  }
}

export async function clearPinAction(userId: number): Promise<Result> {
  const ctx = await requireUserAdmin()
  if (!ctx) return DENIED

  const result = await clearPin(ctx.site.id, userId)
  if (!result.ok) return { ok: false, error: result.error ?? 'Could not clear that PIN.' }

  revalidatePath('/setup/users')
  return { ok: true, message: 'PIN cleared. They can no longer sign in at the till.' }
}

/**
 * The 2FA lockout recovery: a colleague's authenticator is gone, and the
 * owner clears the requirement so they can sign in with password alone and
 * re-enrol. Audited — stripping a lock off somebody's account is exactly the
 * kind of act the trail exists for.
 */
export async function clearTotpAction(userId: number): Promise<Result> {
  const ctx = await requireUserAdmin()
  if (!ctx) return DENIED

  const target = await getUser(ctx.site.id, userId)
  if (!target) return { ok: false, error: 'That user no longer exists.' }
  if (!target.controlUserId) {
    return { ok: false, error: 'That person has no back-office sign-in, so there is nothing to clear.' }
  }

  const { clearTotp } = await import('@/lib/twoFactor')
  await clearTotp(target.controlUserId)

  const { logActivity } = await import('@/lib/site/activityLog')
  await logActivity(ctx.site.id, { userId: ctx.user.id, userName: ctx.user.name }, {
    entity: 'user',
    entityId: userId,
    action: 'totp_cleared',
    detail: `Two-factor cleared for ${target.name} — they can sign in with password alone until they re-enrol`,
  })

  revalidatePath('/setup/users')
  return { ok: true, message: `Two-factor cleared for ${target.name}.` }
}

/** Removes this store from someone's access without deleting their account. */
export async function revokeAccessAction(userId: number): Promise<Result> {
  const ctx = await requireUserAdmin()
  if (!ctx) return DENIED

  const target = await getUser(ctx.site.id, userId)
  if (!target) return { ok: false, error: 'That user no longer exists.' }
  if (target.id === ctx.user.id) {
    return { ok: false, error: 'You cannot remove your own access to this store.' }
  }

  if (target.controlUserId) await revokeSiteAccess(target.controlUserId, ctx.site.id)
  /*
   * Every field is carried across, not just the ones being changed: updateUser
   * writes the whole row, so anything omitted here is silently blanked. Only
   * isActive and pin are meant to move.
   */
  await updateUser(ctx.site.id, userId, {
    name: target.name,
    email: target.email,
    mobile: target.mobile,
    userType: target.userType,
    roleId: target.roleId,
    salesRepId: target.salesRepId,
    pin: null,
    isActive: false,
  })

  revalidatePath('/setup/users')
  return { ok: true, message: `${target.name} can no longer open this store.` }
}

export async function createRoleAction(
  name: string,
  description: string,
): Promise<{ ok: true; id: number; message: string } | { ok: false; error: string }> {
  const ctx = await requireUserAdmin()
  if (!ctx) return DENIED

  const result = await createRole(ctx.site.id, name, description)
  if (!result.ok) return result

  revalidatePath('/setup/users')
  revalidatePath('/setup/roles')
  return { ok: true, id: result.id, message: `Role “${name.trim()}” created.` }
}

export async function updateRoleAction(
  roleId: number,
  name: string,
  description: string,
): Promise<Result> {
  const ctx = await requireUserAdmin()
  if (!ctx) return DENIED

  const result = await updateRole(ctx.site.id, roleId, name, description)
  if (!result.ok) return result

  revalidatePath('/setup/roles')
  return { ok: true, message: 'Role saved.' }
}

export async function deleteRoleAction(roleId: number): Promise<Result> {
  const ctx = await requireUserAdmin()
  if (!ctx) return DENIED

  const result = await deleteRole(ctx.site.id, roleId)
  if (!result.ok) return result

  revalidatePath('/setup/roles')
  return { ok: true, message: 'Role deleted.' }
}

export async function setCapabilityAction(
  roleId: number,
  capability: string,
  allowed: boolean,
): Promise<Result> {
  const ctx = await requireUserAdmin()
  if (!ctx) return DENIED

  const result = await setCapability(ctx.site.id, roleId, capability, allowed)
  if (!result.ok) return result

  revalidatePath('/setup/roles')
  return { ok: true, message: allowed ? 'Permission granted.' : 'Permission removed.' }
}
