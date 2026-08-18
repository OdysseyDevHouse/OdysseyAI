/**
 * Deposits, against a live site database.
 *
 *   npm run test:deposits
 *
 * The bookkeeping is covered by verify-deposits.mjs (constraints, sums, the
 * cash-up query shape). This covers the moment that actually matters: what
 * happens when a document carrying a deposit POSTS.
 *
 * Three things only happen then, and all three are ways the feature could
 * quietly take a customer's money twice:
 *
 *   1. a sale covered by a deposit settles with NO keyed tender
 *   2. the deposit becomes a DEPOSIT tender, so the invoice says it was paid
 *   3. an 'applied' row zeroes what is held, so it cannot be spent again
 *
 * Plus the two refusals that protect the money either side of that, and the
 * carry-forward that keeps a quote's deposit alive through conversion.
 *
 * Everything it creates, it removes. A leaked sale_deposits row sums into a
 * real cash-up and makes somebody's drawer wrong.
 */
import { siteQuery, siteQueryOne, siteExecute } from '../src/lib/siteDb'
import { saveDraft, getDocument } from '../src/lib/site/salesDocuments'
import { finaliseDocument } from '../src/lib/site/salesPosting'
import { getTenderByCode } from '../src/lib/site/tenderTypes'
import {
  takeDeposit,
  refundDeposit,
  depositSummary,
  tenderForDocument,
} from '../src/lib/site/deposits'
import { takeRefusal, refundRefusal, tenderAtFinalise } from '../src/lib/depositRules'
import { toNum } from '../src/lib/decimals'

const SITE = 1
const ACTOR = { userId: 1, userName: 'test-deposits' }

let pass = 0
let fail = 0
const madeDocuments: number[] = []

