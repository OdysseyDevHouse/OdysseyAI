/**
 * Cross-store transfer DRIFT, against real transfers.
 *
 * The group transfer screen has two shapes to tell apart, and only one of them
 * means a figure is wrong:
 *
 *   unsettled  the receiver has taken the goods and the sender still holds
 *              them. They are on two sets of books at once, and group stock is
 *              overstated until settleDispatch runs. This is the bug.
 *   stale      dispatched a while ago and not yet received. A late lorry.
 *              Worth seeing, not an error, and it must never outrank the above.
 *
 * `test:group-reporting` asserts the ordering, but the dev data has no
 * inter-store transfers at all, so those assertions pass vacuously — the list is
 * empty and every claim about it is trivially true. This builds the real thing:
 * two products, two stores, a dispatch left in transit and a second one received
 * WITHOUT being settled, which is exactly the split-brain window.
 *
 * Everything it creates is prefixed and swept at both ends, before and after —
 * a leaked row on a UNIQUE column kills an unrelated suite before its first
 * assertion.
 *
 *   npm run test:store-transfer-drift
 */
import { siteExecute, siteQueryOne } from '../src/lib/siteDb'
import { groupScopeFor, groupTransfers } from '../src/lib/groupReporting'
import { linkedStores } from '../src/lib/storeGroups'
import {
  dispatchToStore,
  receiveFromStore,
  settleDispatch,
  reconcileStoreTransfers,
} from '../src/lib/site/storeTransfers'
import { mainLocationId } from '../src/lib/site/stockLocations'

const SITE = 1
const CONTROL_USER = 1
const actor = { userId: 1, userName: 'Drift Test' }
const CODE_PREFIX = 'XDRIFT'
const CODE_PATTERN = '^XDRIFT[0-9]{2}$'

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

/** Removes everything this test creates, at BOTH ends of every transfer. */
async function sweep(siteIds: number[]) {
  for (const siteId of siteIds) {
    const products = `(SELECT id FROM products WHERE code REGEXP '${CODE_PATTERN}')`
    const transfers = `(SELECT id FROM stock_transfers WHERE reference LIKE '${CODE_PREFIX}%')`
    try {
      await siteExecute(siteId, `DELETE FROM stock_transfer_lines WHERE transfer_id IN ${transfers}`)
      await siteExecute(siteId, `DELETE FROM stock_transfer_lines WHERE product_id IN ${products}`)
      await siteExecute(siteId, `DELETE FROM stock_transfers WHERE reference LIKE '${CODE_PREFIX}%'`)
      await siteExecute(siteId, `DELETE FROM stock_movements WHERE product_id IN ${products}`)
      await siteExecute(siteId, `DELETE FROM product_location_stock WHERE product_id IN ${products}`)
      await siteExecute(siteId, `DELETE FROM products WHERE code REGEXP '${CODE_PATTERN}'`)
    } catch (e) {
      console.log(`  (sweep on site ${siteId}: ${e instanceof Error ? e.message : e})`)
    }
  }
}

/** A product with the same CODE at both stores — the only cross-store identity. */
async function seedProduct(siteIds: number[], code: string, qty: number) {
  const ids = new Map<number, number>()
  for (const siteId of siteIds) {
    await siteExecute(
      siteId,
      `INSERT INTO products (code, description, product_type, last_cost, average_cost, stock_on_hand, is_archived)
       VALUES (?, ?, 'normal', 10.0000, 10.0000, 0.000, 0)`,
      [code, `Drift test ${code}`],
    )
    const row = await siteQueryOne<any>(siteId, 'SELECT id FROM products WHERE code = ?', [code])
    const productId = Number(row.id)
    ids.set(siteId, productId)

    // Stock only where it is dispatched FROM; the receiver starts with none.
    const locationId = await mainLocationId(siteId)
    await siteExecute(
      siteId,
      `INSERT INTO product_location_stock (product_id, location_id, stock_on_hand, min_stock, max_stock)
       VALUES (?, ?, ?, 0, 0)
       ON DUPLICATE KEY UPDATE stock_on_hand = VALUES(stock_on_hand)`,
      [productId, locationId, siteId === SITE ? qty : 0],
    )
    if (siteId === SITE) {
      await siteExecute(siteId, 'UPDATE products SET stock_on_hand = ? WHERE id = ?', [qty, productId])
    }
  }
  return ids
}

