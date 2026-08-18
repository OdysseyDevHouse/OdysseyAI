/**
 * Recording the supplier's invoice against goods already received.
 *
 * ── WHAT IS ACTUALLY BEING PROTECTED ──────────────────────────────────────
 *
 * That this NEVER becomes a second posting. Receiving already raised the
 * liability — a real creditor invoice and a GL journal crediting creditors
 * control — so a second one would double what is owed and, worse, would be
 * PAID twice. Every assertion about balances below exists for that one reason.
 *
 * The feature itself is small: a delivery taken on a delivery note lands on the
 * creditor ledger under OUR GRV number, the supplier's statement quotes theirs,
 * and the two never reconcile. This writes theirs onto the row that is already
 * there.
 *
 * ── AND THAT IT REFUSES WHEN IT IS TOO LATE ───────────────────────────────
 *
 * Once anything has been paid against the invoice, the number is on a
 * remittance and the due date has been acted on. Renaming it then would orphan
 * the remittance; that case is a credit note and a re-invoice, not a rename.
 *
 *   npm run test:invoice-match
 */
import type { RowDataPacket } from 'mysql2/promise'
import { siteExecute, siteQueryOne } from '../src/lib/siteDb'
import {
  invoiceMatchState,
  matchSupplierInvoice,
} from '../src/lib/site/purchaseInvoiceMatch'
import { receiveGoods } from '../src/lib/site/purchasePosting'
import { createSupplier } from '../src/lib/site/suppliers'
import { postSupplierTransaction, reconcileSupplierBalances } from '../src/lib/site/supplierLedger'
import { defaultVat, listVatRates } from '../src/lib/site/lookups'
import { toNum } from '../src/lib/decimals'

const SITE = 1
const actor = { userId: 1, userName: 'Invoice Match Test' }
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

async function creditorRow(documentId: number) {
  return siteQueryOne<RowDataPacket & Record<string, unknown>>(
    SITE,
    `SELECT id, doc_number, doc_date, due_date, amount_gross, amount_signed, amount_outstanding
       FROM supplier_transactions
      WHERE source = 'purchase' AND source_doc_id = ? AND doc_type = 'invoice'
      ORDER BY id LIMIT 1`,
    [documentId],
  )
}

/** The stored balance — the invariant is that it equals SUM(amount_signed). */
async function supplierBalance(supplierId: number): Promise<number> {
  const row = await siteQueryOne<RowDataPacket & { balance: number }>(
    SITE, 'SELECT balance FROM suppliers WHERE id = ?', [supplierId],
  )
  return toNum(row?.balance)
}

async function creditorRowCount(supplierId: number): Promise<number> {
  const row = await siteQueryOne<RowDataPacket & { n: number }>(
    SITE,
    "SELECT COUNT(*) AS n FROM supplier_transactions WHERE supplier_id = ? AND doc_type = 'invoice'",
    [supplierId],
  )
  return Number(row?.n ?? 0)
}

