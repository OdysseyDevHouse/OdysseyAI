import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { query, queryOne, execute } from './db'
import { siteQueryOne } from './siteDb'

/**
 * Linked stores.
 *
 * A STORE is a site — its own row in cp2_sites and its own master database
 * (ody10000_master, ody10001_master, …). Linking stores into a group means the
 * same product lives in each of their databases, matched by product CODE, and
 * an edit fans out to all of them.
 *
 * The link lives in the ticketing database (odyssey_tickets) beside cp2_sites,
 * because no single store's own database can own a relationship to another
 * store. Per-product exceptions to the sharing default live in each store's own
 * database — see lib/site/shareSettings.ts.
 */

export type StoreGroup = {
  id: number
  name: string
  primarySiteId: number | null
  status: 'active' | 'inactive'
}

export type GroupMember = {
  siteId: number
  siteCode: string
  displayName: string
  position: number
  /**
   * The master switch. With it off this store belongs to the group but
   * exchanges nothing — no edit fans out to it and its own products are never
   * touched. sharesCost / sharesSelling below only apply when this is on.
   */
  sharesProducts: boolean
  sharesDepartments: boolean
  /** Group defaults for newly created products. */
  sharesCost: boolean
  sharesSelling: boolean
  /** False when this site has no active database row — it cannot be written to. */
  hasDatabase: boolean
}

/**
 * What a store already holds.
 *
 * Turning product sharing on merges a store into the group's product file, and
 * that is only safe while the store is empty: the same code may exist in both
 * with different descriptions, departments and prices, and nothing here could
 * decide which is right. The screen uses this to block the toggle and say why.
 */
export type StoreContents = {
  products: number
  departments: number
  /** False when the store's database could not be read at all. */
  readable: boolean
}

type GroupRow = RowDataPacket & {
  id: number
  name: string
  primary_site_id: number | null
  status: 'active' | 'inactive'
}

type MemberRow = RowDataPacket & {
  site_id: number
  site_code: string
  company_name: string
  trading_name: string | null
  position: number
  shares_products: number
  shares_departments: number
  shares_cost: number
  shares_selling: number
  db_count: number
}

function mapGroup(r: GroupRow): StoreGroup {
  return {
    id: Number(r.id),
    name: String(r.name),
    primarySiteId: r.primary_site_id === null ? null : Number(r.primary_site_id),
    status: r.status,
  }
}

function mapMember(r: MemberRow): GroupMember {
  return {
    siteId: Number(r.site_id),
    siteCode: String(r.site_code),
    displayName: r.trading_name?.trim() || String(r.company_name),
    position: Number(r.position),
    sharesProducts: Boolean(r.shares_products),
    sharesDepartments: Boolean(r.shares_departments),
    sharesCost: Boolean(r.shares_cost),
    sharesSelling: Boolean(r.shares_selling),
    hasDatabase: Number(r.db_count) > 0,
  }
}

/** The group a site belongs to, if any. A site belongs to at most one. */
export async function groupForSite(siteId: number): Promise<StoreGroup | null> {
  const row = await queryOne<GroupRow>(
    `SELECT g.id, g.name, g.primary_site_id, g.status
       FROM cp2_store_groups g
       JOIN cp2_store_group_members m ON m.group_id = g.id
      WHERE m.site_id = ? AND g.status = 'active'
      LIMIT 1`,
    [siteId],
  )
  return row ? mapGroup(row) : null
}

/**
 * Every store in a group, in display order.
 *
 * `hasDatabase` is joined in rather than assumed: a site can exist in cp2_sites
 * with no cp2_site_databases row yet, and fanning a write out to it would fail
 * at connect time. Callers must skip those.
 */
export async function membersOfGroup(groupId: number): Promise<GroupMember[]> {
  return (
    await query<MemberRow>(
      `SELECT m.site_id, s.site_code, s.company_name, s.trading_name,
              m.position, m.shares_products, m.shares_departments,
              m.shares_cost, m.shares_selling,
              (SELECT COUNT(*) FROM cp2_site_databases d
                WHERE d.site_id = m.site_id AND d.purpose = 'master' AND d.status = 'active'
              ) AS db_count
         FROM cp2_store_group_members m
         JOIN cp2_sites s ON s.id = m.site_id
        WHERE m.group_id = ?
        ORDER BY m.position ASC, s.company_name ASC`,
      [groupId],
    )
  ).map(mapMember)
}

/**
 * The stores an edit made in `siteId` should also write to.
 *
 * Returns [] when the site is in no group — the single-store case, where the
 * product screen behaves exactly as it always has. Sites with no active
 * database are excluded: they cannot be written to, and silently failing
 * halfway through a fan-out is worse than not attempting it.
 */
export async function linkedStores(siteId: number): Promise<GroupMember[]> {
  const group = await groupForSite(siteId)
  if (!group) return []
  const members = await membersOfGroup(group.id)
  // A store with sharing switched off belongs to the group but exchanges
  // nothing, so it is excluded here — this is the list the product screen fans
  // out to and reads from.
  return members.filter((m) => m.hasDatabase && m.sharesProducts)
}

