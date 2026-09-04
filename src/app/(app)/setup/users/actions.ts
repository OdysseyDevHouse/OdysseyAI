'use server'

import { revalidatePath } from 'next/cache'
import { requireSiteUser } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import {
  createRole,
  updateRole,
  deleteRole,
  setCapability,
  setCapabilities,
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

/**
 * The whole of one permission group at once — the section "select all".
 *
 * Takes the group's capabilities from the caller rather than a group key so
 * that the server never has to agree with the screen about what a group
 * contains; every key is checked against the capability list regardless, so
 * the worst a tampered call can do is grant something it also could have
 * granted one switch at a time.
 */
export async function setCapabilitiesAction(
  roleId: number,
  capabilities: string[],
  allowed: boolean,
): Promise<Result> {
  const ctx = await requireUserAdmin()
  if (!ctx) return DENIED

  const result = await setCapabilities(ctx.site.id, roleId, capabilities, allowed)
  if (!result.ok) return result

  revalidatePath('/setup/roles')
  return {
    ok: true,
    message: allowed ? 'Permissions granted.' : 'Permissions removed.',
  }
}

/**
 * The phones and tablets this person has signed the mobile app in on.
 *
 * ── WHY THIS SITS ON THE USER AND NOT BESIDE THE TILLS ──────────────────────
 *
 * Because a phone belongs to a PERSON, not to a shop floor. Tills are licensed
 * per device out of `cp2_devices` and a shop may only trade from as many as it
 * was sold; a phone consumes no licence, follows a multi-store manager between
 * branches, and is revoked because somebody left it in a taxi. Listing the two
 * together would invite the reading that a phone eats a till seat.
 *
 * It also matches how the question arrives. Nobody opens a device inventory to
 * ask "which of these is Tiaan's" — they open Tiaan.
 */
export async function listMobileDevicesAction(
  userId: number,
): Promise<
  | { ok: true; devices: { id: number; platform: string; label: string; lastSeenAt: string | null }[] }
  | { ok: false; error: string }
> {
  const ctx = await requireUserAdmin()
  if (!ctx) return { ok: false, error: DENIED.error }

  const target = await getUser(ctx.site.id, userId)
  if (!target) return { ok: false, error: 'That user no longer exists.' }
  /* A till-only user has no back-office account, and the mobile app signs in
     with an email and password — so there is nothing to list rather than an
     empty list, and saying so is kinder than an empty table. */
  if (!target.controlUserId) {
    return { ok: false, error: 'That person has no back-office sign-in, so they cannot use the mobile app.' }
  }

  const { listDevices } = await import('@/lib/control/mobileDevices')
  const devices = await listDevices(target.controlUserId)

  return {
    ok: true,
    devices: devices.map((d) => ({
      id: d.id,
      platform: d.platform,
      label: d.label,
      /* Serialised here rather than in the client: a Date crossing the server
         boundary arrives as a string anyway, and doing it explicitly means the
         format is decided once instead of by whatever the browser's locale is. */
      lastSeenAt: d.lastSeenAt ? d.lastSeenAt.toISOString() : null,
    })),
  }
}

/**
 * Cut one phone off.
 *
 * The refresh token dies immediately, so the app cannot mint another session.
 * The session it is ALREADY holding lives until it expires — at most twelve
 * hours — and the message says so rather than implying an instant lockout that
 * this cannot deliver. Somebody revoking a stolen phone needs to know whether
 * to also change the password, and a reassuring lie is the worst answer.
 */
export async function revokeMobileDeviceAction(
  userId: number,
  deviceId: number,
): Promise<Result> {
  const ctx = await requireUserAdmin()
  if (!ctx) return DENIED

  const target = await getUser(ctx.site.id, userId)
  if (!target) return { ok: false, error: 'That user no longer exists.' }
  if (!target.controlUserId) {
    return { ok: false, error: 'That person has no back-office sign-in.' }
  }

  /* Scoped to the OWNER's id, not just the device id — so a tampered device
     number cannot revoke somebody else's phone through this screen. The same
     rule the library enforces; asserted twice because the cost is one column
     in a WHERE and the failure is silent. */
  const { revokeDevice } = await import('@/lib/control/mobileDevices')
  const revoked = await revokeDevice(target.controlUserId, deviceId)
  if (!revoked) {
    return { ok: false, error: 'That device was already signed out.' }
  }

  const { logActivity } = await import('@/lib/site/activityLog')
  await logActivity(ctx.site.id, { userId: ctx.user.id, userName: ctx.user.name }, {
    entity: 'user',
    entityId: userId,
    action: 'mobile_device_revoked',
    detail: `A mobile device was signed out for ${target.name} — it cannot sign in again without the password`,
  })

  revalidatePath('/setup/users')
  return {
    ok: true,
    message: `Signed out. Any session already open on that device stops working within twelve hours.`,
  }
}
