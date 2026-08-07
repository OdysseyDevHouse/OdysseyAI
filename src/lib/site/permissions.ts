import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteExecute } from '../siteDb'

/**
 * Who may do what.
 *
 * Permissions hang off a ROLE, and roles are defined per site (see 041). The
 * earlier version keyed on the three-value `cp2_user_sites.site_role` ENUM and
 * argued against per-user data on the grounds that a row keyed to an upstream
 * id goes stale the day someone is removed upstream. That reasoning is what
 * moved the user row into the site database rather than what stopped it: the
 * local `users` row is now the identity, so nothing upstream can silently
 * invalidate it.
 *
 * Two rules survive unchanged from that version, because both were right:
 *
 *   DENY BY DEFAULT. A missing row is a no. A permission that defaults to
 *   "allowed" is how a till ends up letting a junior cashier void yesterday's
 *   takings.
 *
 *   THE OWNER CANNOT BE REDUCED. Someone has to be able to put a permission
 *   back. The owner role holds everything implicitly — not as stored rows,
 *   which could be deleted — and the UI refuses to edit or delete it.
 */

/**
 * Capabilities, grouped by the module they guard.
 *
 * `.view` is the right to open the screens at all and is what gates the menu;
 * `.edit` is the right to change what is on them. They are separate because
 * "may look at what we paid for stock" and "may change what we charge for it"
 * are genuinely different questions, and a shop that cannot express the
 * difference ends up granting the second to get the first.
 */
