import { NextResponse, type NextRequest } from 'next/server'
import { siteIdForCapability } from '@/lib/auth'
import { browseForTill } from '@/lib/site/tillSearch'
import { listDepartments } from '@/lib/site/departments'
import { listTenderTypes } from '@/lib/site/tenderTypes'
import { liveSpecials } from '@/lib/site/specials'
import { listPriceStructures } from '@/lib/site/lookups'
import { getSettings } from '@/lib/site/settings'
import { terminalForDevice } from '@/lib/site/terminals'
import { getSequence } from '@/lib/site/sequences'
import { numberingConfig, tillNumber } from '@/lib/site/numbering'
import { operatorsForDevice } from '@/lib/site/offlineOperators'
import { listQuickKeys } from '@/lib/site/quickKeys'
import { siteQuery } from '@/lib/siteDb'

export const dynamic = 'force-dynamic'

/**
 * Everything a till needs to trade with no network.
 *
 * ── AN API ROUTE, NOT A SERVER ACTION ─────────────────────────────────────
 *
 * The till fetches this from a background loop and has to control its own retry
 * and read its own cache headers. Server actions are a Next-internal POST protocol
 * awkward to drive that way, and `siteIdForCapability` exists (auth.ts:442) exactly
 * because API routes sit outside `(app)` and cannot lean on its layout gate.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ─────────────────────────────────────────
 *
 * CUSTOMER BALANCES AND CREDIT LIMITS. The full debtors book in browser IndexedDB
 * is a data-protection exposure with almost no offline payoff, because account
 * sales are refused offline anyway (`offlineCapability.offlineBlockedTender`). What
 * ships is enough to put a name on a slip and nothing more.
 *
 * COST PRICES beyond what `TillProduct` already carries for margin. Same reasoning:
 * a till does not need the whole product file to sell from it.
 */

/**
 * Bumped when the SHAPE changes, forcing a full reload rather than a delta.
 *
 * 2 added the quick keys. A till on 1 holds no key grid at all, and patching products
 * into it would leave it believing it was current while its default pane stayed empty.
 */
const CATALOG_SCHEMA = 2

/**
 * Ceiling on one response.
 *
 * MEASURED against a real seeded store rather than guessed:
 *
 *   40,083 products · 209ms to query · 11.56 MB raw · 0.92 MB gzipped (8%)
 *   ≈ 1.9s over 4 Mbps ADSL, 0.4s over fibre
 *
 * Product JSON is extremely repetitive — the same twenty keys forty thousand times
 * — so gzip does the heavy lifting and the payload is not the problem it looks
 * like. The IndexedDB footprint is the other half: ~12 MB of JSON plus indexes,
 * comfortably inside every browser's quota and effectively unlimited in Electron.
 *
 * 50,000 is therefore a backstop against a runaway query, not a tuning knob. A
 * store past it cannot trade fully offline, and the till should say so rather than
 * silently hold a partial shop — which is what `browseForTill`'s old 1000-row clamp
 * would have done.
 */
const PRODUCT_LIMIT = 50_000

