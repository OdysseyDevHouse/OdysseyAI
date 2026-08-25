import { NextResponse, type NextRequest } from 'next/server'
import { siteIdForCapability } from '@/lib/auth'
import { browseForTill } from '@/lib/site/tillSearch'
import { listDepartments } from '@/lib/site/departments'
import { listTenderTypes } from '@/lib/site/tenderTypes'
import { liveSpecials } from '@/lib/site/specials'
import { pendingSchedulesForTill } from '@/lib/site/priceSchedules'
import { listPriceStructures } from '@/lib/site/lookups'
import { getSettings } from '@/lib/site/settings'
import { terminalForDevice } from '@/lib/site/terminals'
import { getSequence } from '@/lib/site/sequences'
import { numberingConfig, tillNumber } from '@/lib/site/numbering'
import { operatorsForDevice } from '@/lib/site/offlineOperators'
import { listAllQuickKeys } from '@/lib/site/quickKeys'
import { livePosMenus } from '@/lib/site/posMenus'
import { readInstructionLibrary } from '@/lib/site/instructions'
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
 *
 * 3 added the pending price changes. A till on 2 carries none, so it would go on
 * charging the old price straight through a change it has no way to know about —
 * and would keep doing it until the cron caught up minutes later.
 *
 * 4 added the instruction library — the questions a till asks when an item is
 * sold. A till on 3 holds none, so it would sell a burger without ever asking
 * how it should be cooked, and no amount of patching products into it would
 * change that: the questions are not on the product rows.
 *
 * 5 added the alias barcodes (143) — TillProduct.barcodes rides the feed.
 *
 * 6 added the rotating menus (231) and, with them, `posSortOrder` on every
 * product row. A till on 5 holds neither, so it would go on drawing one
 * all-day grid in alphabetical order — which is precisely what it drew before
 * this feature, with nothing on screen to say why the breakfast menu never
 * arrives. Patching products into it cannot fix that: the menus are not on
 * the product rows.
 *
 * 7 added the tile PICTURES — `imageIcon` on every product row and `posImageId`
 * on every department. A till on 6 holds neither, so it would go on drawing the
 * generic box-and-tag glyphs on a shop that has uploaded a picture for every
 * department, with nothing on screen to say why. A delta cannot repair that for
 * departments in particular: they are sent whole rather than since a cursor, but
 * the products beside them would only gain their icon as each one happened to be
 * edited — a grid half in pictures and half in glyphs, settling over weeks.
 *
 * ⚠ MUST match `SCHEMA` in lib/posOffline/catalog.ts. The till sends its own
 * number and this route decides whether a delta is safe; bump only one and every
 * till in the shop full-loads on every poll, forever, with no error to show for it.
 */