export const CAPABILITY_GROUPS = [
  {
    key: 'sales',
    label: 'Sales & till',
    capabilities: [
      { key: 'sales.till', label: 'Use the till', hint: 'Sign in to the point of sale and ring up sales.' },
      { key: 'sales.view', label: 'View sales', hint: 'Open the sales list, invoices and quotes.' },
      { key: 'sales.edit', label: 'Create and edit sales', hint: 'Raise quotes, orders and invoices in the back office.' },
      { key: 'sales.void', label: 'Void a sale', hint: 'Cancel a finalised invoice on the same trading day.' },
      { key: 'sales.credit_note', label: 'Raise a credit note', hint: 'Reverse all or part of an invoice after the day it was issued.' },
      { key: 'sales.edit_finalised', label: 'Correct a finalised invoice', hint: 'Reverses and re-posts it. Leave off until the correction path is proven.' },
      { key: 'sales.discount_override', label: 'Discount beyond the product limit', hint: 'Exceed a product’s maximum discount percentage.' },
      { key: 'sales.price_override', label: 'Change a price at the till', hint: 'Sell at something other than the price structure figure.' },
      { key: 'sales.cashup', label: 'Cash up', hint: 'Close a shift and record the drawer count.' },
      { key: 'contracts.view', label: 'View contracts', hint: 'Open recurring billing agreements and see what they have billed.' },
      { key: 'contracts.edit', label: 'Create and edit contracts', hint: 'Set up recurring billing, its products, escalation and billing day.' },
      // Separate from contracts.edit deliberately. Editing a contract changes
      // what WILL be billed and somebody can still review it; turning on
      // automatic sending means invoices post to a customer's account and reach
      // them with nobody in the loop. That is a different decision, and a shop
      // should be able to let a clerk maintain contracts without granting it.
      { key: 'contracts.auto_send', label: 'Let a contract bill and send itself', hint: 'Turn on automatic invoicing, which posts and emails with no review.' },
    ],
  },
  {
    key: 'products',
    label: 'Products',
    capabilities: [
      { key: 'products.view', label: 'View products', hint: 'Open the product list and look up prices.' },
      { key: 'products.edit', label: 'Create and edit products', hint: 'Add products, change descriptions and set prices.' },
      { key: 'products.delete', label: 'Delete products', hint: 'Remove a product from the catalogue.' },
      { key: 'products.cost', label: 'See cost prices', hint: 'View what stock was bought for, and the margin.' },
    ],
  },
  {
    key: 'customers',
    label: 'Customers',
    capabilities: [
      { key: 'customers.view', label: 'View customers', hint: 'Open the customer list and account history.' },
      { key: 'customers.edit', label: 'Create and edit customers', hint: 'Add accounts and change their details.' },
      { key: 'customers.credit', label: 'Set credit terms', hint: 'Change credit limits, terms and account locks.' },
    ],
  },
  {
    key: 'suppliers',
    label: 'Suppliers',
    capabilities: [
      { key: 'suppliers.view', label: 'View suppliers', hint: 'Open the supplier list and account history.' },
      { key: 'suppliers.edit', label: 'Create and edit suppliers', hint: 'Add suppliers and change their details.' },
    ],
  },
  {
    key: 'purchasing',
    label: 'Purchasing',
    capabilities: [
      { key: 'purchasing.view', label: 'View purchasing', hint: 'Open orders, goods received and supplier invoices.' },
      { key: 'purchasing.edit', label: 'Create and edit purchases', hint: 'Raise orders and receive stock.' },
      { key: 'purchasing.pay', label: 'Pay suppliers', hint: 'Allocate payments and run payment batches.' },
    ],
  },
  {
    key: 'stock',
    label: 'Stock',
    capabilities: [
      { key: 'stock.view', label: 'View stock', hint: 'See quantities on hand and movement history.' },
      { key: 'stock.adjust', label: 'Adjust stock', hint: 'Write stock on or off, and count it.' },
      { key: 'stock.transfer', label: 'Transfer stock', hint: 'Move stock between locations or stores.' },
    ],
  },
  {
    key: 'cashbook',
    label: 'Cashbook & banking',
    capabilities: [
      { key: 'cashbook.view', label: 'View the cashbook', hint: 'Open bank accounts and their transactions.' },
      { key: 'cashbook.edit', label: 'Capture cashbook entries', hint: 'Record receipts, payments and transfers.' },
      { key: 'cashbook.reconcile', label: 'Reconcile the bank', hint: 'Match transactions against a bank statement.' },
    ],
  },
  {
    key: 'reports',
    label: 'Reports',
    capabilities: [
      { key: 'dashboard.view', label: 'View the dashboard', hint: 'The sales overview on the home screen.' },
      { key: 'reports.view', label: 'Run reports', hint: 'Sales, stock and account reports.' },
      { key: 'reports.financial', label: 'Run financial reports', hint: 'Turnover, margin and profitability figures.' },
      { key: 'reports.build', label: 'Build custom reports', hint: 'Compose a report from any data the user may already see, and save it for everyone.' },
      { key: 'reports.schedule', label: 'Schedule reports by email', hint: 'Send a report to people on a timer. It runs unattended, so grant it deliberately.' },
      { key: 'reports.ai', label: 'Generate a report with AI', hint: 'Describe a report in plain English and have it built. Uses a paid AI call.' },
    ],
  },
  {
    key: 'online',
    label: 'Online store',
    capabilities: [
      { key: 'online.view', label: 'View the online store', hint: 'Open online orders and store content.' },
      { key: 'online.edit', label: 'Manage the online store', hint: 'Change the storefront, content and what is listed.' },
    ],
  },
  {
    key: 'loyalty',
    label: 'Loyalty',
    capabilities: [
      { key: 'loyalty.view', label: 'View loyalty', hint: 'See members, balances, tiers and punch cards.' },
      { key: 'loyalty.edit', label: 'Set up the programme', hint: 'Change the rates, the tier ladder and the punch cards.' },
      /* Separate from `edit` on purpose: points and wallet rand are money. The
         supervisor who tunes the earn rate once a year is rarely the person who
         should be able to put 10 000 points on their own account. */
      { key: 'loyalty.adjust', label: 'Adjust balances', hint: 'Hand out points, issue vouchers and reverse a refunded sale.' },
    ],
  },
  {
    key: 'commission',
    label: 'Commission',
    capabilities: [
      { key: 'commission.view_own', label: 'See their own commission', hint: 'What this person earned, and on which sales.' },
      { key: 'commission.view_all', label: 'See everyone’s commission', hint: 'Every salesperson’s figures, not just their own.' },
      { key: 'commission.edit', label: 'Set commission rules', hint: 'Decide the rates, tiers and what they apply to.' },
      { key: 'commission.run', label: 'Run and lock commission', hint: 'Calculate a period and freeze it for payment.' },
    ],
  },
  {
    key: 'staff',
    label: 'Staff',
    capabilities: [
      { key: 'staff.view_own', label: 'See their own hours and leave', hint: 'What they worked, and what leave they have left.' },
      { key: 'staff.view_all', label: 'See everyone’s hours and leave', hint: 'The whole team’s attendance, not just their own.' },
      { key: 'staff.clock', label: 'Clock in and out', hint: 'Record their own start and end of day at the till.' },
      { key: 'staff.edit', label: 'Correct hours and leave', hint: 'Amend a time entry somebody got wrong, or capture leave on their behalf.' },
      { key: 'staff.approve', label: 'Approve leave and timesheets', hint: 'Sign off what gets paid.' },
      /* Split from view_all deliberately, exactly as products.cost is split
         from products.view: a supervisor checking who worked Saturday should
         not thereby learn what everybody earns. */
      { key: 'staff.cost', label: 'See pay rates and staff cost', hint: 'What each person is paid, and what they cost the business.' },
      { key: 'staff.run', label: 'Run and lock a pay period', hint: 'Freeze a period’s figures once they have been paid.' },
    ],
  },
  {
    key: 'setup',
    label: 'Setup',
    capabilities: [
      { key: 'setup.view', label: 'Open setup', hint: 'Reach the setup screens at all.' },
      { key: 'setup.edit', label: 'Change settings', hint: 'Numbering, tenders, terminals, price structures and the rest.' },
      { key: 'setup.users', label: 'Manage users and roles', hint: 'Add people, set PINs and decide what each role may do.' },
    ],
  },
] as const