export async function GET(req: NextRequest) {
  const siteId = await siteIdForCapability('sales.till')
  if (siteId === null) {
    return NextResponse.json({ error: 'Not allowed.' }, { status: 403 })
  }

  const url = new URL(req.url)
  const deviceId = url.searchParams.get('deviceId') ?? ''
  const since = url.searchParams.get('since')
  const schema = Number(url.searchParams.get('schema') ?? 0)

  /*
   * `serverTime` is read from the DATABASE, before anything else, and handed back
   * as the next cursor.
   *
   * Never the till's clock: a machine ten minutes fast would ask for changes
   * "since" a moment in the future and skip ten minutes of price changes forever.
   * Never `new Date()` in this process either — the app server and the database can
   * disagree, and `updated_at` is written by the database.
   */
  const [{ now }] = await siteQuery<{ now: string }>(
    siteId,
    "SELECT DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i:%s') AS now",
  )

  /*
   * A delta is only honoured when the till is on the CURRENT schema and actually
   * sent a cursor. Anything else is a full load — which is also what happens after
   * a shape change, because a till holding rows of the old shape cannot be patched
   * into the new one row by row.
   */
  const wantsDelta = Boolean(since) && schema === CATALOG_SCHEMA

  /*
   * Skew guard: ask for a minute before the cursor.
   *
   * Two rows written in the same second as the previous cursor can straddle it, and
   * re-sending a handful of products costs nothing. MISSING one is a price change
   * that never reaches the till and sells at yesterday's price until the next full
   * load — which might be tomorrow.
   *
   * ⚠ BOUND, never interpolated. `since` comes off a query string. An earlier
   * version built `${since} - INTERVAL 60 SECOND` straight into the SQL, which was
   * both an injection vector and silently WRONG — an unquoted date is arithmetic on
   * a bare token, so the delta matched nothing and the till would have believed the
   * catalog was up to date forever. Validated to a shape first, then passed as a
   * parameter, and the INTERVAL is applied by the query rather than the string.
   */
  const cutoff = wantsDelta && isTimestamp(since!) ? since! : null

  const config = await numberingConfig(siteId)
  const terminal = deviceId ? await terminalForDevice(siteId, deviceId) : null

  /* Resolved before the fan-out rather than threaded through it as a promise:
     products, and only products, are priced through it, and passing a pending
     promise into a helper made the ordering harder to read than it is. */
  const structures = await listPriceStructures(siteId)
  const priceStructure = structures.find((s) => s.isDefault) ?? structures[0] ?? null

  const [products, deletedIds, pricesChanged, departments, tenders, specials, settings, operators] =
    await Promise.all([
      productsSince(siteId, cutoff, priceStructure?.id ?? null),
    wantsDelta ? removedSince(siteId, cutoff!) : Promise.resolve<number[]>([]),
    wantsDelta ? pricesChangedSince(siteId, cutoff!) : Promise.resolve(false),
    listDepartments(siteId, true),
    listTenderTypes(siteId),
    // Sent WHOLE, windows UNevaluated — the till re-checks them against its own
    // clock, so a happy hour starting at five begins on time even on a catalog
    // fetched at ten to.
      liveSpecials(siteId),
      getSettings(siteId, [
      'sales_cash_rounding',
      'cost_basis',
      // Without these three the till cannot read a scale barcode offline, and in a
      // grocer that is most of the shop.
      'barcode_variable_prefix',
      'barcode_plu_length',
      'barcode_value_divisor',
      'sales_number_scope',
      'store_number',
    ]),
    deviceId ? operatorsForDevice(siteId, deviceId) : Promise.resolve([]),
  ])

  // This till's own invoice sequence, so it can number a sale with no server.
  const sequence =
    terminal && config.scope === 'terminal'
      ? await getSequence(siteId, 'invoice', terminal.id)
      : null
  const till = terminal ? await tillNumber(siteId, terminal.id) : null

  /* The quick keys, plus the names their captions fall back to. Only the products and
     departments actually ON a key — the product file is already in this response, but the
     till would have to search 40,000 rows to label six buttons. */
  const quickKeys = await listQuickKeys(siteId, 'main')
  const keyProductIds = [
    ...new Set(quickKeys.map((k) => k.productId).filter((id): id is number => !!id)),
  ]
  const keyDepartmentIds = new Set(
    quickKeys.map((k) => k.departmentId).filter((id): id is number => !!id),
  )
  const keyProducts = keyProductIds.length
    ? await siteQuery<{ id: number; description: string }>(
        siteId,
        `SELECT id, description FROM products WHERE id IN (${keyProductIds.map(() => '?').join(',')})`,
        keyProductIds,
      )
    : []
  const quickKeyProductNames = Object.fromEntries(keyProducts.map((p) => [p.id, p.description]))
  const quickKeyDepartmentNames = Object.fromEntries(
    departments.filter((d) => keyDepartmentIds.has(d.id)).map((d) => [d.id, d.name]),
  )

  return NextResponse.json(
    {
      schema: CATALOG_SCHEMA,
      /** The cursor to send next time. From the database's clock, not anyone else's. */
      serverTime: now,
      /** False means "replace everything you hold", true means "patch". */
      delta: wantsDelta,
      /**
       * A repricing run does NOT touch products.updated_at — the prices live in
       * their own table — so a delta would silently miss it. When any price has
       * moved, the till is told to reload the lot rather than trusting the delta.
       * Fails safe: the cost is one full load, and the alternative is selling at a
       * price the shelf edge no longer agrees with.
       */
      reloadProducts: pricesChanged,
      products,
      /** Archived or hidden since the cursor. Empty on a full load. */
      deletedIds,
      departments: departments
        .filter((d) => d.isActive)
        .map((d) => ({ id: d.id, parentId: d.parentId, name: d.name, sortOrder: d.sortOrder })),
      tenders,
      specials,
      settings,
      priceStructureId: priceStructure?.id ?? null,
      terminal: terminal
        ? { id: terminal.id, code: terminal.code, tillNumber: till }
        : null,
      /** Null when this store numbers site-wide — the till then cannot sell offline. */
      sequence:
        sequence && till
          ? {
              terminalId: sequence.terminalId,
              prefix: sequence.prefix,
              storeNumber: config.storeNumber,
              tillNumber: till,
              padding: sequence.padding,
              periodKey: sequence.resetPeriod === 'yearly' ? String(new Date().getFullYear()) : null,
              serverNextNumber: sequence.nextNumber,
            }
          : null,
      operators,
      /*
       * The shop's own till buttons, and the names their captions fall back to.
       *
       * Shipped because the key grid is the till's DEFAULT pane: an offline till that
       * reloaded without them would open on an empty grid and lose the fastest way it
       * has to sell — at exactly the moment a cashier is least able to go looking for
       * a product by department.
       *
       * Found by driving the till in a browser rather than by reading the code: the page
       * passes the keys as props, which works perfectly right up until a reload with no
       * network.
       */
      quickKeys,
      quickKeyProductNames,
      quickKeyDepartmentNames,
    },
    {
      // Never cached by anything in between. A catalog is per-site, per-device and
      // per-operator; one served from a shared cache to the wrong till would hand
      // over another shop's products and another person's verifier.
      headers: { 'Cache-Control': 'no-store, private' },
    },
  )
}

