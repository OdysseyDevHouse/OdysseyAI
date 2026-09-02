'use client'

import { KV } from './db'
import { kvGet, kvPut, posStore } from './store'
import { seedSequence } from './saleNumber'
import { deviceId } from '../deviceId'
import { parseVariableBarcode } from '../barcodes'
import { parseGs1, gtinCandidates, lotCaptureFor } from '../gs1'
import type { TillProduct } from '../site/tillSearch'
import type { PendingSchedule } from '../priceSchedules'
import type { PosMenu } from '../posMenuEngine'
/* Type-only, and therefore erased at compile time — `instructions.ts` is
   `server-only` and none of it reaches the browser bundle. The same trick as
   `OfflineOperator` below, and for the same reason: one definition of the shape
   the two halves exchange, rather than two that can drift. */
import type { TillInstructionGroup } from '../site/instructions'
/* Type-only for the same reason, and the same trick: `productVariants.ts` is
   `server-only`, and erasing the import at compile time keeps it out of the
   browser bundle while both halves share one definition of the shape. */
import type { VariantAxis } from '../site/productVariants'

/**
 * Pulling the shop down onto the till, and keeping it current.
 *
 * ── FULL FIRST, DELTA AFTERWARDS ──────────────────────────────────────────
 *
 * The first load replaces everything. After that the stored cursor asks for only
 * what has moved, which on a normal day is a handful of rows rather than 12 MB.
 *
 * Three rules make that safe, and each exists because the naive version is wrong:
 *
 *   · The cursor comes from the SERVER's clock, never this machine's. A till ten
 *     minutes fast would skip ten minutes of price changes forever, and nothing
 *     would ever reveal it.
 *   · A schema change or a different site forces a FULL load. Patching rows into a
 *     catalog of a different shape is how a till ends up with half a product file.
 *   · `reloadProducts` from the server overrides everything. A repricing run does
 *     not touch `products.updated_at`, so the endpoint watches `product_prices`
 *     separately and says "reload" — which fails safe, at the cost of one full load.
 *
 * ── WHY THE CATALOG IS A CACHE AND THE OUTBOX IS NOT ──────────────────────
 *
 * Everything written here is disposable: losing it costs a refresh. That is the
 * opposite of the outbox, where a lost row is a sale that happened and can never be
 * reconstructed. They share a database for convenience, never a policy — nothing in
 * this file may delete an outbox row.
 */

/**
 * Bumped when the STORED shape changes. Must match the route's CATALOG_SCHEMA.
 *
 * 3 added the pending price changes. 4 added the instruction library — the
 * questions the till asks when an item is sold, which live in their own tables
 * and so cannot arrive by patching product rows.
 *
 * Bump only one of the two and this till asks for a delta the route will not
 * give it — so it full-loads on every poll, forever, with nothing on screen to
 * say why.
 *
 * 5 added the alias barcodes (143) — TillProduct.barcodes rides the feed and
 * the Dexie multiEntry index makes an alias scan work offline.
 *
 * 6 added the rotating menus (231) and `posSortOrder` on every product row.
 * A till on 5 has neither, so it draws one all-day grid in alphabetical order
 * — which is what it drew before the feature existed, and says nothing about
 * why the lunch menu never arrives.
 *
 * 7 added the tile pictures — `imageIcon` on a product, `posImageId` on a
 * department. A till on 6 stores neither, so it goes on drawing the generic
 * glyphs on a shop that has uploaded a picture for every department. A delta
 * cannot fix it: products would gain their icon one at a time as each happened
 * to be edited, leaving a grid half in pictures and half in glyphs.
 *
 * 8 added the variant GROUPS (070). The feed now sends a parent INSTEAD of its
 * children, plus the axis labels in their own map. A till on 7 holds the
 * children as loose tiles, which is what it drew before the feature and is not
 * wrong — only flat. The reason this is a bump rather than a delta is that a
 * till must never hold BOTH: patching parents in beside children a till
 * already has would draw one shirt six times, and no later delta would ever
 * remove the extras.
 */
const SCHEMA = 8

export type CatalogMeta = {
  /** What to send as `?since=`. The server's clock. */
  cursor: string | null
  fullLoadedAt: string | null
  lastSyncAt: string | null
  productCount: number
  schema: number
  siteId: number
}

export type CatalogSettings = Record<string, string | null>