export const CAPABILITIES = CAPABILITY_GROUPS.flatMap((g) =>
  g.capabilities.map((c) => c.key),
) as readonly string[]

export type Capability = (typeof CAPABILITY_GROUPS)[number]['capabilities'][number]['key']

const CAPABILITY_SET = new Set<string>(CAPABILITIES)

export function isCapability(value: string): value is Capability {
  return CAPABILITY_SET.has(value)
}

/** Label and hint for one capability, for the permissions grid. */
export const CAPABILITY_LABELS: Record<string, { label: string; hint: string }> =
  Object.fromEntries(
    CAPABILITY_GROUPS.flatMap((g) =>
      g.capabilities.map((c) => [c.key, { label: c.label, hint: c.hint }]),
    ),
  )

/**
 * Everything a user may do, as a set. Resolved once per request and passed
 * down, rather than re-queried per check.
 *
 * `isOwner` is carried alongside because an owner's set is "everything" —
 * including capabilities added by a future migration that no stored row could
 * anticipate.
 */
export type CapabilitySet = {
  readonly isOwner: boolean
  readonly granted: ReadonlySet<string>
}

export const NO_CAPABILITIES: CapabilitySet = { isOwner: false, granted: new Set<string>() }

/** Whether a capability set permits something. */
export function can(capabilities: CapabilitySet, capability: Capability): boolean {
  if (capabilities.isOwner) return true
  return capabilities.granted.has(capability)
}

/** Whether any of these is permitted — for a menu section with several children. */
export function canAny(capabilities: CapabilitySet, caps: readonly Capability[]): boolean {
  if (capabilities.isOwner) return true
  return caps.some((c) => capabilities.granted.has(c))
}

/**
 * What one role may do.
 *
 * A null roleId means a user with no role assigned, which is deliberately not
 * the same as an error: they exist, they can sign in, and they can do nothing
 * until someone gives them a role.
 */
export async function capabilitiesForRole(
  siteId: number,
  roleId: number | null,
): Promise<CapabilitySet> {
  if (roleId === null) return NO_CAPABILITIES

  const rows = await siteQuery<RowDataPacket & { capability: string; is_owner: number }>(
    siteId,
    `SELECT r.is_owner, rp.capability
       FROM roles r
       LEFT JOIN role_permissions rp ON rp.role_id = r.id AND rp.allowed = 1
      WHERE r.id = ?`,
    [roleId],
  )
  if (!rows.length) return NO_CAPABILITIES

  return {
    isOwner: !!rows[0].is_owner,
    granted: new Set(rows.map((r) => r.capability).filter((c): c is string => !!c)),
  }
}

export type RoleSummary = {
  id: number
  name: string
  description: string | null
  isOwner: boolean
  isSystem: boolean
  /** How many active users hold it — the delete guard needs this. */
  userCount: number
}

export async function listRoles(siteId: number): Promise<RoleSummary[]> {
  const rows = await siteQuery<
    RowDataPacket & {
      id: number
      name: string
      description: string | null
      is_owner: number
      is_system: number
      user_count: number
    }
  >(
    siteId,
    // Most-privileged first, so the grid reads top-down the way people describe
    // a hierarchy. A plain alphabetical sort would file Cashier above Manager,
    // which makes the columns look shuffled. Roles the shop adds fall in
    // alphabetically after the seeded three.
    `SELECT r.id, r.name, r.description, r.is_owner, r.is_system,
            (SELECT COUNT(*) FROM users u WHERE u.role_id = r.id AND u.is_active = 1) AS user_count
       FROM roles r
      ORDER BY r.is_owner DESC,
               CASE WHEN r.is_system = 1 AND r.name = 'Manager' THEN 0
                    WHEN r.is_system = 1 AND r.name = 'Cashier' THEN 1
                    ELSE 2 END,
               r.name ASC`,
  )
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    isOwner: !!r.is_owner,
    isSystem: !!r.is_system,
    userCount: Number(r.user_count),
  }))
}

/** The whole grid: role id -> capability -> allowed. */
export type RoleMatrix = Record<number, Record<string, boolean>>

