/**
 * The queue that gets a hybrid shop's takings onto the books.
 *
 * Every check here is about one of two ways this loses money:
 *
 *   · A pending row is a sale that HAPPENED — the customer has the goods and
 *     the drawer has the cash. Nothing may delete one.
 *   · A transport failure says nothing about the sales in the batch. Treating
 *     it as a rejection would mark real revenue `failed` because a cable was
 *     out.
 *
 * `deliver` is injected, so the cloud's answers can be dictated exactly — a
 * network test could not reliably produce a duplicate, a retryable error and a
 * hard refusal in one run.
 *
 * Skips without a hybrid site and a reachable box, which is a normal checkout.
 *
 *   npx tsx --conditions=react-server --env-file=.env scripts/test-box-outbox.ts
 */
import type { RowDataPacket } from 'mysql2/promise'

import { queryOne } from '../src/lib/db'
import { siteExecute, siteQueryOne } from '../src/lib/siteDb'
import { boxIsReachable, HYBRID, tabsAreLocal } from '../src/lib/site/tabRouting'
import {
  queueSale,
  flushOnce,
  prune,
  outboxCounts,
  listOutbox,
  BoxTransportError,
} from '../src/lib/site/boxOutbox'
import type { OfflineSale, SyncSaleResult } from '../src/lib/posOffline/types'

const TAG = 'ZZOUTBOX'

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

/** A sale as the till captured it. Only the fields the outbox itself reads. */
function sale(uid: string, number: string, takenAt: string): OfflineSale {
  return {
    saleUid: uid,
    documentNumber: number,
    takenAt,
    documentDate: takenAt.slice(0, 10),
    terminalId: null,
    terminalCode: `${TAG}-TILL`,
    operatorUserId: 1,
    operatorName: 'Outbox test',
    shiftId: null,
    priceStructureId: null,
    customerId: null,
    lines: [],
    tenders: [],
  } as unknown as OfflineSale
}

