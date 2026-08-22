import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery } from '../siteDb'
import { linkedStores } from '../storeGroups'
import { saveSpecial, listSpecials, type SpecialWithUse } from './specials'
import type { SpecialInput, SpecialItemInput } from '../specialsEngine'

/**
 * Pushing one promotion out to the other stores in a group.
 *
 * ── WHY THIS EXISTS AT ALL ───────────────────────────────────────────────
 *
 * A store IS a site with its own database (003), so a special has always been
 * per-branch by construction. What was missing is the opposite: head office
 * could not run one promotion across twenty branches. Somebody retyped it
 * twenty times, and the twentieth was not the same as the first.
 *
 * ── IT COPIES; IT DOES NOT SHARE ─────────────────────────────────────────
 *
 * Each store gets its OWN row, with its own id, which it can then switch off,
 * re-time or edit. That is deliberate and it is what a branch needs: a
 * promotion that head office set for the coast should be stoppable by the
 * branch whose stock ran out, without phoning head office.
 *
 * The alternative — one row read by every store — cannot be done anyway: no
 * foreign key and no transaction spans two databases, and `special_items`
 * points at products whose ids differ per store.
 *
 * ── SO IDS CANNOT TRAVEL. CODES DO ───────────────────────────────────────
 *
 * Product ids increment independently in each database, so id 412 is a
 * different thing in every store. The whole file translates
 * product id → CODE → the target's product id, and departments by NAME, the
 * same rule 004 set for shared products and branchCatalogue follows.
 *
 * A product the target does not stock is a REPORTED SKIP rather than a silent
 * drop: a promotion that quietly covers four products at one branch and three
 * at another is exactly the kind of difference nobody finds until a customer
 * argues about a price.
 */

type Row = RowDataPacket & Record<string, unknown>

export type FanoutOutcome = {
  siteId: number
  storeName: string
  ok: boolean
  /** 'created' | 'updated', or why it did not happen. */
  detail: string
  /** Products this store does not stock, so the copy could not cover them. */
  skipped: string[]
}

/** What the source special's items look like once translated out of ids. */
type PortableItem = {
  role: SpecialItemInput['role']
  /** The product's CODE — the only identity that survives crossing databases. */
  productCode: string | null
  /** The department's NAME, for the same reason. */
  departmentName: string | null
  qty: number
  priceIncl: number
}

/**
 * The stores this special could be pushed to.
 *
 * Routed through `linkedStores`, which storeGroups declares to be THE
 * multi-branch boundary — it checks the entitlement, the group membership and
 * whether each site has a database at all. A feature that assembled its own
 * member list would be a second answer to who is in the group.
 */
export async function fanoutTargets(
  siteId: number,
): Promise<{ siteId: number; name: string }[]> {
  const stores = await linkedStores(siteId)
  return stores
    .filter((s) => s.siteId !== siteId)
    .map((s) => ({ siteId: s.siteId, name: s.displayName || s.siteCode }))
}

/** The source special's items, with every id turned into something portable. */
async function portableItems(siteId: number, special: SpecialWithUse): Promise<PortableItem[]> {
  const productIds = special.items
    .map((i) => i.productId)
    .filter((v): v is number => v !== null)
  const departmentIds = special.items
    .map((i) => i.departmentId)
    .filter((v): v is number => v !== null)

  const codes = new Map<number, string>()
  if (productIds.length > 0) {
    const rows = await siteQuery<Row>(
      siteId,
      `SELECT id, code FROM products WHERE id IN (${productIds.map(() => '?').join(',')})`,
      productIds,
    )
    for (const r of rows) codes.set(Number(r.id), String(r.code))
  }

  const names = new Map<number, string>()
  if (departmentIds.length > 0) {
    const rows = await siteQuery<Row>(
      siteId,
      `SELECT id, name FROM departments WHERE id IN (${departmentIds.map(() => '?').join(',')})`,
      departmentIds,
    )
    for (const r of rows) names.set(Number(r.id), String(r.name))
  }

  return special.items.map((i) => ({
    role: i.role,
    productCode: i.productId === null ? null : (codes.get(i.productId) ?? null),
    departmentName: i.departmentId === null ? null : (names.get(i.departmentId) ?? null),
    qty: i.qty,
    priceIncl: i.priceIncl,
  }))
}

/** The same items, resolved against the TARGET store's own product file. */
async function resolveForTarget(
  targetSiteId: number,
  items: PortableItem[],
): Promise<{ resolved: SpecialItemInput[]; skipped: string[] }> {
  const codes = items.map((i) => i.productCode).filter((v): v is string => v !== null)
  const names = items.map((i) => i.departmentName).filter((v): v is string => v !== null)

  const productByCode = new Map<string, number>()
  if (codes.length > 0) {
    const rows = await siteQuery<Row>(
      targetSiteId,
      `SELECT id, code FROM products
        WHERE code IN (${codes.map(() => '?').join(',')}) AND is_archived = 0`,
      codes,
    )
    for (const r of rows) productByCode.set(String(r.code), Number(r.id))
  }

  const departmentByName = new Map<string, number>()
  if (names.length > 0) {
    const rows = await siteQuery<Row>(
      targetSiteId,
      `SELECT id, name FROM departments WHERE name IN (${names.map(() => '?').join(',')})`,
      names,
    )
    for (const r of rows) departmentByName.set(String(r.name), Number(r.id))
  }

  const resolved: SpecialItemInput[] = []
  const skipped: string[] = []

  for (const item of items) {
    if (item.productCode !== null) {
      const id = productByCode.get(item.productCode)
      if (id === undefined) {
        // Reported, not dropped. See the file header.
        skipped.push(item.productCode)
        continue
      }
      resolved.push({
        role: item.role,
        productId: id,
        departmentId: null,
        qty: item.qty,
        priceIncl: item.priceIncl,
      })
      continue
    }
    if (item.departmentName !== null) {
      const id = departmentByName.get(item.departmentName)
      if (id === undefined) {
        skipped.push(item.departmentName)
        continue
      }
      resolved.push({
        role: item.role,
        productId: null,
        departmentId: id,
        qty: item.qty,
        priceIncl: item.priceIncl,
      })
    }
  }

  return { resolved, skipped }
}

