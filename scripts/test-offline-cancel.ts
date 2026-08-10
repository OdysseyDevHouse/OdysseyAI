/**
 * Cancelling an offline sale — the server half, and the burn rule.
 *
 *   npx tsx --conditions=react-server --env-file=.env scripts/test-offline-cancel.ts
 *
 * Two things are checked, and they fail in opposite directions:
 *
 *   · `recordCancelledSale` KEEPS the record. A till that can make a sale disappear
 *     without a trace is a till somebody can steal from, and the person best placed to
 *     exploit that is the one standing at it. So the reason is required, the payload is
 *     kept, and sending the same cancellation twice yields one row rather than two.
 *   · A cancelled sale creates NO DOCUMENT. The sale never happened on the server's
 *     books; inventing a cancelled invoice for it would put a row in the sales register
 *     for something that was never sold, and every report that counts documents would
 *     be wrong by one.
 *
 * The burn-vs-rewind decision itself lives in `releaseLocalNumber`, which reads the
 * counter out of IndexedDB and so cannot run here — it is covered in a real browser by
 * `verify-pos-outbox.mjs`. What this file asserts is that the server records WHICH of
 * the two happened, because that is the explanation for the one gap a till's otherwise
 * gapless invoice run can have.
 */
import { siteExecute, siteQuery, siteQueryOne } from '../src/lib/siteDb'
import { recordCancelledSale } from '../src/lib/site/offlineSync'
import { toNum } from '../src/lib/decimals'
import type { CancelledSale } from '../src/lib/posOffline/types'

const SITE = 1
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

const uuid = (tag: string) =>
  `30000000-3000-4000-8000-${tag.padStart(12, '0').slice(-12)}`

