/**
 * Returns taken offline, posted at sync.
 *
 *   npx tsx --conditions=react-server --env-file=.env scripts/test-offline-returns.ts
 *
 * A refund is money LEAVING the drawer, so the properties that matter here are the
 * mirror of the sales suite's: post it exactly once, never twice; put the stock back;
 * carry the number the customer is holding; and never silently swallow one.
 *
 * Asserts a site-wide stock invariant via reconcileStock, so pre-publish schedules it
 * solo — see the glob in pre-publish.mjs.
 */
import { siteExecute, siteQuery, siteQueryOne } from '../src/lib/siteDb'
import { postOfflineReturn, validateOfflineReturn } from '../src/lib/site/offlineReturns'
import { reconcileStock, seedOpeningStock } from '../src/lib/site/stockMovements'
import { getTenderByCode } from '../src/lib/site/tenderTypes'
import { setSetting, getSetting } from '../src/lib/site/settings'
import { toNum } from '../src/lib/decimals'
import type { OfflineReturn } from '../src/lib/posOffline/types'
import { findSalesReasonByCode } from '../src/lib/site/salesReasons'

const SITE = 1

/*
 * The seeded reason codes, resolved once.
 *
 * Every void and credit note now names a row rather than carrying free text, so
 * these tests need real ids. Read from the site rather than hardcoded: the ids
 * are AUTO_INCREMENT and differ per site, and 102 seeds the codes by name.
 */
let RETURN_REASON_ID = 0

async function loadReasonIds() {
  const r = await findSalesReasonByCode(SITE, 'return', 'FAULTY')
  if (!r) throw new Error('Seeded return reason FAULTY is missing — run site-migrate for 102.')
  RETURN_REASON_ID = r.id
}

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

let uidCounter = 0
const uuid = () => {
  uidCounter++
  const tail = (Date.now().toString(16) + String(uidCounter).padStart(4, '0')).slice(-12)
  return `20000000-2000-4000-8000-${tail}`
}

const stockOf = async (id: number) =>
  toNum(
    (await siteQueryOne<any>(SITE, 'SELECT stock_on_hand FROM products WHERE id = ?', [id]))
      ?.stock_on_hand,
  )

/**
 * A till number no terminal is using.
 *
 * Queried, never hardcoded — the lesson from test-offline-sync, which asked for '97',
 * collided with test-cashup's scratch till and died before its first assertion.
 */
async function freeTillNumber(): Promise<string> {
  const rows = await siteQuery<{ till_number: string }>(
    SITE,
    'SELECT till_number FROM terminals WHERE till_number IS NOT NULL',
  )
  const taken = new Set(rows.map((r) => String(r.till_number)))
  for (let n = 99; n >= 50; n--) {
    if (!taken.has(String(n))) return String(n)
  }
  throw new Error('No free till number in 50..99 — sweep the scratch terminals.')
}