/**
 * Counts what a store holds, for the "must be empty to enable sharing" gate.
 *
 * Reads the store's own database, so it is deliberately kept out of
 * membersOfGroup(): that runs on every product page load, and opening every
 * linked store's database just to render a list would be wasteful. This is
 * called only by the setup screen.
 */
export async function storeContents(siteId: number): Promise<StoreContents> {
  try {
    const products = await siteQueryOne<RowDataPacket & { n: number }>(
      siteId,
      'SELECT COUNT(*) AS n FROM products',
    )
    const departments = await siteQueryOne<RowDataPacket & { n: number }>(
      siteId,
      'SELECT COUNT(*) AS n FROM departments',
    )
    return {
      products: Number(products?.n ?? 0),
      departments: Number(departments?.n ?? 0),
      readable: true,
    }
  } catch {
    // Unreachable database, or one that has never been migrated. Reported
    // rather than thrown so the screen can say so instead of failing.
    return { products: 0, departments: 0, readable: false }
  }
}

export async function listGroups(): Promise<StoreGroup[]> {
  return (
    await query<GroupRow>(
      `SELECT id, name, primary_site_id, status FROM cp2_store_groups ORDER BY name ASC`,
    )
  ).map(mapGroup)
}

export async function createGroup(name: string, primarySiteId: number | null): Promise<number> {
  const res = await execute(
    'INSERT INTO cp2_store_groups (name, primary_site_id) VALUES (?, ?)',
    [name.trim(), primarySiteId],
  )
  return res.insertId
}

export async function renameGroup(groupId: number, name: string): Promise<void> {
  await execute('UPDATE cp2_store_groups SET name = ? WHERE id = ?', [name.trim(), groupId])
}

export async function deleteGroup(groupId: number): Promise<void> {
  // Members cascade. Each store's own data is untouched — unlinking is not
  // destructive, it only stops future edits fanning out.
  await execute('DELETE FROM cp2_store_groups WHERE id = ?', [groupId])
}

/** Adds a site to a group, moving it if it already belongs to another. */
export async function addMember(
  groupId: number,
  siteId: number,
  opts: {
    sharesProducts?: boolean
    sharesDepartments?: boolean
    sharesCost?: boolean
    sharesSelling?: boolean
    position?: number
  } = {},
): Promise<void> {
  await execute(
    `INSERT INTO cp2_store_group_members
       (group_id, site_id, position, shares_products, shares_departments,
        shares_cost, shares_selling)
     VALUES (?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE group_id = VALUES(group_id), position = VALUES(position),
                             shares_products = VALUES(shares_products),
                             shares_departments = VALUES(shares_departments),
                             shares_cost = VALUES(shares_cost),
                             shares_selling = VALUES(shares_selling)`,
    [
      groupId,
      siteId,
      opts.position ?? 0,
      opts.sharesProducts ? 1 : 0,
      opts.sharesDepartments ? 1 : 0,
      opts.sharesCost === false ? 0 : 1,
      opts.sharesSelling === false ? 0 : 1,
    ],
  )
}

export async function removeMember(groupId: number, siteId: number): Promise<void> {
  await execute('DELETE FROM cp2_store_group_members WHERE group_id = ? AND site_id = ?', [
    groupId,
    siteId,
  ])
}

export type MemberSharing = {
  sharesProducts: boolean
  sharesDepartments: boolean
  sharesCost: boolean
  sharesSelling: boolean
}

/**
 * Writes a store's sharing settings.
 *
 * Refuses to switch product sharing ON while the store still holds products or
 * departments — see StoreContents. The check lives here rather than only in the
 * screen so that no future caller can bypass it: merging two populated product
 * files is not something this app can undo.
 */
export async function setMemberSharing(
  groupId: number,
  siteId: number,
  sharing: MemberSharing,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (sharing.sharesProducts) {
    const current = await queryOne<RowDataPacket & { shares_products: number }>(
      'SELECT shares_products FROM cp2_store_group_members WHERE group_id = ? AND site_id = ?',
      [groupId, siteId],
    )
    // Only a transition from off to on needs the store to be empty; leaving it
    // on must not start failing once the store legitimately fills up.
    if (current && !current.shares_products) {
      const contents = await storeContents(siteId)
      if (!contents.readable) {
        return { ok: false, error: 'That store’s database could not be read.' }
      }
      if (contents.products > 0 || contents.departments > 0) {
        return {
          ok: false,
          error:
            `This store currently has ${contents.products} product(s) and ` +
            `${contents.departments} department(s). Please delete all products and ` +
            'departments to start using this feature.',
        }
      }
    }
  }

  await execute(
    `UPDATE cp2_store_group_members
        SET shares_products = ?, shares_departments = ?, shares_cost = ?, shares_selling = ?
      WHERE group_id = ? AND site_id = ?`,
    [
      sharing.sharesProducts ? 1 : 0,
      sharing.sharesDepartments ? 1 : 0,
      sharing.sharesCost ? 1 : 0,
      sharing.sharesSelling ? 1 : 0,
      groupId,
      siteId,
    ],
  )
  return { ok: true }
}
