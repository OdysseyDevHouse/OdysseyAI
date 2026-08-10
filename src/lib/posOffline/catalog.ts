'use client'

import { posDb, kvGet, kvPut, KV } from './db'
import { seedSequence } from './saleNumber'
import { deviceId } from '../deviceId'
import type { TillProduct } from '../site/tillSearch'
import type { PendingSchedule } from '../priceSchedules'

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
 * 3 added the pending price changes. Bump only one of the two and this till asks
 * for a delta the route will not give it — so it full-loads on every poll,
 * forever, with nothing on screen to say why.
 */
const SCHEMA = 3

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
  products: TillProduct[]
  deletedIds: number[]
  departments: { id: number; parentId: number | null; name: string; sortOrder: number }[]
  tenders: unknown[]
  specials: unknown[]
  /** Optional: a server on schema 2 does not send it. See the default at the store. */
  pendingPrices?: PendingSchedule[]
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
export async function refreshCatalog(siteId: number): Promise<CatalogResult> {
  const meta = await kvGet<CatalogMeta>(siteId, KV.catalogMeta)

  /* A stored catalog from a different site or an older shape cannot be patched.
     Cheaper to notice here than to serve a cashier a half-migrated product file. */
  const canDelta = meta?.cursor != null && meta.schema === SCHEMA && meta.siteId === siteId

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

  const db = posDb(siteId)
  // The server's own verdict wins over our delta request: see reloadProducts.
  const full = !body.delta || body.reloadProducts || body.schema !== SCHEMA

  await db.transaction('rw', db.products, db.kv, async () => {
    if (full) {
      await db.products.clear()
      await db.products.bulkPut(body.products)
    } else {
      if (body.products.length > 0) await db.products.bulkPut(body.products)
      if (body.deletedIds.length > 0) await db.products.bulkDelete(body.deletedIds)
    }

    /* Everything below is read whole on every load and never queried by field, so
       it rides in `kv` as single documents — an indexed table would buy nothing and
       cost a migration each time one of these shapes changed. */
    await db.kv.bulkPut([
      { key: KV.departments, value: body.departments },
      { key: KV.tenders, value: body.tenders },
      { key: KV.specials, value: body.specials },
      /* Defaulted rather than assumed: a till that just upgraded from schema 2
         has no such field in the response it is replacing, and storing
         `undefined` would leave the resolver with nothing to iterate. */
      { key: KV.pendingPrices, value: body.pendingPrices ?? [] },
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
    ])
  })

  const productCount = await db.products.count()
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
 */
export async function findByCode(siteId: number, code: string): Promise<TillProduct | null> {
  const term = code.trim()
  if (!term) return null
  const db = posDb(siteId)
  return (
    (await db.products.where('barcode').equals(term).first()) ??
    (await db.products.where('code').equals(term).first()) ??
    null
  )
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
  const db = posDb(siteId)

  const byCode = await db.products
    .where('code')
    .startsWithIgnoreCase(needle)
    .limit(limit)
    .toArray()
  if (byCode.length >= limit) return byCode

  const seen = new Set(byCode.map((p) => p.id))
  const byName = await db.products
    .filter((p) => !seen.has(p.id) && p.description.toLowerCase().includes(needle))
    .limit(limit - byCode.length)
    .toArray()

  return [...byCode, ...byName]
}

/** Products filed in one department, for the tile grid. */
export async function browseOffline(
  siteId: number,
  departmentId: number,
  limit = 200,
): Promise<TillProduct[]> {
  return posDb(siteId)
    .products.where('departmentId')
    .equals(departmentId)
    .limit(limit)
    .toArray()
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
  const db = posDb(siteId)
  await db.transaction('rw', db.products, async () => {
    for (const line of lines) {
      if (line.productId == null) continue
      const product = await db.products.get(line.productId)
      if (!product) continue
      await db.products.put({ ...product, stockOnHand: product.stockOnHand - line.qty })
    }
  })
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