/*
 * Re-exported rather than redeclared.
 *
 * A second copy of this shape here would be a second thing to keep in step with the
 * endpoint, and the field it would most easily lose is `saltB64` — without which the
 * till can derive nothing and every offline PIN silently fails. `offlineOperators.ts`
 * is `server-only`, but a TYPE import is erased at compile time, so this costs the
 * client bundle nothing.
 */
import type { OfflineOperator } from '../site/offlineOperators'
export type { OfflineOperator }

type CatalogResponse = {
  schema: number
  serverTime: string
  delta: boolean
  reloadProducts: boolean
  /**
   * How many products a full load would hold, per the server.
   * Optional: a server older than this check sends nothing, and the till then
   * behaves exactly as it did before — see the audit in refreshCatalog.
   */
  productTotal?: number
  products: TillProduct[]
  deletedIds: number[]
  departments: {
    id: number
    parentId: number | null
    name: string
    sortOrder: number
    /** The till picture, as an id. Absent on a response from a schema-6 server. */
    posImageId?: number | null
  }[]
  tenders: unknown[]
  specials: unknown[]
  /** Optional: a server on schema 2 does not send it. See the default at the store. */
  pendingPrices?: PendingSchedule[]
  /** Optional for the same reason: a server on schema 5 sends no menus. */
  posMenus?: PosMenu[]
  settings: CatalogSettings
  priceStructureId: number | null
  terminal: { id: number; code: string; tillNumber: string | null } | null
  sequence: {
    terminalId: number
    prefix: string
    storeNumber: string
    tillNumber: string
    padding: number
    periodKey: string | null
    serverNextNumber: number
  } | null
  /** The credit-note sequence, for a return taken offline. Same shape. */
  creditSequence: {
    terminalId: number
    prefix: string
    storeNumber: string
    tillNumber: string
    padding: number
    periodKey: string | null
    serverNextNumber: number
  } | null
  operators: OfflineOperator[]
  quickKeys: unknown[]
  quickKeyProductNames: Record<number, string>
  quickKeyDepartmentNames: Record<number, string>
  /**
   * The questions the till may ask, and which ones each product starts on.
   *
   * Optional: a server on schema 3 does not send them, and an unmigrated site
   * sends empty ones. Both mean the same thing to the till — no questions — so
   * the default at the store covers both without a special case.
   */
  instructionGroups?: TillInstructionGroup[]
  productInstructionGroups?: Record<number, number[]>
  /**
   * What each variant group's axes are called, keyed by parent id (070).
   *
   * Optional for the same reason as the instruction library above: a server on
   * schema 7 sends none, and a site that has not run 070 sends an empty map.
   * Both mean "no groups" to the till, which is the flat grid — so the default
   * at the store covers both without a special case.
   */
  variantAxes?: Record<number, VariantAxis[]>
}

export type CatalogResult =
  | {
      ok: true
      full: boolean
      products: number
      canSellOffline: boolean
      /** Whether this till also holds a credit-note sequence — see refreshCatalog. */
      canReturnOffline: boolean
    }
  | { ok: false; error: string; status: number }

/**
 * Fetches and stores the catalog.
 *
 * Returns rather than throws, because every caller's response to a failure is the
 * same: keep trading on what is already stored and say when it was last refreshed.
 * A till that cannot reach the server is the normal case here, not an error.
 */
/**
 * @param forceFull Skip the delta and ask for everything. Set only by the
 *   audit at the foot of this function, which is why it is not exported: a
 *   caller reaching for it would be papering over the same bug by hand.
 */
