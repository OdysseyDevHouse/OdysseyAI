import 'server-only'
import { cache } from 'react'
import type { RowDataPacket } from 'mysql2/promise'
import { query, queryOne, execute } from './db'
import { siteQueryOne, MASTER, type SitePurpose } from './siteDb'
import { entitlementsForSite, allHold, has as hasModule } from './control/modules'

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
  /**
   * Whether the primary's storefront serves the whole group: one online shop, a
   * branch picker, and every order routed to the branch that will pack it.
   *
   * Off means each store keeps its own separate storefront, which is what all of
   * them have today.
   */
  onlineGroupMode: boolean
  /**
   * Whether these stores are one registered company or several.
   *
   * Gates BALANCE sharing — see sql/tickets/016_group_legal_entity.sql. Several
   * separate taxpayers cannot share one debtors book without one of them
   * collecting money it does not own, and doing so silently misstates two sets
   * of statutory records.
   *
   * 'unknown' until somebody answers, and deliberately not assumed: defaulting
   * to 'one' would switch a legal judgement on by silence.
   */
  legalEntity: 'unknown' | 'one' | 'several'
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
  /**
   * Whether this store reads and writes the GROUP's customer file rather than
   * its own.
   *
   * Unlike sharesProducts this is ownership, not replication — see
   * customerOwnerSite() below and sql/tickets/015_share_customers.sql. A
   * customer's balance is a running total, and a running total cannot be
   * copied to ten databases without drifting.
   */
  sharesCustomers: boolean
  /** The same, for the creditors book. Separately answerable on purpose. */
  sharesSuppliers: boolean
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
  /**
   * What the store's own master files hold, for the customer and supplier
   * gates. Same rule as products: a file can only be merged into the group's
   * while it is empty, because two files may use one code for two different
   * people and nothing here could decide which is right.
   */
  customers: number
  suppliers: number
  /** False when the store's database could not be read at all. */
  readable: boolean
}

type GroupRow = RowDataPacket & {
  id: number
  name: string
  primary_site_id: number | null
  status: 'active' | 'inactive'
  online_group_mode?: number
  legal_entity?: 'unknown' | 'one' | 'several'
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
  shares_customers?: number
  shares_suppliers?: number
  db_count: number
}

function mapGroup(r: GroupRow): StoreGroup {
  return {
    id: Number(r.id),
    name: String(r.name),
    primarySiteId: r.primary_site_id === null ? null : Number(r.primary_site_id),
    status: r.status,
    // Absent on a control database that has not run 009 yet. Off is the correct
    // reading of "this column does not exist": nobody has switched it on.
    onlineGroupMode: Boolean(r.online_group_mode),
    // Absent on a control database that has not run 016. Unknown is the correct
    // reading of a missing answer.
    legalEntity: r.legal_entity ?? 'unknown',
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
    // Absent on a control database that has not run 015 yet. Off is the
    // correct reading of "this column does not exist" — nobody has switched
    // it on — and it matches how onlineGroupMode handles the same case.
    sharesCustomers: Boolean(r.shares_customers),
    sharesSuppliers: Boolean(r.shares_suppliers),
    hasDatabase: Number(r.db_count) > 0,
  }
}

