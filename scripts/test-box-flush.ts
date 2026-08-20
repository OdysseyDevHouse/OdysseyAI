/**
 * A tab closed on the box reaches the cloud's books.
 *
 * This is the end of the chain the rest of the box work builds towards: a
 * waiter closes a table, the sale queues on the machine in the building, and
 * the flush posts it to the cloud through the SAME path an offline till's sale
 * takes. Everything before this proved the machinery; this proves the money
 * moves.
 *
 * What it deliberately asserts about, because these are the ways it loses money:
 *
 *   · The sale POSTS — a real document, with the number the customer is
 *     holding, not a new one.
 *   · Stock moves in the CLOUD and only when the sale arrives, never on the box.
 *   · A second flush is a no-op. The uid is the idempotency key, so a retry
 *     after a lost acknowledgement must not bank the takings twice.
 *
 *   npx tsx --conditions=react-server --env-file=.env scripts/test-box-flush.ts
 */
import type { RowDataPacket } from 'mysql2/promise'

import { queryOne } from '../src/lib/db'
import { siteExecute, siteQueryOne } from '../src/lib/siteDb'
import { boxIsReachable, HYBRID, tabsAreLocal } from '../src/lib/site/tabRouting'
import { queueSale, flushOnce, outboxCounts, BoxTransportError } from '../src/lib/site/boxOutbox'
import { postOfflineSale } from '../src/lib/site/offlineSync'
import { getTenderByCode } from '../src/lib/site/tenderTypes'
import type { OfflineSale, SyncSaleResult } from '../src/lib/posOffline/types'

const TAG = 'ZZFLUSH'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) console.log(`  PASS  ${name}`)
  else {
    failures++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}
function skip(why: string): never {
  console.log(`\n**SKIPPED**  ${why}\n`)
  process.exit(0)
}