export async function refreshCatalog(
  siteId: number,
  forceFull = false,
): Promise<CatalogResult> {
  const meta = await kvGet<CatalogMeta>(siteId, KV.catalogMeta)

  /* A stored catalog from a different site or an older shape cannot be patched.
     Cheaper to notice here than to serve a cashier a half-migrated product file. */
  const canDelta =
    !forceFull && meta?.cursor != null && meta.schema === SCHEMA && meta.siteId === siteId

  /*
   * `deviceId` is REQUIRED, not decorative.
   *
   * The server has no other way to know which till this machine is — the claim lives
   * in this browser's own localStorage. Without it the response carries no sequence
   * and no operator verifiers, so the till gets 40,000 products it can neither number
   * a sale from nor sign anybody in against. Which looks like a working catalog right
   * up to the moment the line drops.
   */
  const params = new URLSearchParams({ schema: String(SCHEMA) })
  // Absent only before the browser has minted one, which the caller retries past.
  const device = deviceId()
  if (device) params.set('deviceId', device)
  if (canDelta) params.set('since', meta!.cursor!)
  const url = `/api/pos/catalog?${params}`

  let response: Response
  try {
    response = await fetch(url, { headers: { accept: 'application/json' } })
  } catch {
    return { ok: false, error: 'No connection.', status: 0 }
  }

  if (!response.ok) {
    /* 401 is its own thing and the caller must be able to tell: the fix is
       /pos-unlock, not a retry. proxy.ts answers /api/* with JSON precisely so this
       does not arrive as the login page's HTML and die in the parse below. */
    return {
      ok: false,
      error: response.status === 401 ? 'This till needs to sign in again.' : `Server error ${response.status}.`,
      status: response.status,
    }
  }

  let body: CatalogResponse
  try {
    body = await response.json()
  } catch {
    return { ok: false, error: 'The server sent something that was not a catalog.', status: 200 }
  }

  const store = posStore(siteId)
  // The server's own verdict wins over our delta request: see reloadProducts.
  const full = !body.delta || body.reloadProducts || body.schema !== SCHEMA

  await posStore(siteId).applyCatalog({
    full,
    products: body.products,
    deletedIds: body.deletedIds,
    /* Everything below is read whole on every load and never queried by field, so
       it rides in `kv` as single documents — an indexed table would buy nothing and
       cost a migration each time one of these shapes changed. */
    kv: [
      { key: KV.departments, value: body.departments },
      { key: KV.tenders, value: body.tenders },
      { key: KV.specials, value: body.specials },
      /* Defaulted rather than assumed: a till that just upgraded from schema 2
         has no such field in the response it is replacing, and storing
         `undefined` would leave the resolver with nothing to iterate. */
      { key: KV.pendingPrices, value: body.pendingPrices ?? [] },
      /* Defaulted for the same reason: a till talking to a server on schema 5
         gets no menus, and an empty list is exactly right — it means "show the
         whole grid", which is what that till did before menus existed. */
      { key: KV.posMenus, value: body.posMenus ?? [] },
      { key: KV.settings, value: body.settings },
      { key: KV.operators, value: body.operators },
      { key: KV.terminal, value: body.terminal },
      { key: KV.quickKeys, value: body.quickKeys ?? [] },
      {
        key: KV.quickKeyNames,
        value: {
          products: body.quickKeyProductNames ?? {},
          departments: body.quickKeyDepartmentNames ?? {},
        },
      },
      /* Written on EVERY response, delta or not, because the server sends them
         whole every time — an option's price can change without anything on the
         product moving, so there is no cursor that would catch it. Defaulted for
         the same reason as the pending prices above. */
      { key: KV.instructionGroups, value: body.instructionGroups ?? [] },
      { key: KV.productInstructions, value: body.productInstructionGroups ?? {} },
      /* Empty map on a schema-7 server or an unmigrated site — see the type.
         The picker then captions its rows generically, which is the right
         behaviour for a shop that has no groups anyway. */
      { key: KV.variantAxes, value: body.variantAxes ?? {} },
    ],
  })

  const productCount = await posStore(siteId).productCount()
  const now = new Date().toISOString()

  await kvPut(siteId, KV.catalogMeta, {
    cursor: body.serverTime,
    fullLoadedAt: full ? now : (meta?.fullLoadedAt ?? now),
    lastSyncAt: now,
    productCount,
    schema: SCHEMA,
    siteId,
  } satisfies CatalogMeta)

  /* The sequence is what decides whether this till can trade offline AT ALL — the
     products are useless without a number to put on the slip. Null means the store
     numbers site-wide, or this machine has not claimed a till. */
  if (body.sequence) {
    await seedSequence(siteId, body.sequence)
  }
  /* The credit-note sequence, separately and independently: a till may be able to sell
     offline but not take a return, if it was registered before migration 079 created its
     CRN row. Seeding what we have is better than refusing both. */
  if (body.creditSequence) {
    await seedSequence(siteId, body.creditSequence, 'return')
  }


  /*
   * ── A TILL THAT ONCE GOT A SHORT ANSWER MUST NOT KEEP IT FOREVER ────────
   *
   * Everything above trusts the first full load and never revisits it. A delta
   * carries only what has MOVED, so rows missing from that first answer predate
   * every cursor that follows and are never sent again: the gap is permanent,
   * and nothing in the till reports it.
   *
   * Not hypothetical. A till was found holding 2 products against a shop of 60,
   * with its department tiles reading correctly throughout — those are counted
   * on the SERVER while the grid is drawn from here, so the two disagreed in
   * silence. `canSellOffline` asks only for more than zero, so it also believed
   * it was ready to trade offline on those 2.
   *
   * The server's own total settles it. Disagreement means this cache is wrong by
   * definition, and the only honest repair is to take the lot again.
   *
   * ONCE, never in a loop: the retry sets `forceFull`, which suppresses this
   * check on the way back. A server whose count can never be reconciled — a
   * predicate drifting from tillCatalogTotal, say — then costs one extra request
   * per sync rather than an unbounded chain of them.
   */
  if (
    !full &&
    !forceFull &&
    typeof body.productTotal === 'number' &&
    productCount !== body.productTotal
  ) {
    return refreshCatalog(siteId, true)
  }
  return {
    ok: true,
    full,
    products: productCount,
    canSellOffline: body.sequence !== null,
    canReturnOffline: body.creditSequence !== null,
  }
}

