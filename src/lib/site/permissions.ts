import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteExecute } from '../siteDb'
import type { SiteRole } from '../sites'

/**
 * Who may do what.
 *
 * The minimum viable model, and deliberately ROLE-level only. Users live in the
 * control database; a per-user permission table in a site database goes stale
 * the day someone is removed upstream, with nothing here to notice.
 *
 * `products.max_discount_pct` has existed since the first migration with
 * nothing enforcing it. `sales.discount_override` is what finally gives it
 * teeth.
 */

export const CAPABILITIES = [
  'sales.void',
  'sales.credit_note',
  'sales.edit_finalised',
  'sales.discount_override',
  'sales.price_override',
] as const

export type Capability = (typeof CAPABILITIES)[number]

export const CAPABILITY_LABELS: Record<Capability, { label: string; hint: string }> = {
  'sales.void': {
    label: 'Void a sale',
    hint: 'Cancel a finalised invoice on the same trading day.',
  },
  'sales.credit_note': {
    label: 'Raise a credit note',
    hint: 'Reverse all or part of an invoice after the day it was issued.',
  },
  'sales.edit_finalised': {
    label: 'Correct a finalised invoice',
    hint: 'Reverses and re-posts it. Leave off until the correction path is proven.',
  },
  'sales.discount_override': {
    label: 'Discount beyond the product limit',
    hint: 'Exceed a product’s maximum discount percentage.',
  },
  'sales.price_override': {
    label: 'Change a price at the till',
    hint: 'Sell at something other than the price structure figure.',
  },
}

/** Everything a role may do, as a set. One query per request, passed down. */
export type CapabilitySet = ReadonlySet<string>

export async function capabilitiesFor(siteId: number, role: SiteRole): Promise<CapabilitySet> {
  const rows = await siteQuery<RowDataPacket & { capability: string }>(
    siteId,
    'SELECT capability FROM role_capabilities WHERE site_role = ? AND allowed = 1',
    [role],
  )
  return new Set(rows.map((r) => r.capability))
}

/**
 * Whether a role may do something.
 *
 * Defaults to DENY when a capability has no row: a permission that silently
 * defaults to "allowed" is how a till ends up letting a junior cashier void
 * yesterday's takings.
 */
export function can(capabilities: CapabilitySet, capability: Capability): boolean {
  return capabilities.has(capability)
}

export type RoleMatrix = Record<SiteRole, Record<string, boolean>>

/** The whole grid, for the setup screen. */
export async function capabilityMatrix(siteId: number): Promise<RoleMatrix> {
  const rows = await siteQuery<RowDataPacket & { site_role: string; capability: string; allowed: number }>(
    siteId,
    'SELECT site_role, capability, allowed FROM role_capabilities',
  )

  const matrix: RoleMatrix = {
    owner: {},
    manager: {},
    staff: {},
  }

  for (const role of ['owner', 'manager', 'staff'] as SiteRole[]) {
    for (const capability of CAPABILITIES) matrix[role][capability] = false
  }
  for (const row of rows) {
    const role = row.site_role as SiteRole
    if (matrix[role]) matrix[role][row.capability] = !!row.allowed
  }

  return matrix
}

export type SaveResult = { ok: true } | { ok: false; error: string }

/**
 * Grants or revokes one capability.
 *
 * An owner cannot be locked out of anything: someone has to be able to put a
 * permission back, and if the last person who could is denied it, the only
 * remedy is editing the database by hand.
 */
export async function setCapability(
  siteId: number,
  role: SiteRole,
  capability: Capability,
  allowed: boolean,
): Promise<SaveResult> {
  if (!CAPABILITIES.includes(capability)) {
    return { ok: false, error: 'That permission does not exist.' }
  }
  if (role === 'owner' && !allowed) {
    return { ok: false, error: 'An owner keeps every permission — otherwise nobody can restore it.' }
  }

  await siteExecute(
    siteId,
    `INSERT INTO role_capabilities (site_role, capability, allowed) VALUES (?,?,?)
     ON DUPLICATE KEY UPDATE allowed = VALUES(allowed)`,
    [role, capability, allowed ? 1 : 0],
  )
  return { ok: true }
}