async function main() {
  console.log('\nThe box outbox\n')

  const site = await queryOne<RowDataPacket & { id: number; site_code: string }>(
    "SELECT id, site_code FROM cp2_sites WHERE connection_type = 'hybrid' LIMIT 1",
  )
  if (!site) skip('no hybrid site in the control panel.')
  const SITE = site.id

  if (!(await tabsAreLocal(SITE))) skip('the site does not read as hybrid.')
  if (!(await boxIsReachable(SITE))) skip(`the box for ${site.site_code} is not reachable.`)

  async function tidy() {
    await siteExecute(SITE, 'DELETE FROM box_outbox WHERE document_number LIKE ?', [`${TAG}%`], HYBRID)
  }
  async function statusOf(uid: string) {
    return siteQueryOne<{ status: string; attempts: number; last_error: string | null }>(
      SITE,
      'SELECT status, attempts, last_error FROM box_outbox WHERE sale_uid = ?',
      [uid],
      HYBRID,
    )
  }
  await tidy()

  /* ── Queueing ──────────────────────────────────────────────────────────── */

  /* Real UUID-length ids. `sale_uid` is CHAR(36) and MariaDB truncates a longer
     value silently, so a tagged uid is stored short and never found again — the
     lookups all miss and every assertion downstream reads undefined. The
     document_number carries the tag instead; it is what tidy() matches on. */
  const a = 'aaaaaaaa-0000-4000-8000-00000000000a'
  const b = 'bbbbbbbb-0000-4000-8000-00000000000b'
  const c = 'cccccccc-0000-4000-8000-00000000000c'

  check('a sale queues', (await queueSale(SITE, sale(a, `${TAG}001`, '2026-08-20T10:00:00Z'))).queued)
  check('a second queues', (await queueSale(SITE, sale(b, `${TAG}002`, '2026-08-20T10:05:00Z'))).queued)

  /* A till that retried after a timeout must not create a second copy of a sale
     already waiting. The unique index makes that a constraint. */
  const again = await queueSale(SITE, sale(a, `${TAG}001`, '2026-08-20T10:00:00Z'))
  check('*** the same sale cannot queue twice ***', !again.queued)

  const counts = await outboxCounts(SITE)
  check('both read as pending', counts.pending === 2, JSON.stringify(counts))

  /* ── A TRANSPORT FAILURE CHANGES NOTHING ───────────────────────────────── */

  /* THE assertion. The line being down says nothing about the sales, so the run
     must abort with everything still pending — not mark twenty-five real sales
     `failed` because a cookie expired overnight. */
  let threw = false
  try {
    await flushOnce(SITE, async () => {
      throw new BoxTransportError('No connection.', 0)
    })
  } catch (err) {
    threw = err instanceof BoxTransportError
  }
  check('*** a transport failure aborts the run ***', threw)

  const afterTransport = await outboxCounts(SITE)
  check(
    '*** and NOTHING was marked ***',
    afterTransport.pending === 2 && afterTransport.failed === 0,
    JSON.stringify(afterTransport),
  )

  /* ── Oldest first ──────────────────────────────────────────────────────── */

  let sentOrder: string[] = []
  await flushOnce(SITE, async (sales) => {
    sentOrder = sales.map((s) => s.documentNumber)
    /* Nothing is accepted, so both stay pending for the checks below. */
    return sales.map((s) => ({ saleUid: s.saleUid, ok: false, error: 'not now', retryable: true }))
  })
  check(
    'sales go oldest first',
    sentOrder[0] === `${TAG}001` && sentOrder[1] === `${TAG}002`,
    sentOrder.join(','),
  )

  const retried = await statusOf(a)
  check('a retryable refusal leaves it pending', retried?.status === 'pending', retried?.status)
  check('  and counts the attempt', Number(retried?.attempts) === 1, String(retried?.attempts))
  check('  and records why', retried?.last_error === 'not now', String(retried?.last_error))

  /* ── One bad sale does not cost the others ─────────────────────────────── */

  await queueSale(SITE, sale(c, `${TAG}003`, '2026-08-20T10:10:00Z'))

  const accepted = await flushOnce(SITE, async (sales) =>
    sales.map((s): SyncSaleResult => {
      if (s.saleUid === a) return { saleUid: s.saleUid, ok: true, documentNumber: s.documentNumber }
      /* A duplicate is SUCCESS: a previous run delivered it and the
         acknowledgement was lost. The cloud's claim table makes the replay a
         no-op, which is what makes a retry safe. */
      if (s.saleUid === b) return { saleUid: s.saleUid, ok: true, duplicate: true }
      return { saleUid: s.saleUid, ok: false, error: 'Malformed sale.', retryable: false }
    }),
  )

  check('the good sale is accepted', accepted === 2, String(accepted))
  check('  it reads synced', (await statusOf(a))?.status === 'synced')
  check('*** a duplicate counts as delivered ***', (await statusOf(b))?.status === 'synced')
  check('*** a hard refusal is marked failed, not retried forever ***',
    (await statusOf(c))?.status === 'failed')
  check('  with the reason kept for a human', (await statusOf(c))?.last_error === 'Malformed sale.')

  /* ── NOTHING DELETES A PENDING OR FAILED ROW ───────────────────────────── */

  /* A sale that quietly disappeared is worse than one in a list marked "needs
     attention", so prune touches `synced` and nothing else. Getting this
     predicate backwards loses real money off the floor. */
  await siteExecute(
    SITE,
    "UPDATE box_outbox SET synced_at = DATE_SUB(NOW(), INTERVAL 30 DAY) WHERE document_number LIKE ?",
    [`${TAG}%`],
    HYBRID,
  )
  const pruned = await prune(SITE)
  check('an old delivered sale is pruned', pruned === 2, String(pruned))

  const survivors = (await listOutbox(SITE)).filter((e) => e.documentNumber.startsWith(TAG))
  check('*** the failed sale SURVIVES the prune ***', survivors.some((e) => e.saleUid === c))
  check('  and the delivered ones are gone', !survivors.some((e) => e.saleUid === a))

  /* A pending row is a sale that happened. It must survive a prune too. */
  const d = 'dddddddd-0000-4000-8000-00000000000d'
  await queueSale(SITE, sale(d, `${TAG}004`, '2026-08-20T10:20:00Z'))
  await siteExecute(
    SITE,
    'UPDATE box_outbox SET synced_at = DATE_SUB(NOW(), INTERVAL 30 DAY) WHERE sale_uid = ?',
    [d],
    HYBRID,
  )
  await prune(SITE)
  check('*** a PENDING sale survives the prune ***', (await statusOf(d))?.status === 'pending')

  /* ── Cleanup ───────────────────────────────────────────────────────────── */

  await tidy()
  const left = await siteQueryOne<{ n: number }>(
    SITE,
    'SELECT COUNT(*) AS n FROM box_outbox WHERE document_number LIKE ?',
    [`${TAG}%`],
    HYBRID,
  )
  check('the test leaves nothing behind', Number(left?.n) === 0, String(left?.n))

  console.log(`\n${failures === 0 ? 'The box outbox holds.' : `${failures} FAILED`}\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(`\n  ${err?.message || err}\n`)
  process.exit(1)
})