/* ── Reading what is stored ──────────────────────────────────────────────── */

export async function catalogMeta(siteId: number): Promise<CatalogMeta | null> {
  return kvGet<CatalogMeta>(siteId, KV.catalogMeta)
}

/**
 * How stale the catalog is, in hours, or null if it has never loaded.
 *
 * Surfaced prominently past a few hours: a till selling from yesterday's prices is
 * not obviously broken, which is exactly what makes it worth saying out loud.
 */
export function catalogAgeHours(meta: CatalogMeta | null): number | null {
  if (!meta?.lastSyncAt) return null
  return (Date.now() - Date.parse(meta.lastSyncAt)) / 3_600_000
}

/**
 * A barcode or code, resolved against the stored catalog.
 *
 * Barcode first, then code — the same order the server's `scanAction` uses, because
 * a scanner sends a barcode and that path must feel instant.
 *
 * Then the SCALE-BARCODE fallback, mirroring resolveScan(): prefix + PLU +
 * embedded value + check digit, read with the same parseVariableBarcode the
 * server uses (extracted from tillSearch for exactly this call) and the same
 * settings the catalog feed ships. This was the missing half of that
 * extraction — without it a weighed item scanned offline simply beeped, and
 * in a grocer that is most of the shop.
 */
export async function findByCode(siteId: number, code: string): Promise<TillProduct | null> {
  const term = code.trim()
  if (!term) return null
  const store = posStore(siteId)

  /*
   * A GS1 element string, carrying the LOT (234). Mirrors resolveScan's branch
   * exactly, and is tried first for the same reason: such a code never matches
   * a stored barcode as it stands, so without this it beeps as unknown.
   *
   * The same `parseGs1` and `lotCaptureFor` the server runs, against the same
   * settings the catalog feed ships — so a pack scanned during an outage is
   * read identically to one scanned a minute earlier online.
   */
  const gs1 = parseGs1(term)
  if (gs1?.gtin) {
    const settingsForGs1 = await storedSettings(siteId)
    for (const candidate of gtinCandidates(gs1.gtin)) {
      const hit =
        (await store.productByBarcode(candidate)) ??
        (await store.productByCode(candidate)) ??
        (await store.productByAlias(candidate)) ??
        null
      if (!hit) continue
      const capture = lotCaptureFor(settingsForGs1 as Record<string, string | null>)
      return {
        ...hit,
        ...(capture.mode === 'barcode' && gs1.batchNo ? { scannedBatchNo: gs1.batchNo } : {}),
        ...(capture.mode === 'barcode' && gs1.expiryDate
          ? { scannedExpiry: gs1.expiryDate }
          : {}),
        ...(gs1.weight && hit.variableType !== 'price' ? { scannedQty: gs1.weight } : {}),
      }
    }
  }
  const exact =
    (await store.productByBarcode(term)) ??
    (await store.productByCode(term)) ??
    // The alias barcodes (143) — the multiEntry index version 4 added.
    (await store.productByAlias(term)) ??
    null
  if (exact) return exact

  const settings = await storedSettings(siteId)
  const variable = parseVariableBarcode(term, {
    prefix: String(settings.barcode_variable_prefix ?? ''),
    pluLength: Number(settings.barcode_plu_length),
    divisor: Number(settings.barcode_value_divisor),
  })
  if (!variable) return null

  const byPlu =
    (await store.productByCode(variable.plu)) ??
    (await store.productByBarcode(variable.plu)) ??
    (await store.productByAlias(variable.plu)) ??
    null
  if (!byPlu) return null

  // The embedded value is a weight or money, never both — resolveScan's rule,
  // decided by the product's variableType. A stored row from before the field
  // shipped treats it as weight, the scale-label default.
  return byPlu.variableType === 'price'
    ? { ...byPlu, scannedPrice: variable.value }
    : { ...byPlu, scannedQty: variable.value }
}