async function main() {
  await loadReasonIds()
  const stamp = Date.now().toString().slice(-8)

  /* Sweep scratch rows from a crashed earlier run, so a leftover cannot fail an
     INSERT below rather than the assertion it was making. */
  const orphans = await siteQuery<{ id: number }>(
    SITE,
    "SELECT id FROM terminals WHERE code LIKE 'TSTRET%'",
  )
  for (const o of orphans) {
    await siteExecute(SITE, 'DELETE FROM sales_documents WHERE terminal_id = ?', [o.id])
    await siteExecute(SITE, 'DELETE FROM document_sequences WHERE terminal_id = ?', [o.id])
    await siteExecute(SITE, 'DELETE FROM terminals WHERE id = ?', [o.id])
  }
  if (orphans.length) console.log(`      (swept ${orphans.length} terminal(s) from an earlier run)`)

  const vat = await siteQueryOne<any>(
    SITE,
    "SELECT id, rate FROM vat_rates WHERE vat_type='sales' AND is_default=1 LIMIT 1",
  )
  const vatRate = toNum(vat?.rate, 15)
  const cash = await getTenderByCode(SITE, 'CASH')
  if (!cash) throw new Error('This site has no CASH tender.')

  const product = await siteExecute(
    SITE,
    `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost, last_cost,
                           selling_vat_rate_id)
     VALUES (?,?,'normal','100.000','6.0000','6.0000',?)`,
    [`RT${stamp}`, `Offline return test ${stamp}`, vat?.id ?? null],
  )
  const productId = product.insertId
  await seedOpeningStock(SITE, { userId: 1, userName: 'Offline return test' })

  /* A disposable till with its own CRN sequence, so adopting numbers here cannot
     leave a real till's sequence ahead of its documents. */
  const tillNo = await freeTillNumber()
  const tillIns = await siteExecute(
    SITE,
    'INSERT INTO terminals (code, till_number, name, is_active) VALUES (?,?,?,1)',
    [`TSTRET${stamp}`, tillNo, `Offline return till ${stamp}`],
  )
  const terminalId = tillIns.insertId
  await siteExecute(
    SITE,
    `INSERT INTO document_sequences (terminal_id, doc_type, prefix, next_number, padding)
     VALUES (?, 'credit_sale', 'CRN', 1, 6)
     ON DUPLICATE KEY UPDATE doc_type = doc_type`,
    [terminalId],
  )

  const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10)
  const base = (over: Partial<OfflineReturn> = {}): OfflineReturn => ({
    returnUid: uuid(),
    documentNumber: `CRN_01_${tillNo}_${String(900 + uidCounter).padStart(6, '0')}`,
    terminalId,
    terminalCode: `TSTRET${stamp}`,
    operatorUserId: 1,
    operatorName: 'Offline cashier',
    authorisedByUserId: null,
    authorisedByName: null,
    shiftId: null,
    takenAt: new Date().toISOString(),
    documentDate: today,
    customerId: null,
    customerName: 'Walk-in',
    reasonId: RETURN_REASON_ID, note: 'Faulty on arrival',
    lines: [
      {
        productId,
        productCode: `RT${stamp}`,
        description: `Offline return test ${stamp}`,
        productType: 'normal',
        departmentId: null,
        qty: 2,
        unitPriceIncl: 23,
        vatRatePct: vatRate,
        unitCostExcl: 6,
      },
    ],
    refunds: [{ tenderTypeId: cash.id, tenderCode: 'CASH', amount: 46, reference: null }],
    claimedTotalIncl: 46,
    claimedRefundTotal: 46,
    ...over,
  })

  /* ── 1. The validator refuses only structural nonsense ──────────────────── */

  ok('a valid return is not refused', validateOfflineReturn(base()) === null)
  ok(
    'a malformed uid is refused',
    validateOfflineReturn(base({ returnUid: 'nope' })) !== null,
  )
  ok(
    'a return with no printed number is refused',
    validateOfflineReturn(base({ documentNumber: '' })) !== null,
  )
  ok('a return with no lines is refused', validateOfflineReturn(base({ lines: [] })) !== null)
  ok(
    'a missing reason is REFUSED rather than defaulted',
    validateOfflineReturn(base({ reasonId: 0 })) !== null,
  )
  // The note is optional, and always was for the reasons whose code says enough.
  // A return carrying a code and no note has to queue.
  ok(
    'a coded reason with no note is accepted',
    validateOfflineReturn(base({ reasonId: RETURN_REASON_ID, note: null })) === null,
  )
  /* The sign convention is the trap: the till sends "credit 2" and the server stores
     −2. A negative arriving here would double-negate into a second SALE. */
  ok(
    'a negative quantity is refused — it would post as a sale',
    validateOfflineReturn(base({ lines: [{ ...base().lines[0], qty: -2 }] })) !== null,
  )
  ok(
    'an empty refunds array is ALLOWED — the credit sits on the account',
    validateOfflineReturn(base({ refunds: [] })) === null,
  )
  ok(
    'a bad VAT rate is refused',
    validateOfflineReturn(base({ lines: [{ ...base().lines[0], vatRatePct: 500 }] })) !== null,
  )

  /* ── 2. A return posts, puts stock back, and keeps its printed number ───── */

  const before = await stockOf(productId)
  const ret = base()
  const posted = await postOfflineReturn(SITE, ret)
  ok('a return posts', posted.ok === true, posted.error ?? '')
  ok(
    'under the number printed on the slip',
    posted.documentNumber === ret.documentNumber,
    `${posted.documentNumber} vs ${ret.documentNumber}`,
  )

  const after = await stockOf(productId)
  ok('the stock comes back', after === before + 2, `${before} -> ${after}`)

  const doc = await siteQueryOne<any>(
    SITE,
    `SELECT doc_type, status, total_incl, reverses_id, offline_sale_uid, offline_exception
       FROM sales_documents WHERE id = ?`,
    [posted.documentId],
  )
  ok('as a finalised credit note', doc?.doc_type === 'credit_sale' && doc?.status === 'finalised')
  ok('with a NEGATIVE total', toNum(doc?.total_incl) < 0, String(doc?.total_incl))
  /* The whole scope decision, asserted: an offline return reverses nothing in
     particular, because the till cannot run the over-credit guard. */
  ok('and no invoice attached — it is a no-receipt return', doc?.reverses_id === null)
  ok('the uid is stamped on the document', doc?.offline_sale_uid === ret.returnUid)
  ok(
    'and it is flagged as taken blind',
    /no receipt/i.test(doc?.offline_exception ?? ''),
    doc?.offline_exception ?? '',
  )

  const lines = await siteQuery<any>(
    SITE,
    'SELECT qty, unit_cost_excl FROM sales_document_lines WHERE document_id = ?',
    [posted.documentId],
  )
  ok('the line qty is stored negative', toNum(lines[0]?.qty) === -2, String(lines[0]?.qty))
  /* The cost rule. Re-reading the product would value the return at today's cost and
     manufacture margin that was never earned. */
  ok(
    "the till's cost is carried, not re-read",
    toNum(lines[0]?.unit_cost_excl) === 6,
    String(lines[0]?.unit_cost_excl),
  )

  /* ── 3. Idempotency — the property that stops a double refund ───────────── */

  const stockBeforeReplay = await stockOf(productId)
  const replay = await postOfflineReturn(SITE, ret)
  ok('the same uid replays as a duplicate', replay.ok === true && replay.duplicate === true)
  ok(
    'and returns the same document',
    replay.documentId === posted.documentId,
    `${replay.documentId} vs ${posted.documentId}`,
  )
  ok(
    'the customer is NOT refunded twice',
    (await stockOf(productId)) === stockBeforeReplay,
    'stock moved on a replay',
  )
  const docCount = await siteQueryOne<any>(
    SITE,
    'SELECT COUNT(*) AS n FROM sales_documents WHERE offline_sale_uid = ?',
    [ret.returnUid],
  )
  ok('exactly one document exists for that uid', toNum(docCount?.n) === 1, String(docCount?.n))

  /* ── 4. Four concurrent requests carrying one return ────────────────────
     The measured property from the sales suite, repeated here because the failure
     mode is worse: a double-posted refund pays a customer twice. */

  const concurrent = base()
  const creditsBefore = toNum(
    (
      await siteQueryOne<any>(
        SITE,
        "SELECT COUNT(*) AS n FROM sales_documents WHERE doc_type='credit_sale' AND terminal_id = ?",
        [terminalId],
      )
    )?.n,
  )
  const stockBeforeConcurrent = await stockOf(productId)
  const settled = await Promise.all(
    Array.from({ length: 4 }, () => postOfflineReturn(SITE, concurrent).catch((e) => ({
      returnUid: concurrent.returnUid,
      ok: false,
      error: String(e?.message ?? e),
      retryable: true,
    }))),
  )
  const concurrentDocs = await siteQueryOne<any>(
    SITE,
    'SELECT COUNT(*) AS n FROM sales_documents WHERE offline_sale_uid = ?',
    [concurrent.returnUid],
  )
  ok(
    'four concurrent requests produce exactly ONE credit note',
    toNum(concurrentDocs?.n) === 1,
    `${concurrentDocs?.n} document(s), results: ${settled.map((s) => (s.ok ? 'ok' : 'no')).join(',')}`,
  )
  /* Every loser must be either a duplicate (resolved) or retryable — never a bare
     failure, which would leave the till dropping a refund it has already paid out. */
  ok(
    'and every loser is retryable or resolved, never silently dropped',
    settled.every((s: any) => s.ok || s.retryable === true),
    settled.map((s: any) => `${s.ok ? 'ok' : s.retryable ? 'retry' : 'DROPPED'}`).join(','),
  )

  /*
   * COUNTED ON THE TILL, not by uid — and this is the assertion that matters.
   *
   * The by-uid count above passed while the code was badly broken: four concurrent
   * requests really did create THREE credit notes, but two of them had
   * offline_sale_uid NULL, so a query grouped by uid could not see them. They were
   * indistinguishable from ordinary back-office credit notes — a customer refunded R46
   * with R138 on the books and nothing flagged.
   *
   * Counting every credit note on this scratch till, and the stock, catches an extra
   * document however it is (or is not) labelled.
   */
  const creditsAfter = toNum(
    (
      await siteQueryOne<any>(
        SITE,
        "SELECT COUNT(*) AS n FROM sales_documents WHERE doc_type='credit_sale' AND terminal_id = ?",
        [terminalId],
      )
    )?.n,
  )
  ok(
    '*** exactly one credit note appeared ON THE TILL, uid or not ***',
    creditsAfter === creditsBefore + 1,
    `${creditsBefore} -> ${creditsAfter} (expected +1)`,
  )
  ok(
    'and the stock moved once, not three times',
    (await stockOf(productId)) === stockBeforeConcurrent + 2,
    `${stockBeforeConcurrent} -> ${await stockOf(productId)} (expected +2)`,
  )

  /* ── 5. A locked VAT period quarantines rather than posts ───────────────── */

  const lockKey = 'vat_period_locked_to'
  const previousLock = await getSetting(SITE, lockKey)
  try {
    await setSetting(SITE, lockKey, today)
    const locked = base()
    const lockedResult = await postOfflineReturn(SITE, locked)
    ok('a return into a locked period is refused', lockedResult.ok === false)
    ok('non-retryably, because retrying changes nothing', lockedResult.retryable === false)
    ok(
      'with the reason recorded on the claim',
      /locked|closed/i.test(lockedResult.error ?? ''),
      lockedResult.error ?? '',
    )
    const claim = await siteQueryOne<any>(
      SITE,
      'SELECT status, error FROM offline_return_claims WHERE return_uid = ?',
      [locked.returnUid],
    )
    ok('and the claim marked rejected so it is visible', claim?.status === 'rejected')
    const noDoc = await siteQueryOne<any>(
      SITE,
      'SELECT COUNT(*) AS n FROM sales_documents WHERE offline_sale_uid = ?',
      [locked.returnUid],
    )
    ok('nothing reached the books', toNum(noDoc?.n) === 0, String(noDoc?.n))
  } finally {
    await setSetting(SITE, lockKey, previousLock ?? '')
  }

  /* ── 6. An operator without the capability still gets the money out ──────
     Flagged, never refused: the cash has already left the drawer, so the useful
     outcome is a manager knowing about it. */

  const unpermitted = base({ operatorUserId: 27, operatorName: 'Nomsa Dlamini' })
  const unpermittedResult = await postOfflineReturn(SITE, unpermitted)
  ok('a return by someone without permission still posts', unpermittedResult.ok === true)
  const flagged = await siteQueryOne<any>(
    SITE,
    'SELECT offline_exception FROM sales_documents WHERE id = ?',
    [unpermittedResult.documentId],
  )
  ok(
    'and is flagged for a manager',
    (flagged?.offline_exception ?? '').length > 0,
    flagged?.offline_exception ?? '',
  )

  /* ── 7. A deleted operator does not lose the refund ─────────────────────── */

  const ghost = base({ operatorUserId: 99_999_999, operatorName: 'Ghost' })
  const ghostResult = await postOfflineReturn(SITE, ghost)
  ok('a return by a deleted operator still posts', ghostResult.ok === true, ghostResult.error ?? '')
  ok(
    'and says so, so it can be attributed',
    /no longer exists/i.test(ghostResult.exception ?? ''),
    ghostResult.exception ?? '',
  )

  /* ── 8. The sequence was advanced past the adopted numbers ──────────────── */

  const seq = await siteQueryOne<any>(
    SITE,
    "SELECT next_number FROM document_sequences WHERE doc_type='credit_sale' AND terminal_id = ?",
    [terminalId],
  )
  ok(
    "the till's CRN sequence moved past every adopted number",
    toNum(seq?.next_number) > 900,
    `next_number = ${seq?.next_number}`,
  )

  /* ── 9. The site's stock still balances ─────────────────────────────────── */

  const recon = await reconcileStock(SITE)
  ok('no stock drift anywhere on the site', recon.length === 0, `${recon.length} drift(s)`)

  /* ── Clean up ───────────────────────────────────────────────────────────── */

  await siteExecute(SITE, 'DELETE FROM sales_documents WHERE terminal_id = ?', [terminalId])
  await siteExecute(SITE, 'DELETE FROM document_sequences WHERE terminal_id = ?', [terminalId])
  await siteExecute(SITE, 'DELETE FROM terminals WHERE id = ?', [terminalId])

  console.log(fails === 0 ? '\nAll offline return checks passed.' : `\n${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}

main()