const CATALOG_SCHEMA = 7

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

  const [
    products,
    deletedIds,
    pricesChanged,
    departments,
    tenders,
    specials,
    posMenus,
    pendingPrices,
    settings,
    operators,
    instructions,
  ] = await Promise.all([
    productsSince(siteId, cutoff, priceStructure?.id ?? null, terminal?.stockLocationId ?? null),
    wantsDelta ? removedSince(siteId, cutoff!) : Promise.resolve<number[]>([]),
    wantsDelta ? pricesChangedSince(siteId, cutoff!) : Promise.resolve(false),
    listDepartments(siteId, true),
    listTenderTypes(siteId),
    // Sent WHOLE, windows UNevaluated — the till re-checks them against its own
    // clock, so a happy hour starting at five begins on time even on a catalog
    // fetched at ten to.
      liveSpecials(siteId),
    /*
     * The rotating menus (231), sent the same way and for the same reason:
     * whole, with their day masks and hour bands UNevaluated.
     *
     * The till picks the live one against its own clock, so breakfast gives
     * way to lunch at eleven exactly — on every till in the shop at once, and
     * on a till that has been off the network since yesterday. Choosing the
     * menu here instead would smear the changeover across the fifteen-minute
     * sync interval and strand an offline till on whatever it last downloaded.
     */
      livePosMenus(siteId),
    /*
     * Scheduled price changes, sent the same way and for the same reason: the
     * till compares the moment against its OWN clock, so a six o'clock price
     * list takes effect at six on a catalogue fetched at ten to — and on a till
     * that has been off the network since yesterday.
     *
     * This is what makes the feature work without a reload. The cron writes the
     * same numbers minutes later; because a pending line carries an ABSOLUTE
     * price rather than a delta, both sides of that write resolve identically
     * and nothing moves on screen.
     */
      pendingSchedulesForTill(siteId),
      getSettings(siteId, [
      'sales_cash_rounding',
      'cost_basis',
      // Without these three the till cannot read a scale barcode offline, and in a
      // grocer that is most of the shop.
      'barcode_variable_prefix',
      'barcode_plu_length',
      'barcode_value_divisor',
      /* Which lot a batch line is booked against (234). Shipped for the same
         reason as the three above: the offline till has to make the SAME
         decision the server would, and `lotCaptureFor` is the pure function
         both of them resolve these two values with. Without them offline
         would silently drop back to FEFO mid-outage — a traceability gap in
         exactly the shops that chose not to have one. */
      'lot_capture_mode',
      'lot_capture_strict',
      'sales_number_scope',
      'store_number',
      /* NOT `pos_mode`. It is no longer a shop setting — each till carries its
         own, and this route already knows which till is asking. It is injected
         into the map below, from `terminal`, so the offline shape is unchanged
         for every consumer that reads `settings.pos_mode`. */
    ]),
    deviceId ? operatorsForDevice(siteId, deviceId) : Promise.resolve([]),
    /*
     * The questions a till asks, sent WHOLE on every response — never as a delta.
     *
     * Two reasons, and the first is a correctness one. Editing an option touches
     * `instruction_options.updated_at` and NOTHING on the product, so a delta
     * keyed off `products.updated_at` would miss it entirely: the exact blind
     * spot `pricesChangedSince` exists to cover for prices. A shop that renamed
     * "extra bacon" or changed what it costs would go on asking the old question
     * at every till until something else happened to touch the product.
     *
     * The second is that it is small. This is a MENU — a few dozen questions
     * shared across the whole product file — not a per-product structure, which
     * is why it ships as one library plus a map of ids rather than inlined into
     * 40,000 product rows. A delta mechanism for a few kilobytes would be one
     * more thing to get wrong for no measurable gain.
     */
    /* Tolerant of the tables not existing: a site that has not run 080-082 yet
       must still be able to sell, and an empty library asks no questions — which
       is exactly how that shop behaves today. */
    readInstructionLibrary(siteId).catch(() => ({ groups: [], byProduct: {} })),
  ])

  // This till's own invoice sequence, so it can number a sale with no server.
  const sequence =
    terminal && config.scope === 'terminal'
      ? await getSequence(siteId, 'invoice', terminal.id)
      : null
  /*
   * And its CREDIT-NOTE sequence, so it can number a RETURN with no server.
   *
   * A separate row rather than sharing the invoice counter: a credit note that consumed
   * an invoice number would put a gap in the invoice register that nothing explains, and
   * `verifySequence` would report it as a missing sale. Migration 079 creates one of
   * these per numbered terminal.
   *
   * Null is a legitimate answer — a till registered before 079, or a store on site-wide
   * numbering — and the till then refuses to take a return offline rather than inventing
   * a number that could collide with the back office's run.
   */
  const creditSequence =
    terminal && config.scope === 'terminal'
      ? await getSequence(siteId, 'credit_sale', terminal.id)
      : null
  const till = terminal ? await tillNumber(siteId, terminal.id) : null

  /* The quick keys, plus the names their captions fall back to. Only the products and
     departments actually ON a key — the product file is already in this response, but the
     till would have to search 40,000 rows to label six buttons.

     Every bar, not just `main`: the floor's Quick keys button draws the tables section,
     and a hospitality till that reloaded offline with only the main bar cached would lose
     it — the same failure this block was written to fix for the catalogue pane. */
  const quickKeys = await listAllQuickKeys(siteId)
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
      /* `posImageId` rides along so an offline till draws the same department
         tiles as an online one. It is an id, not bytes: the picture itself is
         fetched from /api/department-image and cached by the browser, which
         keeps IndexedDB holding rows rather than a photo library. The trade is
         deliberate — a till that goes offline before it has ever drawn a
         department falls back to the glyph, which is what it drew anyway. */
      departments: departments
        .filter((d) => d.isActive)
        .map((d) => ({
          id: d.id,
          parentId: d.parentId,
          name: d.name,
          sortOrder: d.sortOrder,
          posImageId: d.posImageId,
        })),
      tenders,
      specials,
      /**
       * Price changes that have been approved but not yet written. Each carries
       * its moment and its own absolute prices; the till decides on its clock.
       * Empty is the normal case.
       */
      pendingPrices,
      /*
       * The shop's settings, plus THIS TILL's mode.
       *
       * `pos_mode` used to be one of the settings read above. It is now a
       * column on the till, so it is merged in here rather than fetched — the
       * route already resolved `terminal` from the device id for numbering.
       *
       * Merged into the same key the till already reads, deliberately: an
       * offline reload takes its mode from this map, and moving it to a new
       * field would mean a till running an older bundle silently coming up in
       * retail on a restaurant floor — no table gate, and a waiter with no way
       * to reach the bill they left open. Same key, better source.
       *
       * A machine matching no terminal gets 'retail', which is the answer that
       * trades and the same one the column defaults to.
       */
      settings: { ...settings, pos_mode: terminal?.posMode ?? 'retail' },
      /**
       * The questions the till may ask, and which ones each product starts on.
       *
       * Flat, and split in two, because the whole point of the feature is that
       * "choice of bread" is defined once and attached to forty sandwiches —
       * inlining it per product would put forty copies of it in a payload that
       * already carries up to fifty thousand rows. Growth follows the menu, not
       * the product file.
       *
       * Always present, even on a delta: see the note at the fetch above.
       */
      instructionGroups: instructions.groups,
      productInstructionGroups: instructions.byProduct,
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
      /**
       * The credit-note sequence, for a return taken offline.
       *
       * Same shape as `sequence` so the till stores both through one code path. Null
       * means this till cannot number a return offline — see the comment where it is
       * resolved — and the return screen says so rather than failing at the last tap.
       */
      creditSequence:
        creditSequence && till
          ? {
              terminalId: creditSequence.terminalId,
              prefix: creditSequence.prefix,
              storeNumber: config.storeNumber,
              tillNumber: till,
              padding: creditSequence.padding,
              periodKey:
                creditSequence.resetPeriod === 'yearly' ? String(new Date().getFullYear()) : null,
              serverNextNumber: creditSequence.nextNumber,
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
      /*
       * The rotating menus, windows unevaluated. Stored rather than left on the
       * page's props for the same reason the quick keys and pending prices are:
       * the props are right on a fresh load and gone after a reload with no
       * network — and a café that reloads a till at 10:55 must still get its
       * lunch menu at 11:00.
       */
      posMenus,
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
  /*
   * The room THIS till sells from, so the cached catalog carries the same
   * quantity the online screen would show. Without it a till assigned to the
   * storeroom would count the storeroom while online and main the moment it
   * dropped offline — the one situation where nobody can check the figure
   * against the server.
   *
   * Null for a machine matching no terminal, which counts main exactly as
   * before.
   */
  locationId: number | null,
) {
  if (!cutoff) {
    return browseForTill(siteId, { priceStructureId, limit: PRODUCT_LIMIT, locationId })
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
  const all = await browseForTill(siteId, { priceStructureId, limit: PRODUCT_LIMIT, locationId })
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