/**
 * Products matching a typed term, from the stored catalog.
 *
 * A prefix match on code plus a substring match on description, capped — the same
 * two things the server's search does. Dexie cannot do a case-insensitive substring
 * on an index, so the description pass is a filtered scan; at 40,000 rows that is
 * tens of milliseconds, measured, and only runs when a cashier is typing.
 */
export async function searchOffline(
  siteId: number,
  term: string,
  limit = 60,
): Promise<TillProduct[]> {
  const needle = term.trim().toLowerCase()
  if (needle.length < 2) return []
  const store = posStore(siteId)

  const byCode = await store.productsByCodePrefix(needle, limit)
  if (byCode.length >= limit) return byCode

  const seen = new Set(byCode.map((p) => p.id))
  const byName = await store.productsByDescription(needle, limit - byCode.length, seen)

  return [...byCode, ...byName]
}

/**
 * One department and everything filed beneath it.
 *
 * The mirror of `browseForTill`'s recursive CTE (tillSearch.ts). That function's
 * comment warns that walking the tree in JS risks "a second definition of what
 * 'beneath' means" — so this is written to be the SAME definition rather than a
 * near one: every descendant, at any depth, including the department itself.
 *
 * Walking it here is not the second round trip that comment was weighing, because
 * the till already holds the whole department list — `refreshCatalog` stores it,
 * parent ids and all. The tree is a few dozen rows and the walk is microseconds;
 * the alternative is asking a server for something already on the device.
 *
 * ⚠ A cycle would hang the till, and a department file is only as trustworthy as
 * whatever wrote it. `seen` makes a bad row a wrong grid rather than a locked-up
 * counter — the till must not be the thing that discovers the loop.
 *
 * Falls back to the department alone when the list has not synced yet. That is
 * the pre-existing behaviour, and it is the honest one: showing what is filed
 * directly in the department beats showing nothing.
 */
async function departmentSubtree(siteId: number, departmentId: number): Promise<number[]> {
  const departments = await storedDepartments(siteId)
  if (departments.length === 0) return [departmentId]

  const childrenOf = new Map<number, number[]>()
  for (const d of departments) {
    if (d.parentId === null || d.parentId === undefined) continue
    const kids = childrenOf.get(d.parentId)
    if (kids) kids.push(d.id)
    else childrenOf.set(d.parentId, [d.id])
  }

  const seen = new Set<number>([departmentId])
  const queue = [departmentId]
  while (queue.length > 0) {
    const next = queue.pop()!
    for (const child of childrenOf.get(next) ?? []) {
      if (seen.has(child)) continue
      seen.add(child)
      queue.push(child)
    }
  }
  return [...seen]
}

/**
 * Products filed in one department, for the tile grid.
 *
 * ── SORTED HERE, BECAUSE DEXIE CANNOT ────────────────────────────────────
 *
 * The online grid orders by menu position then description (tillSearch.ts's
 * `menuOrder`), and this must match it exactly — a till that reordered its
 * tiles the moment it lost the network would move the button a cashier
 * reaches for by muscle memory, which is how the wrong thing gets sold.
 *
 * A Dexie compound index cannot express it: the rule is "positioned rows
 * ascending, THEN unpositioned rows alphabetically", and 0 sorting last is
 * not something an index can say (see 121). So the sort happens in JS, over
 * one department's worth of rows rather than the whole file.
 *
 * ⚠ The limit is applied AFTER sorting, deliberately. Taking 200 rows in
 * Dexie's own order and then sorting them would give a stable-looking grid
 * built from an arbitrary 200 of the department's 400 products — and the
 * tiles the shop dragged to the front could be the ones cut.
 */