/* ── The pieces ──────────────────────────────────────────────────────────── */

/**
 * Products, whole or changed.
 *
 * Reuses `browseForTill` for the full load rather than writing a second SELECT: it
 * already returns exactly the `TillProduct` shape the till works in, priced through
 * the structure, with stock and the `askPriceAtSale` / `allowFractions` /
 * `maxDiscountPct` flags the basket rules need. A second query here is a second
 * thing to keep in step with pricing.
 */
async function productsSince(
  siteId: number,
  cutoff: string | null,
  priceStructureId: number | null,
) {
  if (!cutoff) {
    return browseForTill(siteId, { priceStructureId, limit: PRODUCT_LIMIT })
  }
  // A delta still goes through browseForTill, filtered afterwards by id: the
  // alternative is duplicating its 60-line SELECT with one extra WHERE, and the
  // duplicate is what drifts when pricing changes.
  const changed = await siteQuery<{ id: number }>(
    siteId,
    'SELECT id FROM products WHERE updated_at >= ? - INTERVAL 60 SECOND',
    [cutoff],
  )
  if (changed.length === 0) return []
  const ids = new Set(changed.map((r) => Number(r.id)))
  const all = await browseForTill(siteId, { priceStructureId, limit: PRODUCT_LIMIT })
  return all.filter((p) => ids.has(p.id))
}

/**
 * Products the till should forget: archived, no longer sold at the till, or
 * turned into a variant parent.
 *
 * The parent case is the one that MUST be here rather than only in the snapshot
 * query. browseForTill already excludes parents, so a fresh sync never caches
 * one — but a till that synced yesterday is holding the row from before it
 * became a parent, and a delta only sends what changed. Without this line that
 * till keeps a sellable copy of a product the server would refuse, and it is
 * exactly the till running offline that cannot be told otherwise.
 */
async function removedSince(siteId: number, cutoff: string): Promise<number[]> {
  const rows = await siteQuery<{ id: number }>(
    siteId,
    `SELECT id FROM products
      WHERE updated_at >= ? - INTERVAL 60 SECOND
        AND (is_archived = 1 OR visible_in_pos = 0 OR has_variants = 1)`,
    [cutoff],
  ).catch(() => [])
  return rows.map((r) => Number(r.id))
}

/**
 * Whether any PRICE has moved since the cursor.
 *
 * `product_prices` has its own `updated_at`, and changing one does not touch the
 * product row — so a repricing run is invisible to a products-only delta. Answered
 * as a boolean rather than a list because the response is the same either way:
 * reload the products.
 */
async function pricesChangedSince(siteId: number, cutoff: string): Promise<boolean> {
  const rows = await siteQuery<{ n: number }>(
    siteId,
    'SELECT COUNT(*) AS n FROM product_prices WHERE updated_at >= ? - INTERVAL 60 SECOND',
    [cutoff],
  ).catch(() => [{ n: 0 }])
  return Number(rows[0]?.n ?? 0) > 0
}

/**
 * Whether a string is a `YYYY-MM-DD HH:MM:SS` timestamp.
 *
 * The cursor is echoed back to the till and returned by it on the next call, so it
 * SHOULD always be one of ours. "Should" is not a guarantee for a query-string
 * value: anything that fails this shape falls back to a full load, which is slower
 * and always correct.
 */
function isTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
}