export async function capabilityMatrix(siteId: number): Promise<RoleMatrix> {
  const roles = await listRoles(siteId)
  const rows = await siteQuery<RowDataPacket & { role_id: number; capability: string; allowed: number }>(
    siteId,
    'SELECT role_id, capability, allowed FROM role_permissions',
  )

  const matrix: RoleMatrix = {}
  for (const role of roles) {
    matrix[role.id] = {}
    // An owner reads as every box ticked. The rows do not exist — that is the
    // point — so the grid is filled from the flag instead.
    for (const capability of CAPABILITIES) matrix[role.id][capability] = role.isOwner
  }
  for (const row of rows) {
    if (matrix[row.role_id] && !roles.find((r) => r.id === row.role_id)?.isOwner) {
      matrix[row.role_id][row.capability] = !!row.allowed
    }
  }
  return matrix
}

export type SaveResult = { ok: true } | { ok: false; error: string }

/**
 * Grants or revokes one capability on a role.
 *
 * The owner role is refused outright rather than being allowed to write rows
 * that `can()` would then ignore — a permissions screen that appears to save
 * something with no effect is worse than one that says no.
 */
export async function setCapability(
  siteId: number,
  roleId: number,
  capability: string,
  allowed: boolean,
): Promise<SaveResult> {
  if (!isCapability(capability)) {
    return { ok: false, error: 'That permission does not exist.' }
  }

  const role = await siteQuery<RowDataPacket & { is_owner: number }>(
    siteId,
    'SELECT is_owner FROM roles WHERE id = ? LIMIT 1',
    [roleId],
  )
  if (!role.length) return { ok: false, error: 'That role no longer exists.' }
  if (role[0].is_owner) {
    return { ok: false, error: 'The owner role keeps every permission — otherwise nobody can restore it.' }
  }

  await siteExecute(
    siteId,
    `INSERT INTO role_permissions (role_id, capability, allowed) VALUES (?,?,?)
     ON DUPLICATE KEY UPDATE allowed = VALUES(allowed)`,
    [roleId, capability, allowed ? 1 : 0],
  )
  return { ok: true }
}

export type RoleSaveResult = { ok: true; id: number } | { ok: false; error: string }

export async function createRole(
  siteId: number,
  name: string,
  description: string | null,
): Promise<RoleSaveResult> {
  const clean = name.trim()
  if (!clean) return { ok: false, error: 'Give the role a name.' }
  if (clean.length > 60) return { ok: false, error: 'That name is too long.' }

  const existing = await siteQuery<RowDataPacket>(
    siteId,
    'SELECT id FROM roles WHERE name = ? LIMIT 1',
    [clean],
  )
  if (existing.length) return { ok: false, error: 'A role with that name already exists.' }

  const res = await siteExecute(
    siteId,
    'INSERT INTO roles (name, description) VALUES (?,?)',
    [clean, description?.trim() || null],
  )
  return { ok: true, id: res.insertId }
}

export async function updateRole(
  siteId: number,
  roleId: number,
  name: string,
  description: string | null,
): Promise<SaveResult> {
  const clean = name.trim()
  if (!clean) return { ok: false, error: 'Give the role a name.' }

  const existing = await siteQuery<RowDataPacket & { id: number }>(
    siteId,
    'SELECT id FROM roles WHERE name = ? AND id <> ? LIMIT 1',
    [clean, roleId],
  )
  if (existing.length) return { ok: false, error: 'A role with that name already exists.' }

  await siteExecute(
    siteId,
    'UPDATE roles SET name = ?, description = ? WHERE id = ?',
    [clean, description?.trim() || null, roleId],
  )
  return { ok: true }
}

/**
 * Deletes a role.
 *
 * Refused while anyone still holds it. `users.role_id` is ON DELETE SET NULL,
 * so the delete would otherwise succeed and quietly leave those people with no
 * permissions at all — a lockout discovered at the till rather than here.
 */
export async function deleteRole(siteId: number, roleId: number): Promise<SaveResult> {
  const rows = await siteQuery<RowDataPacket & { is_owner: number; is_system: number; user_count: number }>(
    siteId,
    `SELECT r.is_owner, r.is_system,
            (SELECT COUNT(*) FROM users u WHERE u.role_id = r.id) AS user_count
       FROM roles r WHERE r.id = ? LIMIT 1`,
    [roleId],
  )
  if (!rows.length) return { ok: false, error: 'That role no longer exists.' }
  if (rows[0].is_owner) return { ok: false, error: 'The owner role cannot be deleted.' }
  if (Number(rows[0].user_count) > 0) {
    const n = Number(rows[0].user_count)
    return {
      ok: false,
      error: `${n} ${n === 1 ? 'person still holds' : 'people still hold'} this role. Move them to another role first.`,
    }
  }

  await siteExecute(siteId, 'DELETE FROM roles WHERE id = ?', [roleId])
  return { ok: true }
}