export async function browseOffline(
  siteId: number,
  departmentId: number,
  limit = 200,
): Promise<TillProduct[]> {
  const scope = await departmentSubtree(siteId, departmentId)
  const rows = await posStore(siteId).productsByDepartments(scope)
  /* Members of a variant group are held but not drawn — the group's own tile
     stands for them, and the picker behind it is where they appear. Filtered
     BEFORE the limit so a department of shirts is not cut to 200 rows that are
     mostly sizes of the same three garments. */
  const tiles = rows.filter((p) => p.parentId === null || p.parentId === undefined)
  tiles.sort(menuOrder)
  return tiles.slice(0, limit)
}

/**
 * The members of one variant group, for the picker (070).
 *
 * Runs at the moment a cashier taps a group tile, so it reads the `parentId`
 * index rather than scanning: on a 40,000-row file the difference is the pause
 * between a tap and a picker appearing, with somebody waiting at the counter.
 *
 * Archived members never reach the till at all — `browseForTill` excludes them
 * — so there is nothing to filter here. `visible_in_pos` is likewise already
 * applied, which is what makes hiding one size thin the picker rather than
 * needing a second rule on this side.
 *
 * Sorted by the shop's own `variant_sort` and NOT by `menuOrder`: sizes are not
 * alphabetical, and S/M/L/XL sorting to L/M/S/XL is the exact nonsense that
 * column exists to prevent (see 070). Ties fall back to the axis values so the
 * order is at least stable on a group nobody has ordered.
 */
export async function variantChildren(
  siteId: number,
  parentId: number,
): Promise<TillProduct[]> {
  const rows = await posStore(siteId)
    .productsByParent(parentId)
    .catch(() => [] as TillProduct[])
  return rows.sort(variantOrder)
}

/**
 * The picker's order: the shop's own `variant_sort`, then the axis values.
 *
 * ⚠ Must match `getGroup`'s ORDER BY in lib/site/productVariants.ts, which is
 * what the back office shows. A picker that ordered its sizes differently from
 * the screen where they were arranged would make the arranging look broken.
 *
 * Note 0 sorts FIRST here, unlike `menuOrder` above — the two look alike and
 * mean opposite things. There, 0 is "never placed" and goes after everything a
 * shop positioned deliberately. Here it is the ordinary state: `attachChild`
 * leaves the column at its default until somebody drags the sizes into order,
 * so a whole group sits at 0 and falls through to the axis tiebreak. Pushing 0
 * last would reverse an unordered group for no reason and, worse, single out
 * the one member that had been dragged to the front.
 */
function variantOrder(a: TillProduct, b: TillProduct): number {
  return (
    a.variantSort - b.variantSort ||
    a.axis1Value.localeCompare(b.axis1Value) ||
    a.axis2Value.localeCompare(b.axis2Value)
  )
}

/**
 * The one sort rule for a till's browse grid, matching `menuOrder` in
 * lib/site/tillSearch.ts and `productOrder` in lib/site/menuDesigner.ts.
 *
 * Three definitions of one rule is two too many, but they sit in three
 * different runtimes — SQL, the browser's Dexie store, and the designer's
 * server read — and none can import from another. Changing one means
 * changing all three.
 */
function menuOrder(a: TillProduct, b: TillProduct): number {
  const ap = a.posSortOrder ?? 0
  const bp = b.posSortOrder ?? 0
  // 0 is "never placed" and goes after everything positioned.
  if (ap !== bp) {
    if (ap === 0) return 1
    if (bp === 0) return -1
    return ap - bp
  }
  return a.description.localeCompare(b.description)
}

export async function storedDepartments(siteId: number) {
  return (await kvGet<CatalogResponse['departments']>(siteId, KV.departments)) ?? []
}

export async function storedSettings(siteId: number): Promise<CatalogSettings> {
  return (await kvGet<CatalogSettings>(siteId, KV.settings)) ?? {}
}

export async function storedOperators(siteId: number): Promise<OfflineOperator[]> {
  return (await kvGet<OfflineOperator[]>(siteId, KV.operators)) ?? []
}

/**
 * The price changes this till is carrying, moments still unevaluated.
 *
 * Read from storage rather than from the page's props for the same reason the
 * quick keys are: the props are right on a fresh load and gone after a reload
 * with no network. A till that reloads at five to six and then loses its line
 * must still change its prices at six.
 *
 * Empty is the normal case, and the resolver treats it as "charge what the
 * catalogue says" — which is exactly right.
 */