async function main() {
  const stamp = Date.now().toString().slice(-8)

  // Sweep anything an earlier crashed run left: uq_cancelled_uid is unique, so a
  // leftover would fail the INSERT rather than the assertion it was making.
  await siteExecute(SITE, "DELETE FROM offline_cancelled_sales WHERE user_name LIKE 'Cancel test%'")

  const base: CancelledSale = {
    saleUid: uuid(stamp),
    documentNumber: 'INV_01_97_000501',
    terminalId: null,
    terminalCode: 'TSTCANCEL',
    operatorUserId: 1,
    operatorName: 'Cancel test cashier',
    totalIncl: 149.99,
    reason: 'customer changed their mind',
    takenAt: new Date().toISOString(),
    cancelledAt: new Date().toISOString(),
    payload: {
      lines: [{ productCode: 'X1', qty: 2, unitPriceIncl: 74.995 }],
      tenders: [{ tenderCode: 'CASH', amount: 150 }],
      numberBurnt: true,
      cancelledByUserId: 1,
      cancelledByName: 'Cancel test cashier',
    },
  }

  /* ── 1. It records ─────────────────────────────────────────────────────── */

  const first = await recordCancelledSale(SITE, { ...base, operatorName: 'Cancel test cashier' })
  ok('a cancellation is recorded', first.ok, first.error ?? '')

  const row = await siteQueryOne<any>(
    SITE,
    `SELECT sale_uid, document_number, user_id, user_name, total_incl, reason,
            taken_at, cancelled_at, payload
       FROM offline_cancelled_sales WHERE sale_uid = ?`,
    [base.saleUid],
  )
  ok('the row exists', row !== null)
  ok(
    'and keeps the NUMBER the sale consumed',
    row?.document_number === 'INV_01_97_000501',
    String(row?.document_number),
  )
  ok('with the reason', row?.reason === 'customer changed their mind', String(row?.reason))
  ok(
    'and the value, so a pattern of large cancellations is visible',
    Math.abs(toNum(row?.total_incl) - 149.99) < 0.01,
    String(row?.total_incl),
  )
  ok('and who was at the till', row?.user_id === 1, String(row?.user_id))

  const payload = typeof row?.payload === 'string' ? JSON.parse(row.payload) : row?.payload
  ok('the lines are kept', Array.isArray(payload?.lines) && payload.lines.length === 1)
  ok('the tenders are kept', Array.isArray(payload?.tenders) && payload.tenders.length === 1)
  ok(
    'and whether the number was BURNT — the explanation for the gap',
    payload?.numberBurnt === true,
    String(payload?.numberBurnt),
  )
  ok(
    'and who cancelled it, separately from who sold it',
    payload?.cancelledByUserId === 1,
    String(payload?.cancelledByUserId),
  )

  /* ── 2. NO DOCUMENT is created ──────────────────────────────────────────
     The sale never happened on the server. A cancelled invoice would put a row in
     the sales register for something that was never sold. */

  const doc = await siteQueryOne<any>(
    SITE,
    'SELECT COUNT(*) AS n FROM sales_documents WHERE offline_sale_uid = ?',
    [base.saleUid],
  )
  ok('no sales document is created', Number(doc?.n) === 0, `${doc?.n} document(s)`)

  const claim = await siteQueryOne<any>(
    SITE,
    'SELECT COUNT(*) AS n FROM offline_sync_claims WHERE sale_uid = ?',
    [base.saleUid],
  )
  ok('and no sync claim is taken', Number(claim?.n) === 0, `${claim?.n} claim(s)`)

  /* ── 3. IDEMPOTENT — a till retries a cancellation exactly like a sale ─── */

  const replay = await recordCancelledSale(SITE, base)
  ok('a replayed cancellation is accepted', replay.ok, replay.error ?? '')
  const count = await siteQueryOne<any>(
    SITE,
    'SELECT COUNT(*) AS n FROM offline_cancelled_sales WHERE sale_uid = ?',
    [base.saleUid],
  )
  ok('and yields exactly ONE row', Number(count?.n) === 1, `${count?.n} rows`)

  /* ── 4. A reason is REQUIRED ────────────────────────────────────────────
     Not defaulted. A cancelled sale with no explanation tells a manager only that
     money went missing, and an optional field is usually an absent one. */

  const noReason = await recordCancelledSale(SITE, {
    ...base,
    saleUid: uuid(`${stamp}2`),
    reason: '   ',
  })
  ok('a cancellation with no reason is REFUSED', !noReason.ok, noReason.error ?? '')
  ok('and says why', /reason/i.test(noReason.error ?? ''), noReason.error ?? '')

  const badUid = await recordCancelledSale(SITE, { ...base, saleUid: 'not-a-uuid' })
  ok('a malformed uid is refused', !badUid.ok, badUid.error ?? '')

  /* ── 5. A deleted operator still leaves a usable record ────────────────
     user_id must be NULL rather than 0 — there is no users row 0, and a dangling id
     is worse than an absent one. The NAME carries the attribution. */

  const ghostUid = uuid(`${stamp}3`)
  const ghost = await recordCancelledSale(SITE, {
    ...base,
    saleUid: ghostUid,
    operatorUserId: 0,
    operatorName: 'Cancel test ghost',
  })
  ok('a cancellation by an unknown operator still records', ghost.ok, ghost.error ?? '')
  const ghostRow = await siteQueryOne<any>(
    SITE,
    'SELECT user_id, user_name FROM offline_cancelled_sales WHERE sale_uid = ?',
    [ghostUid],
  )
  ok('with a NULL user rather than a dangling id', ghostRow?.user_id === null, String(ghostRow?.user_id))
  ok(
    'and the name still attributes it',
    String(ghostRow?.user_name).includes('ghost'),
    String(ghostRow?.user_name),
  )

  /* ── Clean up ──────────────────────────────────────────────────────────── */
  await siteExecute(SITE, "DELETE FROM offline_cancelled_sales WHERE user_name LIKE 'Cancel test%'")
  const left = await siteQuery<any>(
    SITE,
    "SELECT COUNT(*) AS n FROM offline_cancelled_sales WHERE user_name LIKE 'Cancel test%'",
  )
  ok('the test leaves nothing behind', Number(left[0]?.n) === 0, String(left[0]?.n))

  console.log(fails === 0 ? '\nAll offline cancel checks passed.' : `\n${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