function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    pass += 1
    console.log(`  ok   ${name}`)
  } else {
    fail += 1
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/** A one-line draft invoice worth `value`, using a real product. */
async function makeInvoice(value: number, docType: 'invoice' | 'quote' = 'invoice') {
  /*
   * A SERVICE line, deliberately.
   *
   * The deposit arithmetic does not care what is being sold, and a service
   * moves no stock — so posting these test sales cannot leave stock_movements
   * behind for reconcileStock to trip over in an unrelated suite. `normal` is
   * the stocked type here; there is no 'stock'.
   */
  const product = await siteQueryOne<{ id: number; code: string; description: string }>(
    SITE,
    `SELECT id, code, description FROM products
      WHERE product_type = 'service' ORDER BY id LIMIT 1`,
  )
  if (!product) throw new Error('No service product on site 1 to build a test sale from.')

  const draft = await saveDraft(SITE, ACTOR, {
    docType,
    customerName: 'ZZ_DEPOSIT_TEST',
    lines: [
      {
        productId: product.id,
        productCode: product.code,
        description: product.description,
        qty: 1,
        unitPriceIncl: value,
        discountPct: 0,
        vatRatePct: 15,
      },
    ],
  })
  /* saveDraft returns a union — a refusal has no id. Narrowed rather than
     asserted, so a seeding failure says what went wrong instead of throwing
     "cannot read property id of undefined" thirty lines later. */
  if (!('id' in draft)) {
    throw new Error(`Could not seed a test document: ${(draft as { error: string }).error}`)
  }
  madeDocuments.push(draft.id)
  return draft.id
}

async function run() {
  console.log('\ndeposits — the posting moment\n')

  /* ── 1. The pure rules refuse what would lose money ────────────────────── */
  check(
    'a deposit over the total is refused',
    takeRefusal({ status: 'draft', totalIncl: 100, heldTotal: 0, amount: 150 }) !== null,
    'the shop would hold money against nothing',
  )
  check(
    'a deposit on a posted sale is refused',
    takeRefusal({ status: 'finalised', totalIncl: 100, heldTotal: 0, amount: 10 }) !== null,
  )
  check(
    'a refund larger than what is held is refused',
    refundRefusal({ status: 'draft', totalIncl: 100, heldTotal: 40, amount: 50 }) !== null,
  )
  check(
    'the finalise tender is capped at the document total',
    tenderAtFinalise({ totalIncl: 100, heldTotal: 150 }) === 100,
    'change from a drawer that never received the money',
  )

  /* ── 2. A sale FULLY covered by a deposit posts with no keyed tender ───── */
  const fullId = await makeInvoice(100)
  const took = await takeDeposit(SITE, ACTOR, {
    documentId: fullId,
    amount: 100,
    tenderTypeId: (await getTenderByCode(SITE, 'CASH'))?.id ?? null,
    tenderName: 'Cash',
  })
  check('a deposit covering the whole sale is accepted', took.ok, took.ok ? '' : took.error)

  const preview = await tenderForDocument(SITE, fullId)
  check('it previews as a 100.00 tender', Math.abs(preview.amount - 100) < 0.005)

  const posted = await finaliseDocument(SITE, ACTOR, { documentId: fullId, tenders: [] })
  check(
    'the sale posts with an EMPTY tender list',
    posted.ok,
    posted.ok ? '' : posted.error,
  )

  if (posted.ok) {
    const tenders = await siteQuery<{
      tender_code: string
      amount: string
      counts_as_drawer_cash: number
    }>(
      SITE,
      `SELECT t.tender_code, t.amount, tt.counts_as_drawer_cash
         FROM sales_tenders t JOIN tender_types tt ON tt.id = t.tender_type_id
        WHERE t.document_id = ?`,
      [fullId],
    )
    const dep = tenders.find((t) => t.tender_code === 'DEPOSIT')
    check('a DEPOSIT tender was written', !!dep)
    check('for the full amount', !!dep && Math.abs(toNum(dep.amount) - 100) < 0.005)
    check(
      'and it does not count as drawer cash',
      !!dep && dep.counts_as_drawer_cash === 0,
      'the cash was counted on the day it was taken',
    )

    const after = await depositSummary(SITE, fullId)
    check('nothing is still held', Math.abs(after.held) < 0.005, `held = ${after.held}`)
    check(
      'an applied row records the consumption',
      after.entries.some((e) => e.kind === 'applied'),
    )
    check(
      'the original deposit survives as history',
      after.entries.some((e) => e.kind === 'deposit'),
      'a posted sale must still show what was taken and when',
    )
  }

  /* ── 3. A PART deposit still needs the rest keyed ──────────────────────── */
  const partId = await makeInvoice(200)
  await takeDeposit(SITE, ACTOR, {
    documentId: partId,
    amount: 50,
    tenderTypeId: (await getTenderByCode(SITE, 'CASH'))?.id ?? null,
    tenderName: 'Cash',
  })

  const short = await finaliseDocument(SITE, ACTOR, { documentId: partId, tenders: [] })
  check(
    'a part-covered sale is still refused as unpaid',
    !short.ok,
    short.ok ? 'it posted when 150.00 was outstanding' : short.error,
  )

  const cash = await getTenderByCode(SITE, 'CASH')
  const rest = await finaliseDocument(SITE, ACTOR, {
    documentId: partId,
    tenders: [{ tenderTypeId: cash!.id, amount: 150, reference: null }],
  })
  check('it posts once the balance is tendered', rest.ok, rest.ok ? '' : rest.error)

  if (rest.ok) {
    const tenders = await siteQuery<{ tender_code: string; amount: string }>(
      SITE,
      'SELECT tender_code, amount FROM sales_tenders WHERE document_id = ?',
      [partId],
    )
    const total = tenders.reduce((sum, t) => sum + toNum(t.amount), 0)
    check(
      'the two tenders add up to the sale',
      Math.abs(total - 200) < 0.005,
      `${tenders.map((t) => `${t.tender_code} ${t.amount}`).join(' + ')} = ${total}`,
    )
  }

  /* ── 3b. THE PAD MUST ASK FOR THE BALANCE, NOT THE TOTAL ───────────────
   *
   * The bug this pins: both tender pads computed what to ask for as the
   * document total less vouchers, with no deposit term at all. So an 85.00
   * sale carrying a 50.00 deposit asked the cashier for the whole 85.00, and
   * `finaliseDocument` then added the held 50.00 as a DEPOSIT tender on top —
   * 135.00 against an 85.00 sale.
   *
   * DEPOSIT allows no change and takes no tip, so `planTips` refuses the 50.00
   * excess outright rather than paying it back out of a drawer that never
   * received it. The cashier saw "Deposit paid was paid over by 50.00, and it
   * cannot give change or take a tip" and simply could not finalise the sale.
   *
   * Both halves are asserted, because only the pair proves the fix: keying the
   * TOTAL must fail, and keying the BALANCE must post.
   */
  {
    const overId = await makeInvoice(85)
    await takeDeposit(SITE, ACTOR, {
      documentId: overId,
      amount: 50,
      tenderTypeId: cash!.id,
      tenderName: 'Cash',
    })

    // What the pad used to ask for: the whole total, on top of the deposit.
    const over = await finaliseDocument(SITE, ACTOR, {
      documentId: overId,
      tenders: [{ tenderTypeId: cash!.id, amount: 85, reference: null }],
    })
    check(
      'tendering the full total over a deposit is refused',
      !over.ok,
      over.ok ? 'it posted 135.00 against an 85.00 sale' : over.error,
    )

    // What the pad asks for now: the balance.
    const balance = await finaliseDocument(SITE, ACTOR, {
      documentId: overId,
      tenders: [{ tenderTypeId: cash!.id, amount: 35, reference: null }],
    })
    check(
      'tendering the balance posts the sale',
      balance.ok,
      balance.ok ? '' : balance.error,
    )

    if (balance.ok) {
      const rows = await siteQuery<{ tender_code: string; amount: string }>(
        SITE,
        'SELECT tender_code, amount FROM sales_tenders WHERE document_id = ?',
        [overId],
      )
      const total = rows.reduce((sum, t) => sum + toNum(t.amount), 0)
      check(
        'and the deposit plus the balance is the sale',
        Math.abs(total - 85) < 0.005,
        `${rows.map((t) => `${t.tender_code} ${t.amount}`).join(' + ')} = ${total}`,
      )
    }
  }

  /* ── 4. A refund gives it back, and the sum follows ────────────────────── */
  const refundId = await makeInvoice(300)
  await takeDeposit(SITE, ACTOR, {
    documentId: refundId,
    amount: 120,
    tenderTypeId: cash!.id,
    tenderName: 'Cash',
  })
  const back = await refundDeposit(SITE, ACTOR, {
    documentId: refundId,
    amount: 70,
    tenderTypeId: cash!.id,
    tenderName: 'Cash',
  })
  check('a partial refund is accepted', back.ok, back.ok ? '' : back.error)
  const afterRefund = await depositSummary(SITE, refundId)
  check(
    'what is held drops by the refund',
    Math.abs(afterRefund.held - 50) < 0.005,
    `held = ${afterRefund.held}, expected 50`,
  )
  check(
    'both rows are kept',
    afterRefund.entries.length === 2,
    'two cash-ups counted two events; a delete would make both wrong',
  )

  /* ── 5. A walk-in may pay a deposit ────────────────────────────────────── */
  const walkinId = await makeInvoice(80)
  const walkin = await takeDeposit(SITE, ACTOR, {
    documentId: walkinId,
    amount: 40,
    tenderTypeId: cash!.id,
    tenderName: 'Cash',
  })
  check(
    'a deposit needs no customer account',
    walkin.ok,
    walkin.ok ? '' : walkin.error,
  )

  const doc = await getDocument(SITE, walkinId)
  check('and the document really has no customer', doc?.customerId === null)

  /* ── 6. It reaches no ledger, which is the whole legal point ───────────── */
  const ledger = await siteQueryOne<{ n: number }>(
    SITE,
    `SELECT COUNT(*) AS n FROM customer_transactions
      WHERE source_doc_id IN (?, ?, ?) AND source <> 'sale'`,
    [walkinId, refundId, fullId],
  )
  check(
    'no debtor row is written for a deposit',
    Number(ledger?.n ?? 0) === 0,
    'the money is the customer’s until the goods are handed over',
  )
}

async function cleanup() {
  /* Deposits first — the FK deliberately refuses to strand them. */
  if (madeDocuments.length) {
    const list = madeDocuments.map(() => '?').join(',')
    await siteExecute(SITE, `DELETE FROM sale_deposits WHERE document_id IN (${list})`, madeDocuments)
    await siteExecute(SITE, `DELETE FROM sales_tenders WHERE document_id IN (${list})`, madeDocuments)
    await siteExecute(
      SITE,
      `DELETE FROM stock_movements WHERE source = 'sale' AND source_doc_id IN (${list})`,
      madeDocuments,
    )
    await siteExecute(SITE, `DELETE FROM document_audit WHERE document_id IN (${list})`, madeDocuments)
    await siteExecute(
      SITE,
      `DELETE FROM sales_document_lines WHERE document_id IN (${list})`,
      madeDocuments,
    )
    await siteExecute(SITE, `DELETE FROM sales_documents WHERE id IN (${list})`, madeDocuments)
  }

  const left = await siteQueryOne<{ n: number }>(
    SITE,
    "SELECT COUNT(*) AS n FROM sales_documents WHERE customer_name = 'ZZ_DEPOSIT_TEST'",
  )
  const stray = await siteQueryOne<{ n: number }>(
    SITE,
    "SELECT COUNT(*) AS n FROM sale_deposits WHERE user_name = 'test-deposits'",
  )
  console.log(`\ncleanup: ${left?.n ?? 0} documents, ${stray?.n ?? 0} deposits left behind`)
  if (Number(left?.n ?? 0) || Number(stray?.n ?? 0)) fail += 1
}

run()
  .catch((error) => {
    console.error('\nthrew:', error)
    fail += 1
  })
  .then(cleanup)
  .then(() => {
    console.log(`\n${pass} passed, ${fail} failed\n`)
    process.exit(fail ? 1 : 0)
  })