async function main() {
  const stamp = Date.now().toString().slice(-8)

  const sup = await createSupplier(SITE, actor, {
    code: `MTC${stamp}`,
    name: 'Invoice Match Test Suppliers',
    paymentTermsDays: 30,
    leadTimeDays: 5,
  })
  if (!sup.ok) {
    console.log('setup failed:', sup.error)
    process.exit(1)
  }

  const p = await siteExecute(
    SITE,
    `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost, last_cost, visible_in_pos)
     VALUES (?,?,'normal',0,0,0,1)`,
    [`MT${stamp}`, `Match test item ${stamp}`],
  )
  const productId = p.insertId

  const rates = await listVatRates(SITE)
  const rate = (defaultVat(rates, 'purchase') ?? defaultVat(rates, 'sales'))?.rate ?? 15

  try {
    /* ── a delivery taken with no invoice in hand ───────────────────────── */
    console.log('\n── Received on a delivery note ──')

    const received = await receiveGoods(SITE, actor, {
      supplierId: sup.id,
      documentDate: '2026-08-10',
      // No supplierInvoiceNo at all — the whole point.
      lines: [
        {
          productId,
          description: `Match test item ${stamp}`,
          qtyOrdered: 10,
          qtyReceived: 10,
          unitCostExcl: 100,
          vatRatePct: rate,
        },
      ],
    })
    ok('the delivery posts', received.ok, received.ok ? received.documentNumber : received.error)
    if (!received.ok) throw new Error(received.error)
    const grvId = received.documentId
    const grvNumber = received.documentNumber

    const balanceAfterReceipt = await supplierBalance(sup.id)
    const rowsAfterReceipt = await creditorRowCount(sup.id)

    let row = await creditorRow(grvId)
    ok('*** receiving ALREADY raised the liability ***', !!row)
    ok('  standing on OUR grv number', row?.doc_number === grvNumber, String(row?.doc_number))

    const state = await invoiceMatchState(SITE, grvId)
    ok('  and it reports as awaiting their invoice', state?.awaitingInvoice === true,
      String(state?.awaitingInvoice))
    ok('  with nothing paid against it',
      toNum(state?.outstanding) === toNum(state?.amountGross),
      `${state?.outstanding} of ${state?.amountGross}`)

    /* ── the guards ─────────────────────────────────────────────────────── */
    console.log('\n── What is refused ──')

    ok('an empty number is refused',
      !(await matchSupplierInvoice(SITE, actor, grvId, { invoiceNo: '   ' })).ok)
    const badDate = await matchSupplierInvoice(SITE, actor, grvId, {
      invoiceNo: 'X1', invoiceDate: '10/08/2026',
    })
    ok('a malformed date is refused', !badDate.ok, badDate.ok ? 'accepted!' : badDate.error)
    ok('a document that does not exist is refused',
      !(await matchSupplierInvoice(SITE, actor, 999999999, { invoiceNo: 'X1' })).ok)

    // Somebody else's invoice already answers to this number on this account.
    await postSupplierTransaction(SITE, actor, {
      supplierId: sup.id,
      docType: 'invoice',
      amount: 50,
      docDate: '2026-08-01',
      docNumber: `TAKEN-${stamp}`,
      description: 'Another invoice on this account',
    })
    const clash = await matchSupplierInvoice(SITE, actor, grvId, {
      invoiceNo: `TAKEN-${stamp}`,
    })
    ok('*** a number already on the account is refused ***', !clash.ok,
      clash.ok ? 'accepted!' : clash.error)

    /* ── the match itself ───────────────────────────────────────────────── */
    console.log('\n── Recording their invoice ──')

    const beforeBalance = await supplierBalance(sup.id)
    const beforeRows = await creditorRowCount(sup.id)

    const matched = await matchSupplierInvoice(SITE, actor, grvId, {
      invoiceNo: `BW-${stamp}`,
      invoiceDate: '2026-08-14',
    })
    ok('it records', matched.ok, matched.ok ? matched.changed.join(', ') : matched.error)

    row = await creditorRow(grvId)
    ok('*** the row now carries THEIR number ***', row?.doc_number === `BW-${stamp}`,
      String(row?.doc_number))
    ok('  and their date', isoOf(row?.doc_date) === '2026-08-14', String(isoOf(row?.doc_date)))
    // 14 Aug + 30 days terms = 13 Sep. Aged from the invoice, not the delivery.
    ok('*** and the due date follows the INVOICE, not the delivery ***',
      isoOf(row?.due_date) === '2026-09-13', String(isoOf(row?.due_date)))

    console.log('\n── What must NOT have happened ──')
    ok('*** NO SECOND CREDITOR ROW ***',
      (await creditorRowCount(sup.id)) === beforeRows,
      `${beforeRows} -> ${await creditorRowCount(sup.id)}`)
    ok('*** THE BALANCE IS UNCHANGED ***',
      Math.abs((await supplierBalance(sup.id)) - beforeBalance) < 0.005,
      `${beforeBalance} -> ${await supplierBalance(sup.id)}`)
    ok('  the amount on the row is untouched',
      Math.abs(toNum(row?.amount_gross) - 1150) < 0.005, String(row?.amount_gross))
    ok('  and it is still owed in full',
      Math.abs(toNum(row?.amount_outstanding) - toNum(row?.amount_gross)) < 0.005,
      String(row?.amount_outstanding))

    // And the receipt itself agrees, so the list and the ledger do not disagree.
    const grvRow = await siteQueryOne<RowDataPacket & { supplier_invoice_no: string }>(
      SITE, 'SELECT supplier_invoice_no FROM purchase_documents WHERE id = ?', [grvId],
    )
    ok('the receipt records their number too',
      grvRow?.supplier_invoice_no === `BW-${stamp}`, String(grvRow?.supplier_invoice_no))

    const after = await invoiceMatchState(SITE, grvId)
    ok('*** and it no longer reports as awaiting an invoice ***',
      after?.awaitingInvoice === false, String(after?.awaitingInvoice))

    /* ── correcting a typo is still allowed ─────────────────────────────── */
    const fixed = await matchSupplierInvoice(SITE, actor, grvId, { invoiceNo: `BW-${stamp}-A` })
    ok('a typed number can still be corrected', fixed.ok, fixed.ok ? '' : fixed.error)
    row = await creditorRow(grvId)
    ok('  and the date it already had is kept',
      isoOf(row?.doc_date) === '2026-08-14', String(isoOf(row?.doc_date)))

    const same = await matchSupplierInvoice(SITE, actor, grvId, { invoiceNo: `BW-${stamp}-A` })
    ok('re-recording the same number changes nothing',
      same.ok && same.changed.length === 0, same.ok ? same.changed.join(',') : same.error)

    /* ── once paid, it is too late ──────────────────────────────────────── */
    console.log('\n── Once something has been paid ──')

    await postSupplierTransaction(SITE, actor, {
      supplierId: sup.id,
      docType: 'payment',
      amount: 500,
      docDate: '2026-08-20',
      docNumber: `PAY-${stamp}`,
      description: 'Part payment',
      autoAllocate: true,
    })

    const paidRow = await creditorRow(grvId)
    const partPaid = toNum(paidRow?.amount_outstanding) < toNum(paidRow?.amount_gross)
    if (partPaid) {
      const tooLate = await matchSupplierInvoice(SITE, actor, grvId, {
        invoiceNo: `BW-${stamp}-B`,
      })
      ok('*** a part-paid invoice will NOT be renamed ***', !tooLate.ok,
        tooLate.ok ? 'renamed!' : tooLate.error)
      ok('  and it says what to do instead',
        !tooLate.ok && /credit note/i.test(tooLate.error), tooLate.ok ? '' : tooLate.error)
      ok('  the number is unchanged', (await creditorRow(grvId))?.doc_number === `BW-${stamp}-A`,
        String((await creditorRow(grvId))?.doc_number))
    } else {
      console.log('SKIP  the payment did not allocate to this invoice')
    }

    /* ── the invariant ──────────────────────────────────────────────────── */
    console.log('\n── Invariants ──')
    // suppliers.balance must still equal SUM(amount_signed). Scoped to THIS
    // supplier: the shared database carries drift from other suites, and a
    // site-wide assertion here would fail for their reasons rather than ours.
    const drift = (await reconcileSupplierBalances(SITE)).filter((d) => d.id === sup.id)
    const allDrift = await reconcileSupplierBalances(SITE)
    ok('*** zero balance drift on this supplier ***', drift.length === 0, JSON.stringify(drift))
    ok('  (the reconcile actually ran)', Array.isArray(allDrift), `swept ${allDrift.length} drifting`)

    /* ── the trail ──────────────────────────────────────────────────────── */
    const audit = await siteQueryOne<RowDataPacket & { detail: string }>(
      SITE,
      `SELECT detail FROM purchase_document_audit
        WHERE document_id = ? AND action = 'invoice_matched' ORDER BY id LIMIT 1`,
      [grvId],
    ).catch(() => null)
    if (audit) {
      console.log('\n── The trail ──')
      ok('the match is recorded', audit.detail.includes(`BW-${stamp}`), audit.detail)
      ok('*** and says what it was called BEFORE ***',
        !!grvNumber && audit.detail.includes(grvNumber), audit.detail)
    }
  } finally {
    const supId = sup.ok ? sup.id : 0
    await siteExecute(
      SITE,
      `DELETE FROM supplier_allocations WHERE debit_txn_id IN
         (SELECT id FROM supplier_transactions WHERE supplier_id = ?)
         OR credit_txn_id IN (SELECT id FROM supplier_transactions WHERE supplier_id = ?)`,
      [supId, supId],
    ).catch(() => {})
    await siteExecute(SITE, 'DELETE FROM supplier_transactions WHERE supplier_id = ?', [supId])
      .catch(() => {})
    for (const table of [
      'purchase_document_audit',
      'purchase_order_details',
      'purchase_document_lines',
    ]) {
      await siteExecute(
        SITE,
        `DELETE FROM ${table} WHERE document_id IN
           (SELECT id FROM purchase_documents WHERE supplier_id = ?)`,
        [supId],
      ).catch(() => {})
    }
    await siteExecute(SITE, 'DELETE FROM purchase_documents WHERE supplier_id = ?', [supId])
      .catch(() => {})
    await siteExecute(SITE, 'DELETE FROM stock_movements WHERE product_id = ?', [productId])
      .catch(() => {})
    await siteExecute(SITE, 'DELETE FROM product_suppliers WHERE product_id = ?', [productId])
      .catch(() => {})
    await siteExecute(SITE, 'DELETE FROM products WHERE id = ?', [productId]).catch(() => {})

    /*
     * THE SUPPLIER ROW ITSELF, and this line is load-bearing.
     *
     * suppliers.balance is a stored running total, not a view. Deleting the
     * transactions beneath it leaves the supplier holding a balance nothing
     * adds up to — which is precisely what reconcileSupplierBalances() reports,
     * and it is a SITE-WIDE check. Leaving one behind made test:purchasing and
     * test:payment-runs fail for this suite's reasons rather than their own.
     */
    await siteExecute(SITE, 'DELETE FROM suppliers WHERE id = ?', [supId]).catch(() => {})

    const leftover = (await reconcileSupplierBalances(SITE)).filter((d) => d.id === supId)
    ok('*** no balance drift left behind for other suites ***',
      leftover.length === 0, JSON.stringify(leftover))
  }

  console.log(`\n${fails === 0 ? 'All good.' : `${fails} FAILED`}\n`)
  process.exit(fails === 0 ? 0 : 1)
}

/** DATETIME comes back as UTC — read wall-clock with getUTC*. */
function isoOf(value: unknown): string | null {
  if (!value) return null
  if (value instanceof Date) {
    const p = (n: number) => String(n).padStart(2, '0')
    return `${value.getUTCFullYear()}-${p(value.getUTCMonth() + 1)}-${p(value.getUTCDate())}`
  }
  const text = String(value)
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