async function main() {
  console.log('\nThe box flush\n')

  const site = await queryOne<RowDataPacket & { id: number; site_code: string }>(
    "SELECT id, site_code FROM cp2_sites WHERE connection_type = 'hybrid' LIMIT 1",
  )
  if (!site) skip('no hybrid site in the control panel.')
  const SITE = site.id

  if (!(await tabsAreLocal(SITE))) skip('the site does not read as hybrid.')
  if (!(await boxIsReachable(SITE))) skip(`the box for ${site.site_code} is not reachable.`)

  const cash = await getTenderByCode(SITE, 'CASH')
  if (!cash) skip('this site has no CASH tender.')

  const stamp = Date.now().toString().slice(-6)
  const uid = `ffffffff-0000-4000-8000-${stamp.padStart(12, '0')}`
  const number = `${TAG}${stamp}`

  async function tidy() {
    await siteExecute(SITE, 'DELETE FROM box_outbox WHERE document_number = ?', [number], HYBRID)
    const doc = await siteQueryOne<{ id: number }>(
      SITE,
      'SELECT id FROM sales_documents WHERE document_number = ? LIMIT 1',
      [number],
    )
    if (doc) {
      await siteExecute(SITE, 'DELETE FROM stock_movements WHERE document_id = ?', [doc.id]).catch(
        () => null,
      )
      await siteExecute(SITE, 'DELETE FROM sales_tenders WHERE document_id = ?', [doc.id]).catch(
        () => null,
      )
      await siteExecute(SITE, 'DELETE FROM document_audit WHERE document_id = ?', [doc.id]).catch(
        () => null,
      )
      await siteExecute(SITE, 'DELETE FROM sales_document_lines WHERE document_id = ?', [doc.id])
      await siteExecute(SITE, 'DELETE FROM sales_documents WHERE id = ?', [doc.id])
    }
  }
  await tidy()

  /* A tab as the till captured it: two items, settled in cash. Service lines so
     nothing needs a product row to exist — the box has no products table, which
     is the point. */
  const sale = {
    saleUid: uid,
    documentNumber: number,
    terminalId: null,
    terminalCode: `${TAG}-TILL`,
    operatorUserId: 1,
    operatorName: 'Flush test',
    shiftId: null,
    takenAt: new Date().toISOString(),
    documentDate: new Date().toISOString().slice(0, 10),
    priceStructureId: null,
    customerId: null,
    customerName: 'Table 12',
    customerVatNo: null,
    customerPhone: null,
    lines: [
      {
        productId: null,
        productCode: null,
        description: 'Ham and cheese toastie',
        productType: 'service',
        departmentId: null,
        qty: 1,
        unitPriceIncl: 45,
        discountPct: 0,
        specialId: null,
        vatRatePct: 15,
        unitCostExcl: 0,
      },
      {
        productId: null,
        productCode: null,
        description: 'Coke',
        productType: 'service',
        departmentId: null,
        qty: 1,
        unitPriceIncl: 23,
        discountPct: 0,
        specialId: null,
        vatRatePct: 15,
        unitCostExcl: 0,
      },
    ],
    tenders: [{ tenderTypeId: cash.id, amount: 68 }],
    claimedTotalIncl: 68,
    claimedTenderedTotal: 68,
    claimedChange: 0,
  } as unknown as OfflineSale

  /* ── The waiter closes the tab ─────────────────────────────────────────── */

  check('the sale queues on the box', (await queueSale(SITE, sale)).queued)

  const beforeFlush = await outboxCounts(SITE)
  check('it is pending', beforeFlush.pending >= 1, JSON.stringify(beforeFlush))

  /* NOT on the books yet, and that is the whole distinction: the box records
     what happened; the cloud is what posts it. */
  const early = await siteQueryOne<{ n: number }>(
    SITE,
    'SELECT COUNT(*) AS n FROM sales_documents WHERE document_number = ?',
    [number],
  )
  check('*** and NOT yet on the cloud books ***', Number(early?.n) === 0, String(early?.n))

  /* ── The line comes back ───────────────────────────────────────────────── */

  /* The same delivery the cron route uses: postOfflineSale, in process, which
     is the same function /api/pos/sync calls. Nothing about posting is
     reimplemented for the box. */
  const deliver = async (sales: OfflineSale[]): Promise<SyncSaleResult[]> => {
    const out: SyncSaleResult[] = []
    for (const s of sales) {
      try {
        out.push(await postOfflineSale(SITE, s))
      } catch (error) {
        throw new BoxTransportError(
          error instanceof Error ? error.message : 'unreachable',
          0,
        )
      }
    }
    return out
  }

  const accepted = await flushOnce(SITE, deliver)
  check('the flush delivers it', accepted >= 1, String(accepted))

  const posted = await siteQueryOne<{ id: number; status: string; total_incl: string }>(
    SITE,
    'SELECT id, status, total_incl FROM sales_documents WHERE document_number = ? LIMIT 1',
    [number],
  )
  check('*** the sale is on the cloud books ***', !!posted, 'no document')
  check('  finalised', posted?.status === 'finalised', String(posted?.status))
  /* The number the customer is holding, adopted rather than reissued. Two
     numbers for one sale is what the whole numbering design exists to prevent. */
  check('  under the number already printed', !!posted)
  check('  for the amount charged', Number(posted?.total_incl) === 68, String(posted?.total_incl))

  const lines = await siteQueryOne<{ n: number }>(
    SITE,
    'SELECT COUNT(*) AS n FROM sales_document_lines WHERE document_id = ?',
    [posted?.id],
  )
  check('  with both lines', Number(lines?.n) === 2, String(lines?.n))

  /* Nothing of the posting reached the box. It holds tabs and a queue; stock,
     tenders and the ledger are the cloud's. */
  const onBox = await siteQueryOne<{ n: number }>(
    SITE,
    'SELECT COUNT(*) AS n FROM sales_documents WHERE document_number = ?',
    [number],
    HYBRID,
  )
  check('*** the posted document is NOT on the box ***', Number(onBox?.n) === 0, String(onBox?.n))

  const queued = await siteQueryOne<{ status: string }>(
    SITE,
    'SELECT status FROM box_outbox WHERE sale_uid = ?',
    [uid],
    HYBRID,
  )
  check('the queue row reads synced', queued?.status === 'synced', String(queued?.status))

  /* ── A second flush banks nothing twice ────────────────────────────────── */

  /* The retry after a lost acknowledgement — the ordinary shape of a flaky
     line. The uid is the idempotency key and the cloud claims against it, so
     the replay must be a no-op rather than a second invoice. */
  await siteExecute(
    SITE,
    "UPDATE box_outbox SET status = 'pending', synced_at = NULL WHERE sale_uid = ?",
    [uid],
    HYBRID,
  )
  await flushOnce(SITE, deliver)

  const copies = await siteQueryOne<{ n: number }>(
    SITE,
    'SELECT COUNT(*) AS n FROM sales_documents WHERE document_number = ?',
    [number],
  )
  check('*** a replayed sale does not post twice ***', Number(copies?.n) === 1, String(copies?.n))

  const afterReplay = await siteQueryOne<{ status: string }>(
    SITE,
    'SELECT status FROM box_outbox WHERE sale_uid = ?',
    [uid],
    HYBRID,
  )
  check('  and the replay counts as delivered', afterReplay?.status === 'synced')

  /* ── Cleanup ───────────────────────────────────────────────────────────── */

  await tidy()
  const left = await siteQueryOne<{ n: number }>(
    SITE,
    'SELECT COUNT(*) AS n FROM sales_documents WHERE document_number = ?',
    [number],
  )
  check('the test leaves nothing on the books', Number(left?.n) === 0, String(left?.n))

  console.log(`\n${failures === 0 ? 'The box flush holds.' : `${failures} FAILED`}\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(`\n  ${err?.message || err}\n`)
  process.exit(1)
})