/** The group a site belongs to, if any. A site belongs to at most one. */
export async function groupForSite(siteId: number): Promise<StoreGroup | null> {
  const row = await queryOne<GroupRow>(
    `SELECT g.id, g.name, g.primary_site_id, g.status, g.online_group_mode, g.legal_entity
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
              m.shares_customers, m.shares_suppliers,
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
 *
 * ── THIS FUNCTION IS THE MULTI-BRANCH BOUNDARY ──────────────────────────────
 *
 * Product fan-out, inter-store transfers, the linked-store panel on the product
 * screen and every group report reach the other stores THROUGH here. So the
 * module is checked once, in this function, rather than at each of those call
 * sites — a guard repeated eight times is a guard that will be missed on the
 * ninth. Anything that grows its own member list later bypasses this, which is
 * why it must not.
 *
 * ── BOTH ENDS MUST HOLD IT ──────────────────────────────────────────────────
 *
 * The caller's own entitlement is checked first, then the member list is
 * filtered to those stores that also hold it. A store that declined
 * Multi-Branch neither sends a product edit nor receives one — which is the
 * honest reading of "declining it disables cross-store sharing", and the only
 * one that cannot be worked around by editing from the other end.
 */
export async function linkedStores(siteId: number): Promise<GroupMember[]> {
  const group = await groupForSite(siteId)
  if (!group) return []

  const entitlements = await entitlementsForSite(siteId)
  if (!hasModule(entitlements, 'multi_branch')) return []

  const members = await membersOfGroup(group.id)
  /*
   * A store with sharing switched off belongs to the group but exchanges
   * nothing, so it is excluded here — this is the list the product screen fans
   * out to and reads from.
   *
   * ── HEAD OFFICE IS ALWAYS IN ─────────────────────────────────────────────
   *
   * Its own flag is not consulted, because "does head office share with the
   * branches" is not a question: if a group has a head office, its catalogue is
   * the one the branches are choosing whether to use. The setup screen
   * therefore offers head office no such switch, and this is what makes that
   * safe — a stale 0 in its row cannot silently empty the pool and stop every
   * branch receiving product edits.
   *
   * A branch still decides for itself, which is the real per-store choice.
   */
  const sharing = members.filter(
    (m) => m.hasDatabase && (m.sharesProducts || m.siteId === group.primarySiteId),
  )

  const entitled = await allHold(
    sharing.map((m) => m.siteId),
    'multi_branch',
  )
  return sharing.filter((m) => entitled.has(m.siteId))
}

/* ────────────────────────────────────────────────────────────────────────
 * WHICH DATABASE OWNS THE CUSTOMER
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * A database to read or write, as (site, purpose).
 *
 * A PAIR rather than a bare site id on purpose. Today the shared customer file
 * lives in the primary store's own master database, so this always resolves to
 * `purpose: 'master'`. If the file ever earns a database of its own — one
 * `ody1000X_customer` per group rather than a table inside one store's master —
 * that becomes a change to THIS FUNCTION and nothing else.
 *
 * Returning the pair now costs nothing and keeps that door open. Returning a
 * bare number would close it, because 125 call sites would have to be revisited
 * to add the purpose back.
 */
export type OwnerDb = { siteId: number; purpose: SitePurpose }

/**
 * Which database holds this store's customer file.
 *
 * ── THIS IS THE SHARED-FILE BOUNDARY ────────────────────────────────────────
 *
 * The sibling of linkedStores(), and the same kind of thing: every module that
 * touches a customer asks HERE which database owns it, rather than assuming its
 * own. A store in no group, or in a group that does not share, resolves to
 * itself — which is why routing a call site through this function is a no-op
 * until somebody switches the flag on.
 *
 * ── OWNERSHIP, NOT REPLICATION ──────────────────────────────────────────────
 *
 * linkedStores() answers "who else should receive a copy of this edit".  This
 * answers "where does the one true row live". The difference is the whole
 * design: a product's cost price is a value that can be copied, a customer's
 * balance is a running total that cannot. See sql/tickets/015_share_customers.sql.
 *
 * ── BOTH ENDS MUST HOLD IT ──────────────────────────────────────────────────
 *
 * The caller's own multi_branch entitlement is checked, and so is the primary's.
 * A store that declined Multi-Branch neither reads the group file nor
 * contributes to it, and a primary that declined it cannot be made to host one.
 * Same posture as linkedStores(), for the same reason.
 *
 * ── IT MUST NEVER THROW ─────────────────────────────────────────────────────
 *
 * A control-database blip must not take the debtors book down. Every failure
 * path returns the caller's own site, which is exactly what a single store
 * does — the till keeps trading against its own database rather than showing an
 * error. That is the same fail-open posture the module checks already take,
 * and it is safe here because reading your own customers is never WRONG, only
 * narrower than the group view.
 */
export const customerOwnerSite = cache(async (siteId: number): Promise<OwnerDb> => {
  return ownerSiteFor(siteId, 'customers')
})

/** The same, for the creditors book. Answered separately by design. */
export const supplierOwnerSite = cache(async (siteId: number): Promise<OwnerDb> => {
  return ownerSiteFor(siteId, 'suppliers')
})

/**
 * The shared resolution both public helpers run.
 *
 * Memoised by its callers rather than here: React's cache() keys on arguments,
 * and two exported wrappers give a clearer cache key than one function taking a
 * discriminator — a page that resolves customers forty times asks the control
 * database once.
 */
async function ownerSiteFor(
  siteId: number,
  file: 'customers' | 'suppliers',
): Promise<OwnerDb> {
  const own: OwnerDb = { siteId, purpose: MASTER }

  try {
    const group = await groupForSite(siteId)
    if (!group) return own

    // No primary means "the shared file" names nothing. A group can exist in
    // that state — createGroup() allows a null primary — so this is a real
    // case, not a defensive check.
    if (!group.primarySiteId) return own

    // Separate companies must not share a balance, and the answer can change
    // AFTER the flags were set — somebody corrects it in setup, or a group is
    // restructured. Read here rather than trusted from the member row, so that
    // saying "these are separate companies" stops the sharing immediately
    // instead of leaving stale flags routing writes into another taxpayer's
    // debtors book.
    if (group.legalEntity !== 'one') return own

    const members = await membersOfGroup(group.id)
    const me = members.find((m) => m.siteId === siteId)
    const shares = file === 'customers' ? me?.sharesCustomers : me?.sharesSuppliers
    if (!shares) return own

    // The primary must be in the group, hold a database, and share the same
    // file. A primary that does not share cannot host the group's file — that
    // combination is refused at the switch, and honoured here too so a stale
    // row can never route a write into a store that opted out.
    const primary = members.find((m) => m.siteId === group.primarySiteId)
    if (!primary?.hasDatabase) return own
    const primaryShares =
      file === 'customers' ? primary.sharesCustomers : primary.sharesSuppliers
    if (!primaryShares) return own

    // Already the owner. Returned before the entitlement round trip because the
    // answer cannot differ: a store always owns its own database.
    if (primary.siteId === siteId) return own

    const entitlements = await entitlementsForSite(siteId)
    if (!hasModule(entitlements, 'multi_branch')) return own

    const entitled = await allHold([primary.siteId], 'multi_branch')
    if (!entitled.has(primary.siteId)) return own

    return { siteId: primary.siteId, purpose: MASTER }
  } catch {
    // See the header: narrower is safe, unavailable is not.
    return own
  }
}

/**
 * Whether this store's customer file is shared with other stores.
 *
 * For the handful of callers that need to BEHAVE differently rather than merely
 * read from elsewhere — the spend-limit measurement, which must sum the shared
 * ledger instead of local tenders, and the debtors reconciliation, which must
 * compare against every member's control account rather than one store's.
 * Most callers should just use the site id and not care.
 *
 * ── TRUE AT BOTH ENDS, WHICH IS THE WHOLE POINT ──────────────────────────
 *
 * This used to read `owner.siteId !== siteId` — "is my file in somebody else's
 * database". That is true at a branch and FALSE at the primary, even though
 * the primary's customers table is precisely the shared file: it holds every
 * branch's debtors and its balances are group balances.
 *
 * A caller asking this question is asking "is this file shared", not "is it
 * elsewhere". Answering the second broke the debtors reconciliation at head
 * office, which is the one place that reconciles the whole book — see
 * debtorsGroupScope() in site/chartOfAccounts.ts. Callers that genuinely need
 * "is it elsewhere" should compare customerOwnerSite() themselves, which is
 * what customerDbPrefix() does and why it stays correct.
 */
export async function customerFileIsShared(siteId: number): Promise<boolean> {
  return fileIsShared(siteId, customerOwnerSite)
}

/**
 * The same question for the creditors book, answered separately on purpose.
 *
 * A group may share one customer file while each branch keeps its own
 * suppliers, or the reverse — central buying from one creditors book with
 * separate debtors. sql/tickets/015_share_customers.sql gives them two columns
 * for exactly that reason, so they get two functions.
 */
export async function supplierFileIsShared(siteId: number): Promise<boolean> {
  return fileIsShared(siteId, supplierOwnerSite)
}

/**
 * "Is this file shared with anyone", for either master file.
 *
 * Factored rather than written twice: the customer version was subtly wrong
 * once already (see the note above), and two copies of this reasoning is two
 * places for the next person to fix only one of.
 */
async function fileIsShared(
  siteId: number,
  ownerOf: (siteId: number) => Promise<OwnerDb>,
): Promise<boolean> {
  const owner = await ownerOf(siteId)
  // A branch: the file is somewhere else. Answered first and cheaply.
  if (owner.siteId !== siteId) return true

  // Otherwise this store owns its own file — but that covers two very different
  // cases, and only one of them is "not shared". A primary hosting the group's
  // file also resolves to itself, so the question becomes whether any OTHER
  // member routes here.
  try {
    const group = await groupForSite(siteId)
    if (!group) return false
    const members = await membersOfGroup(group.id)
    for (const m of members) {
      if (m.siteId === siteId) continue
      const theirOwner = await ownerOf(m.siteId)
      if (theirOwner.siteId === siteId) return true
    }
    return false
  } catch {
    // A control-database problem must not make a single shop start behaving
    // like a group. Falling back to "not shared" is what the site did before
    // any of this existed.
    return false
  }
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
    // Read from the store's OWN database on purpose, not through the customer
    // resolver: the question is "what would have to be merged if this store
    // started sharing", which is about the rows sitting here.
    const customers = await siteQueryOne<RowDataPacket & { n: number }>(
      siteId,
      'SELECT COUNT(*) AS n FROM customers',
    )
    const suppliers = await siteQueryOne<RowDataPacket & { n: number }>(
      siteId,
      'SELECT COUNT(*) AS n FROM suppliers',
    )
    return {
      products: Number(products?.n ?? 0),
      departments: Number(departments?.n ?? 0),
      customers: Number(customers?.n ?? 0),
      suppliers: Number(suppliers?.n ?? 0),
      readable: true,
    }
  } catch {
    // Unreachable database, or one that has never been migrated. Reported
    // rather than thrown so the screen can say so instead of failing.
    return { products: 0, departments: 0, customers: 0, suppliers: 0, readable: false }
  }
}

export async function listGroups(): Promise<StoreGroup[]> {
  return (
    await query<GroupRow>(
      `SELECT id, name, primary_site_id, status, online_group_mode, legal_entity FROM cp2_store_groups ORDER BY name ASC`,
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

/**
 * Switches the group's shared storefront on or off.
 *
 * ── WHAT THIS REFUSES, AND WHY IT REFUSES RATHER THAN WARNS ─────────────────
 *
 * Turning it ON makes one shop's catalogue public on behalf of nine others, so
 * the preconditions are checked here rather than only in the screen — the same
 * posture as setMemberSharing, and for the same reason: no future caller should
 * be able to bypass them.
 *
 *   no primary          — there is no shop whose catalogue would be served, so
 *                         "the group storefront" names nothing.
 *   primary's shop off  — its online_store_settings.is_enabled is 0, so the
 *                         storefront it would serve is a 404. Switching this on
 *                         would look like it worked and produce a dead link.
 *
 * Unpinned branches are deliberately NOT a refusal. The picker lists them by
 * name and they are perfectly orderable; only distance sorting needs a pin. A
 * group should be able to switch this on and pin its shops afterwards.
 *
 * Turning it OFF is never refused. Each store simply goes back to its own
 * storefront, which is where it started.
 */
export async function setGroupOnlineMode(
  groupId: number,
  on: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (on) {
    const group = await queryOne<GroupRow>(
      'SELECT id, name, primary_site_id, status, online_group_mode, legal_entity FROM cp2_store_groups WHERE id = ?',
      [groupId],
    )
    if (!group) return { ok: false, error: 'That store group no longer exists.' }

    const primarySiteId = group.primary_site_id === null ? null : Number(group.primary_site_id)
    if (!primarySiteId) {
      return {
        ok: false,
        error: 'Choose which store owns the shared product file before turning this on.',
      }
    }

    // Read the primary's own settings. Guarded: a site whose database is
    // unreachable must produce a refusal that says so, not a stack trace.
    let primaryShopOn = false
    try {
      const row = await siteQueryOne<RowDataPacket & { is_enabled: number }>(
        primarySiteId,
        'SELECT is_enabled FROM online_store_settings WHERE id = 1',
      )
      primaryShopOn = Boolean(row?.is_enabled)
    } catch {
      return { ok: false, error: 'The main store’s online shop settings could not be read.' }
    }
    if (!primaryShopOn) {
      return {
        ok: false,
        error: 'Switch the main store’s online shop on first — that is the shop this serves.',
      }
    }
  }

  await execute('UPDATE cp2_store_groups SET online_group_mode = ? WHERE id = ?', [
    on ? 1 : 0,
    groupId,
  ])
  return { ok: true }
}

/**
 * Names which store is head office.
 *
 * ── WHAT HEAD OFFICE ACTUALLY DOES ───────────────────────────────────────
 *
 * It is not a label. The primary's own database HOLDS the shared customer and
 * supplier files, so every other store in the group reads and writes them over
 * there — see customerOwnerSite(). It is also the shop whose catalogue the
 * group storefront serves, and the store a shared product is edited from.
 *
 * ── WHY MOVING IT IS REFUSED WHILE FILES ARE SHARED ──────────────────────
 *
 * Changing this column does not move any DATA. Point it at another store while
 * a group shares its customer file and every branch immediately starts reading
 * a database that does not hold the customers — their whole debtors book
 * appears to vanish, while it sits untouched in the old primary.
 *
 * There is no safe automatic answer to that, because moving the file is a
 * merge: the new primary may hold customers of its own. So the sharing
 * switches come off first, deliberately, which is also the point at which
 * somebody has to decide where each branch's book is coming from.
 */
export async function setGroupPrimary(
  groupId: number,
  siteId: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const members = await membersOfGroup(groupId)

  const target = members.find((m) => m.siteId === siteId)
  if (!target) return { ok: false, error: 'That store is not in this group.' }
  if (!target.hasDatabase) {
    return {
      ok: false,
      error: `${target.displayName} has no database, so it cannot hold the group’s files.`,
    }
  }

  const sharing = members.filter((m) => m.sharesCustomers || m.sharesSuppliers)
  if (sharing.length > 0) {
    return {
      ok: false,
      error:
        `${sharing.length} store(s) are sharing a customer or supplier file, which ` +
        'lives in the current head office’s database. Switch that sharing off ' +
        'before moving head office, or those stores would be reading a database ' +
        'that no longer holds their customers.',
    }
  }

  await execute('UPDATE cp2_store_groups SET primary_site_id = ? WHERE id = ?', [siteId, groupId])
  return { ok: true }
}

/**
 * Records whether the group's stores are one company or several.
 *
 * ── WHY CHANGING TO 'several' IS REFUSED WHILE FILES ARE SHARED ──────────
 *
 * Switching the answer does not un-share anything by itself; the resolver
 * simply stops routing, and every branch is suddenly reading its own empty
 * customer file while its history sits in the primary. That looks exactly like
 * data loss to whoever is standing at the till.
 *
 * So the sharing switches must be turned off first, deliberately, one store at
 * a time — which is also the point at which somebody has to think about where
 * each branch's debtors book is going to come from.
 */
export async function setGroupLegalEntity(
  groupId: number,
  entity: StoreGroup['legalEntity'],
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (entity === 'several') {
    const members = await membersOfGroup(groupId)
    const sharing = members.filter((m) => m.sharesCustomers || m.sharesSuppliers)
    if (sharing.length > 0) {
      return {
        ok: false,
        error:
          `${sharing.length} store(s) still share a customer or supplier file. ` +
          'Switch those off first — separate companies each need their own book, ' +
          'and this cannot decide how to split one that is already shared.',
      }
    }
  }

  await execute('UPDATE cp2_store_groups SET legal_entity = ? WHERE id = ?', [entity, groupId])
  return { ok: true }
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
  /**
   * Optional so an existing caller that only edits product sharing leaves the
   * customer switches exactly as they are. Passing `false` MEANS false;
   * omitting means "do not touch".
   */
  sharesCustomers?: boolean
  sharesSuppliers?: boolean
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
  /*
   * Head office is exempt: its catalogue IS the one the branches receive, so
   * there is nothing to merge and nothing that could collide on a code. Only a
   * BRANCH joining the pool brings a second populated file.
   *
   * Not merely cosmetic — the setup screen no longer offers head office the
   * switch and posts it on, so without this every save of head office's card
   * would be refused for holding its own products.
   */
  const primaryRow = await queryOne<RowDataPacket & { primary_site_id: number | null }>(
    'SELECT primary_site_id FROM cp2_store_groups WHERE id = ?',
    [groupId],
  )
  const isPrimary = Number(primaryRow?.primary_site_id ?? 0) === siteId

  if (sharing.sharesProducts && !isPrimary) {
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

  // The customer and supplier switches have preconditions of their own, and
  // they are checked HERE rather than only in the screen for the same reason
  // the product gate is: merging two populated debtors books is not something
  // this app can undo, and no future caller should be able to bypass it.
  for (const file of ['customers', 'suppliers'] as const) {
    const wanted = file === 'customers' ? sharing.sharesCustomers : sharing.sharesSuppliers
    if (wanted !== true) continue

    const column = file === 'customers' ? 'shares_customers' : 'shares_suppliers'
    const current = await queryOne<RowDataPacket & Record<string, number>>(
      `SELECT ${column} AS on_now FROM cp2_store_group_members
        WHERE group_id = ? AND site_id = ?`,
      [groupId, siteId],
    )
    // Only an off-to-on transition is gated. A store already sharing
    // legitimately fills up with customers and must not become un-saveable.
    if (current && current.on_now) continue

    const refusal = await sharedFileRefusal(groupId, siteId, file)
    if (refusal) return { ok: false, error: refusal }
  }

  const sets = [
    'shares_products = ?',
    'shares_departments = ?',
    'shares_cost = ?',
    'shares_selling = ?',
  ]
  const params: unknown[] = [
    sharing.sharesProducts ? 1 : 0,
    sharing.sharesDepartments ? 1 : 0,
    sharing.sharesCost ? 1 : 0,
    sharing.sharesSelling ? 1 : 0,
  ]
  // Omitted means "leave alone" — see MemberSharing. A caller that only edits
  // product sharing must not silently switch the customer file off.
  if (sharing.sharesCustomers !== undefined) {
    sets.push('shares_customers = ?')
    params.push(sharing.sharesCustomers ? 1 : 0)
  }
  if (sharing.sharesSuppliers !== undefined) {
    sets.push('shares_suppliers = ?')
    params.push(sharing.sharesSuppliers ? 1 : 0)
  }

  await execute(
    `UPDATE cp2_store_group_members SET ${sets.join(', ')}
      WHERE group_id = ? AND site_id = ?`,
    [...params, groupId, siteId],
  )
  return { ok: true }
}

/**
 * Why this store may not start sharing the group's customer or supplier file,
 * or null when it may.
 *
 * Three preconditions, each of which produces a WRONG SYSTEM rather than an
 * inconvenience if skipped. They are stated in
 * sql/tickets/015_share_customers.sql too, because a rule enforced in only one
 * place is a rule that moves when the code does.
 */
async function sharedFileRefusal(
  groupId: number,
  siteId: number,
  file: 'customers' | 'suppliers',
): Promise<string | null> {
  const label = file === 'customers' ? 'customer' : 'supplier'

  const group = await queryOne<GroupRow>(
    'SELECT id, name, primary_site_id, status, online_group_mode, legal_entity FROM cp2_store_groups WHERE id = ?',
    [groupId],
  )
  if (!group) return 'That store group no longer exists.'

  const primarySiteId = group.primary_site_id === null ? null : Number(group.primary_site_id)
  if (!primarySiteId) {
    return `Choose which store owns the shared ${label} file before turning this on.`
  }

  /* ── One taxpayer, or several ─────────────────────────────────────────
   *
   * Checked BEFORE the emptiness rules, because it is the only one that is
   * not about this store's data at all — it is about whether the feature is
   * appropriate to the business, and answering it changes the advice rather
   * than the tidying-up.
   *
   * Enforced here rather than only in the screen: a shared debtors book across
   * separate companies means one of them collecting money it does not own, and
   * that is not a rule a future caller should be able to skip.
   */
  const entity = (group.legal_entity ?? 'unknown') as StoreGroup['legalEntity']
  if (entity === 'several') {
    return (
      `These stores are separate companies, so they cannot share one ${label} ` +
      'file — a balance settled at one store would be money collected by ' +
      'another. Their contact details can still be kept in step.'
    )
  }
  if (entity === 'unknown') {
    return (
      'Say whether these stores are one company or several before sharing a ' +
      `${label} file. It decides whether one shared balance is correct.`
    )
  }

  // The store that OWNS the file has nothing to merge — it is already where
  // the rows live — so the emptiness and same-server checks below do not apply
  // to it.
  if (primarySiteId === siteId) return null

  /* ── The joining store must be empty ─────────────────────────────────── */

  const table = file === 'customers' ? 'customers' : 'suppliers'
  let held = 0
  try {
    const row = await siteQueryOne<RowDataPacket & { n: number }>(
      siteId,
      `SELECT COUNT(*) AS n FROM \`${table}\``,
    )
    held = Number(row?.n ?? 0)
  } catch {
    return `This store’s database could not be read, so ${label} sharing cannot be changed.`
  }
  if (held > 0) {
    return (
      `This store currently has ${held} ${label}(s). Two ${label} files cannot be ` +
      'merged automatically — the same code may exist in both for different ' +
      `people. Please remove this store’s ${label}s before sharing the group file.`
    )
  }

  /* ── Both databases must be on the same server ───────────────────────── */

  // The whole design rests on this: same instance means a cross-database join
  // is cheap and a write to the owner is an ordinary transaction. The host is
  // stored per database, so nothing else prevents a member being configured
  // elsewhere — and the failure would be a confusing runtime error in a shop
  // rather than a refusal in setup.
  const hosts = await query<RowDataPacket & { site_id: number; server_host: string; server_port: number }>(
    `SELECT site_id, server_host, server_port FROM cp2_site_databases
      WHERE site_id IN (?, ?) AND purpose = 'master' AND status = 'active'`,
    [siteId, primarySiteId],
  )
  const mine = hosts.find((h) => Number(h.site_id) === siteId)
  const theirs = hosts.find((h) => Number(h.site_id) === primarySiteId)
  if (!mine || !theirs) {
    return `The main store’s database could not be found, so the ${label} file cannot be shared.`
  }
  if (mine.server_host !== theirs.server_host || Number(mine.server_port) !== Number(theirs.server_port)) {
    return (
      `A shared ${label} file needs both stores on the same database server. ` +
      `This store is on ${mine.server_host} and the main store is on ${theirs.server_host}.`
    )
  }

  return null
}