/**
 * Push one special to the chosen stores.
 *
 * ── ONE STORE FAILING MUST NOT STOP THE REST ─────────────────────────────
 *
 * Each target is written on its own and its outcome collected. No transaction
 * spans two databases, so there is no version of this that is all-or-nothing —
 * and a branch whose database is asleep must not stop the other nineteen
 * getting the promotion. The caller shows what happened per store.
 *
 * ── AND A COPY IS MATCHED BY NAME ────────────────────────────────────────
 *
 * Pushing the same promotion twice UPDATES the copy rather than making a second
 * one. The name plus the origin site is the identity, since the id cannot
 * cross. Fixing a typo and pushing again is the ordinary way this gets used,
 * and it must not leave every branch with two nearly identical promotions.
 */
export async function fanoutSpecial(
  originSiteId: number,
  special: SpecialWithUse,
  targetSiteIds: number[],
  updatedBy: string,
): Promise<FanoutOutcome[]> {
  const allowed = await fanoutTargets(originSiteId)
  const byId = new Map(allowed.map((t) => [t.siteId, t.name]))
  const items = await portableItems(originSiteId, special)

  const outcomes: FanoutOutcome[] = []

  for (const targetSiteId of targetSiteIds) {
    const storeName = byId.get(targetSiteId)
    if (storeName === undefined) {
      // Not in the group, or not entitled. Refused here as well as in the
      // action, because this is the function that does the travelling.
      continue
    }

    try {
      const { resolved, skipped } = await resolveForTarget(targetSiteId, items)

      // The copy this store already has of this promotion, if any.
      const existing = (await listSpecials(targetSiteId)).find(
        (s) => s.name === special.name && s.originSiteId === originSiteId,
      )

      const input: SpecialInput = {
        id: existing?.id ?? null,
        name: special.name,
        shape: special.shape,
        isActive: special.isActive,
        startsAt: special.startsAt,
        endsAt: special.endsAt,
        dailyStart: special.dailyStart,
        dailyEnd: special.dailyEnd,
        daysOfWeek: special.daysOfWeek,
        discountPct: special.discountPct,
        triggerQty: special.triggerQty,
        bundlePriceIncl: special.bundlePriceIncl,
        spendAmountIncl: special.spendAmountIncl,
        guards: special.guards ? { ...special.guards } : undefined,
        /*
         * The redemption CAP travels; the count does not.
         *
         * "First 100 customers" set at head office means 100 at each branch,
         * because each branch keeps its own counter in its own database and
         * there is no way to share one across twenty of them. Worth knowing
         * when setting the number.
         */
        maxRedemptions: special.maxRedemptions,
        audience: special.audience,
        /*
         * The customer GROUP does not travel.
         *
         * Group ids are per-database like every other id, and a group named
         * "Trade" at head office may not exist at a branch at all. Rather than
         * match on a name and risk aiming a promotion at the wrong people, a
         * group-targeted special arrives targeted at everyone in that store,
         * and the branch narrows it if it wants to.
         */
        audienceGroupId: null,
        runsInStore: special.runsInStore,
        runsOnline: special.runsOnline,
        pointsMultiplier: special.pointsMultiplier,
        rewardPerDeal: special.rewardPerDeal,
        items: resolved,
        tiers: special.tiers.map((t) => ({ ...t })),
      }

      const saved = await saveSpecial(targetSiteId, input, updatedBy, originSiteId)
      outcomes.push({
        siteId: targetSiteId,
        storeName,
        ok: saved.ok,
        detail: saved.ok ? (existing ? 'updated' : 'created') : saved.error,
        skipped,
      })
    } catch (error) {
      outcomes.push({
        siteId: targetSiteId,
        storeName,
        ok: false,
        // A store whose database is unreachable is a fact worth showing, not an
        // exception that takes the other nineteen down with it.
        detail: error instanceof Error ? error.message : 'That store could not be reached',
        skipped: [],
      })
    }
  }

  return outcomes
}

/**
 * A special aimed at ONE customer group cannot be pushed as-is.
 *
 * Told to the person before they press the button rather than discovered in the
 * outcomes afterwards — see the note on `audienceGroupId` above.
 */
export function fanoutCaveat(special: SpecialWithUse): string | null {
  if (special.audience === 'group') {
    return 'This promotion is aimed at one customer group. Customer groups are per store, so the copies will apply to everyone until each branch narrows them.'
  }
  if (special.maxRedemptions !== null) {
    return `Each store keeps its own count, so a limit of ${special.maxRedemptions} means ${special.maxRedemptions} at every store rather than ${special.maxRedemptions} across the group.`
  }
  return null
}