export async function storedPendingPrices(siteId: number): Promise<PendingSchedule[]> {
  return (await kvGet<PendingSchedule[]>(siteId, KV.pendingPrices)) ?? []
}

/**
 * What this till's variant groups call their axes, keyed by parent id (070).
 *
 * Read from storage rather than the page's props for the reason every reader
 * here is: the props are right on a fresh load and gone after a reload with no
 * network, and a picker that lost its captions mid-shift would ask a cashier
 * to choose between 'S' and 'M' without saying what that means.
 *
 * Empty is the ordinary case — most shops have no groups — and the picker
 * falls back to generic captions rather than refusing to open.
 */
export async function storedVariantAxes(
  siteId: number,
): Promise<Record<number, VariantAxis[]>> {
  return (await kvGet<Record<number, VariantAxis[]>>(siteId, KV.variantAxes)) ?? {}
}

/**
 * The rotating menus this till is carrying, windows still unevaluated.
 *
 * Read from storage rather than from the page's props for the same reason the
 * pending prices are: the props are right on a fresh load and gone after a
 * reload with no network. A café that reloads a till at five to eleven must
 * still get its lunch menu at eleven.
 *
 * Empty is the ordinary case and means "show the whole grid" — see
 * `productsOnMenu` for why an empty grid is the wrong answer to "no menu".
 */
export async function storedPosMenus(siteId: number): Promise<PosMenu[]> {
  return (await kvGet<PosMenu[]>(siteId, KV.posMenus)) ?? []
}

/**
 * The questions this till can ask, and which ones each product starts on.
 *
 * Returned as a map keyed by group id as well as the raw list, because every
 * caller wants to look one up: a product names the ids it asks, and an answer
 * names the ids it goes on to ask. Building that map once here saves every
 * screen doing a linear scan per question.
 */
export async function storedInstructions(siteId: number): Promise<{
  groups: TillInstructionGroup[]
  byId: Map<number, TillInstructionGroup>
  byProduct: Record<number, number[]>
}> {
  const [groups, byProduct] = await Promise.all([
    kvGet<TillInstructionGroup[]>(siteId, KV.instructionGroups),
    kvGet<Record<number, number[]>>(siteId, KV.productInstructions),
  ])
  const list = groups ?? []
  return {
    groups: list,
    byId: new Map(list.map((g) => [g.id, g])),
    byProduct: byProduct ?? {},
  }
}

/**
 * Takes stock off the shelf locally, so a second sale of the last unit shows 0.
 *
 * Optimistic and deliberately unreconciled: the next catalog refresh overwrites it
 * with the server's figure. Overselling is already permitted everywhere in this app
 * — `canSellNow` always returns ok and stock is allowed to go negative — so this is
 * about what the CASHIER SEES, not about refusing anything.
 */
export async function decrementStock(
  siteId: number,
  lines: readonly { productId: number | null; qty: number }[],
): Promise<void> {
  /* Deltas, not totals: the store reads and writes each row inside one
     transaction, so a sale landing mid-flight cannot be lost between our
     read and our write. Lines with no product are dropped here rather than
     in the store, which has no idea what a sale line is. */
  await posStore(siteId).adjustStock(
    lines
      .filter((line) => line.productId != null)
      .map((line) => ({ productId: line.productId as number, qty: line.qty })),
  )
}

/**
 * The quick keys this till holds, and the names their captions fall back to.
 *
 * Read from storage rather than from the page's props when the till is offline. The
 * props are correct on a fresh load and gone after a reload with no network — and the
 * key grid is the DEFAULT pane, so losing it means opening on an empty screen at exactly
 * the moment a cashier can least afford to go hunting by department.
 *
 * Returns empty rather than throwing: a till that has never pulled a catalog has no keys,
 * which the panel already renders as "ask a manager to set these up".
 */
export async function storedQuickKeys(siteId: number): Promise<{
  keys: unknown[]
  productNames: Record<number, string>
  departmentNames: Record<number, string>
}> {
  const [keys, names] = await Promise.all([
    kvGet<unknown[]>(siteId, KV.quickKeys),
    kvGet<{ products: Record<number, string>; departments: Record<number, string> }>(
      siteId,
      KV.quickKeyNames,
    ),
  ])
  return {
    keys: keys ?? [],
    productNames: names?.products ?? {},
    departmentNames: names?.departments ?? {},
  }
}