async function main() {
  const scope = await groupScopeFor(SITE, CONTROL_USER, 'stock.view')
  const shared = await linkedStores(SITE)
  const peer = shared.find((s) => s.siteId !== SITE)

  if (!scope || !peer) {
    console.log('Needs two stores sharing a product file. Skipping.')
    process.exit(0)
  }
  const siteIds = [SITE, peer.siteId]
  console.log(`Stores: ${scope.sites.map((s) => s.name).join(' -> ')}\n`)

  await sweep(siteIds)

  try {
    /* ── Two transfers, two different fates ──────────────────────────────── */

    const stuck = await seedProduct(siteIds, `${CODE_PREFIX}01`, 50)
    const unsettled = await seedProduct(siteIds, `${CODE_PREFIX}02`, 50)
    const fromLocation = await mainLocationId(SITE)
    const toLocation = await mainLocationId(peer.siteId)

    // (1) Dispatched and left on the road. Dated well back so it reads as stale.
    const staleDispatch = await dispatchToStore(SITE, actor, {
      toSiteId: peer.siteId,
      fromLocationId: fromLocation,
      documentDate: '2026-01-05',
      reference: `${CODE_PREFIX}-STALE`,
      lines: [
        {
          productId: stuck.get(SITE)!,
          // Code and description travel WITH the line: the receiver joins on
          // code, because ids mean nothing across databases.
          productCode: `${CODE_PREFIX}01`,
          description: `Drift test ${CODE_PREFIX}01`,
          qty: 5,
        },
      ],
    })
    ok('*** a dispatch posts and sits in transit ***', staleDispatch.ok,
      staleDispatch.ok ? `#${staleDispatch.id}` : staleDispatch.error)
    if (!staleDispatch.ok) throw new Error(staleDispatch.error)

    // Back-date the dispatch itself: staleness is measured from dispatched_at.
    await siteExecute(
      SITE,
      `UPDATE stock_transfers SET dispatched_at = DATE_SUB(NOW(), INTERVAL 30 DAY) WHERE id = ?`,
      [staleDispatch.id],
    )

    // (2) Dispatched AND received — but never settled at the sender. This is
    //     the split-brain window the whole module is arranged around.
    const twiceDispatch = await dispatchToStore(SITE, actor, {
      toSiteId: peer.siteId,
      fromLocationId: fromLocation,
      documentDate: '2026-08-01',
      reference: `${CODE_PREFIX}-TWICE`,
      lines: [
        {
          productId: unsettled.get(SITE)!,
          productCode: `${CODE_PREFIX}02`,
          description: `Drift test ${CODE_PREFIX}02`,
          qty: 7,
        },
      ],
    })
    if (!twiceDispatch.ok) throw new Error(twiceDispatch.error)

    const received = await receiveFromStore(peer.siteId, actor, {
      peerSiteId: SITE,
      peerTransferId: twiceDispatch.id,
      toLocationId: toLocation,
    })
    ok('*** the receiving store can take the goods ***', received.ok,
      received.ok ? `#${received.id}` : received.error)
    if (!received.ok) throw new Error(received.error)

    /* receiveFromStore settles the sender itself, which is the correct
       behaviour — so to reproduce the BUG the sender is put back to in_transit,
       exactly the state a crash between the two commits would leave. */
    await siteExecute(
      SITE,
      `UPDATE stock_transfers SET status = 'in_transit', received_at = NULL WHERE id = ?`,
      [twiceDispatch.id],
    )

    /* ── What the per-site check sees ────────────────────────────────────── */

    const own = await reconcileStoreTransfers(SITE)
    const mine = own.filter((d) => [staleDispatch.id, twiceDispatch.id].includes(d.transferId))
    ok('*** the per-site check finds both problems ***', mine.length === 2,
      mine.map((d) => `${d.transferId}:${d.kind}`).join(' '))

    ok('  the received-but-unsettled one is UNSETTLED, not merely stale',
      mine.find((d) => d.transferId === twiceDispatch.id)?.kind === 'unsettled')
    ok('  the one still on the road is STALE, not a double count',
      mine.find((d) => d.transferId === staleDispatch.id)?.kind === 'stale')

    /* ── What the GROUP screen sees ──────────────────────────────────────── */

    const group = await groupTransfers(scope.sites, { from: '2026-01-01', to: '2026-12-31' })
    const groupMine = group.drift.filter((d) =>
      [staleDispatch.id, twiceDispatch.id].includes(d.transferId),
    )

    ok('*** the group screen surfaces both, with the store that holds them ***',
      groupMine.length === 2 && groupMine.every((d) => d.siteId === SITE && d.siteName.length > 0),
      groupMine.map((d) => `${d.siteName}:${d.kind}`).join(' '))

    /* The ordering assertion that was vacuous before: with BOTH kinds present,
       unsettled must come first. A late lorry above a double count buries the
       only entry that means a figure is wrong. */
    const firstStale = group.drift.findIndex((d) => d.kind === 'stale')
    const lastUnsettled = group.drift.map((d) => d.kind).lastIndexOf('unsettled')
    ok('*** unsettled outranks stale — now proved, not vacuous ***',
      firstStale > -1 && lastUnsettled > -1 && lastUnsettled < firstStale,
      group.drift.map((d) => d.kind).join(','))

    /* ── Flow and in-transit ─────────────────────────────────────────────── */

    ok('*** flow counts the movement once, from the sender ***',
      group.flow.length === 1 &&
      group.flow[0].fromSiteId === SITE &&
      group.flow[0].toSiteId === peer.siteId,
      group.flow.map((f) => `${f.fromName}->${f.toName} ${f.units}u`).join(' '))

    ok('  and never as the receiver\'s inbound leg as well',
      !group.flow.some((f) => f.fromSiteId === peer.siteId))

    const transit = group.inTransit.find((t) => t.siteId === SITE)
    ok('*** goods on the road are reported against the sending store ***',
      transit !== undefined && transit.units >= 5,
      transit ? `${transit.transfers} transfers, ${transit.units} units` : 'none')

    /* ── The repair ──────────────────────────────────────────────────────── */

    /* The repair reads what actually arrived from the RECEIVER's document,
       keyed by product CODE — line ids mean nothing across databases. */
    const peerDoc = await siteQueryOne<any>(
      peer.siteId,
      `SELECT id, document_number FROM stock_transfers
        WHERE direction = 'in' AND peer_site_id = ? AND peer_transfer_id = ? LIMIT 1`,
      [SITE, twiceDispatch.id],
    )
    ok('  the receiver holds a matching inbound document', !!peerDoc,
      peerDoc ? String(peerDoc.document_number) : 'missing')

    const settled = await settleDispatch(SITE, actor, {
      transferId: twiceDispatch.id,
      receiverSiteId: peer.siteId,
      receiverTransferId: Number(peerDoc.id),
      receiverDocumentNumber: String(peerDoc.document_number ?? ''),
      received: [{ productCode: `${CODE_PREFIX}02`, qty: 7 }],
    })
    ok('*** settling the dispatch clears the double count ***', settled.ok,
      settled.ok ? '' : settled.error)

    const after = await groupTransfers(scope.sites, { from: '2026-01-01', to: '2026-12-31' })
    ok('  and the group screen agrees it is gone',
      !after.drift.some((d) => d.transferId === twiceDispatch.id && d.kind === 'unsettled'),
      after.drift.map((d) => `${d.transferId}:${d.kind}`).join(' ') || '(none)')

    ok('  while the lorry that is genuinely late still shows',
      after.drift.some((d) => d.transferId === staleDispatch.id && d.kind === 'stale'))
  } finally {
    await sweep(siteIds)
  }

  console.log(fails === 0 ? '\nAll store-transfer drift checks passed.' : `\n${fails} FAILED`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch(async (e) => {
  console.error(e)
  const shared = await linkedStores(SITE).catch(() => [])
  await sweep([SITE, ...shared.map((s) => s.siteId)]).catch(() => {})
  process.exit(1)
})
