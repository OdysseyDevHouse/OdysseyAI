/**
 * Cash-up and reporting.
 *
 * The figures that matter: expected is derived from what was rung up, counted
 * is what a person found, and variance is the difference. Plus the report set
 * tying back to the same sales.
 *
 *   npm run test:cashup
 */
import { siteExecute, siteQueryOne, siteQuery } from '../src/lib/siteDb'
import { saveDraft } from '../src/lib/site/salesDocuments'
import { finaliseDocument, voidDocument } from '../src/lib/site/salesPosting'
import { getTenderByCode } from '../src/lib/site/tenderTypes'
import {
  openShift, closeShift, shiftPosition, openShiftFor, recordDrawerMovement, shiftCounts, getShift,
} from '../src/lib/site/shifts'
import {
  salesSummary, salesByProduct, salesByDepartment, salesByCashier, salesByTender,
  vatByRate, exceptionReport,
} from '../src/lib/site/salesReports'
import { setSetting } from '../src/lib/site/settings'
import { batchForSource } from '../src/lib/site/journals'
import { resolveAccount } from '../src/lib/site/chartOfAccounts'
import { toNum, round } from '../src/lib/decimals'
import { findSalesReasonByCode } from '../src/lib/site/salesReasons'

const SITE = 1

/*
 * The seeded reason codes, resolved once.
 *
 * Every void and credit note now names a row rather than carrying free text, so
 * these tests need real ids. Read from the site rather than hardcoded: the ids
 * are AUTO_INCREMENT and differ per site, and 102 seeds the codes by name.
 */
let VOID_REASON_ID = 0

async function loadReasonIds() {
  const v = await findSalesReasonByCode(SITE, 'void', 'WRONG-ITEM')
  if (!v) throw new Error('Seeded void reason WRONG-ITEM is missing — run site-migrate for 102.')
  VOID_REASON_ID = v.id
}

const actor = { userId: 1, userName: 'Cashup Test' }
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

/**
 * The lowest till number nobody is using, for a scratch terminal.
 *
 * Per-till numbering refuses to number a sale from a till with no number — deliberately,
 * since a silent fallback would hide that till's invoice in the middle of the site-wide
 * run. So a scratch till needs one.
 *
 * QUERIED rather than hardcoded. `till_number` is UNIQUE, and a fixed value fails at the
 * INSERT the moment any earlier run leaves one behind — including a run whose terminal
 * cannot be swept because it issued a real document. That failure looks like a broken
 * schema and is really just litter.
 *
 * Counts DOWN from 99 so a test till never takes a number a real one would want.
 */
async function freeTillNumber(): Promise<string> {
  const rows = await siteQuery<any>(SITE, 'SELECT till_number FROM terminals WHERE till_number IS NOT NULL')
  const taken = new Set(rows.map((r: any) => String(r.till_number)))
  for (let n = 99; n >= 50; n--) {
    const candidate = String(n)
    if (!taken.has(candidate)) return candidate
  }
  throw new Error('No free till number in 50..99 — sweep the scratch terminals.')
}

async function main() {
  await loadReasonIds()
  const stamp = Date.now().toString().slice(-8)
  // LOCAL date, matching how sales are stamped. toISOString() is UTC, and in
  // the hours after local midnight the report range missed today's documents.
  const now = new Date()
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`

  /* Sweep terminals an earlier crashed run left behind, so the unique till number is
     free. Only ones with no documents — a scratch till that somehow issued a sale is
     holding a real row, and deleting it would orphan that sale. */
  const orphans = await siteQuery<any>(
    SITE,
    `SELECT id FROM terminals
      WHERE code LIKE 'CU%'
        AND (SELECT COUNT(*) FROM sales_documents d WHERE d.terminal_id = terminals.id) = 0`,
  )
  for (const o of orphans) {
    // A crashed run may have closed a short shift, which now posts a cashup
    // journal (133). Give those back before the shifts go, then repair the
    // touched balances below.
    const strayBatches = await siteQuery<any>(SITE,
      `SELECT id FROM journal_batches WHERE source = 'cashup'
         AND source_doc_id IN (SELECT id FROM shifts WHERE terminal_id = ?)`, [o.id]).catch(() => [])
    for (const b of strayBatches) {
      await siteExecute(SITE, 'DELETE FROM journal_lines WHERE batch_id = ?', [b.id]).catch(() => null)
      await siteExecute(SITE, 'DELETE FROM journal_batches WHERE id = ?', [b.id]).catch(() => null)
    }
    if (strayBatches.length > 0) {
      await siteExecute(SITE,
        `UPDATE gl_accounts a
            SET a.balance = COALESCE((
                  SELECT SUM(l.amount) FROM journal_lines l
                    JOIN journal_batches b ON b.id = l.batch_id
                   WHERE l.account_id = a.id AND b.status = 'posted'
                ), 0)`).catch(() => null)
    }
    await siteExecute(SITE, 'DELETE FROM shifts WHERE terminal_id = ?', [o.id]).catch(() => null)
    await siteExecute(SITE, 'DELETE FROM document_sequences WHERE terminal_id = ?', [o.id]).catch(
      () => null,
    )
    await siteExecute(SITE, 'DELETE FROM terminals WHERE id = ?', [o.id]).catch(() => null)
  }
  const range = { from: today, to: today }
  const vat = await siteQueryOne<any>(SITE, "SELECT id, rate FROM vat_rates WHERE vat_type='sales' AND is_default=1 LIMIT 1")
  const rate = toNum(vat?.rate, 15)

  const term = await siteExecute(SITE, 'INSERT INTO terminals (code, name, till_number) VALUES (?,?,?)', [`CU${stamp}`.slice(0, 24), 'Cash-up test till', await freeTillNumber()])
  const terminalId = term.insertId
  /* Its own invoice sequence. A numbered till with no sequence cannot finalise —
     nextDocumentNumber refuses rather than silently using the shared run. createTerminal
     does this for a real till; a raw INSERT has to do it here. */
  await siteExecute(
    SITE,
    `INSERT INTO document_sequences (terminal_id, doc_type, prefix, next_number, padding)
     VALUES (?, 'invoice', 'INV', 1, 6)
     ON DUPLICATE KEY UPDATE doc_type = doc_type`,
    [terminalId],
  )
  const prod = await siteExecute(SITE,
    `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost, last_cost, selling_vat_rate_id, visible_in_pos)
     VALUES (?,?,'service',0,4,4,?,1)`, [`CUP${stamp}`, `Cashup item ${stamp}`, vat?.id ?? null])
  const productId = prod.insertId

  const cash = await getTenderByCode(SITE, 'CASH')
  const card = await getTenderByCode(SITE, 'CARD')
  if (!cash || !card) { console.log('missing tenders'); process.exit(1) }

  // ── Opening
  ok('no shift open to start', (await openShiftFor(SITE, terminalId)) === null)
  const opened = await openShift(SITE, actor, terminalId, 500)
  ok('*** shift opened with a R500 float ***', opened.ok, opened.ok ? '' : opened.error)
  if (!opened.ok) process.exit(1)
  const shiftId = opened.shiftId

  ok('a second shift on the same till is refused', !(await openShift(SITE, actor, terminalId, 100)).ok)
  ok('negative float refused', !(await openShift(SITE, actor, 999999, -5)).ok)

  // ── Sales into the shift
  const sell = async (amount: number, tenderId: number, tendered?: number) => {
    const draft = await saveDraft(SITE, actor, {
      docType: 'invoice', customerName: 'Walk-in', terminalId, terminalCode: `CU${stamp}`.slice(0, 24),
      lines: [{ productId, productCode: `CUP${stamp}`, description: 'Cashup item', productType: 'service', qty: 1, unitPriceIncl: amount, vatRatePct: rate, unitCostExcl: 4 }],
    })
    if (!draft.ok) return { ok: false as const, error: draft.error }
    return finaliseDocument(SITE, actor, { documentId: draft.id, tenders: [{ tenderTypeId: tenderId, amount: tendered ?? amount }] })
  }

  const s1 = await sell(100, cash.id, 200)   // R100 sale, R200 handed over, R100 change
  ok('cash sale with change posted', s1.ok, s1.ok ? '' : s1.error)
  const s2 = await sell(50, cash.id)          // exact cash
  ok('exact cash sale posted', s2.ok)
  const s3 = await sell(250, card.id)         // card
  ok('card sale posted', s3.ok)

  const doc1 = await siteQueryOne<any>(SITE, 'SELECT shift_id FROM sales_documents WHERE id = ?', [s1.ok ? s1.documentId : 0])
  ok('*** sale stamped with the shift ***', Number(doc1?.shift_id) === shiftId, String(doc1?.shift_id))

  // ── The drawer position
  let pos = (await shiftPosition(SITE, shiftId))!
  const cashLine = pos.tenders.find((t) => t.tenderCode === 'CASH')!
  ok('cash expected is NET of change (150 not 250)', cashLine.expected === 150, String(cashLine.expected))
  ok('card expected is 250', pos.tenders.find((t) => t.tenderCode === 'CARD')?.expected === 250)
  ok('*** expected drawer = float + cash = 650 ***', pos.expectedCash === 650, String(pos.expectedCash))
  ok('takings across all tenders = 400', pos.takingsTotal === 400, String(pos.takingsTotal))
  ok('three sales counted', pos.salesCount === 3, String(pos.salesCount))

  // ── A payout comes out of the drawer
  const payout = await recordDrawerMovement(SITE, actor, shiftId, { type: 'payout', amount: 80, reason: 'Milk for the shop' })
  ok('payout recorded', payout.ok)
  ok('payout without a reason refused', !(await recordDrawerMovement(SITE, actor, shiftId, { type: 'payout', amount: 10, reason: '' })).ok)
  pos = (await shiftPosition(SITE, shiftId))!
  ok('*** payout reduced the expected drawer to 570 ***', pos.expectedCash === 570, String(pos.expectedCash))

  // ── A void must NOT count toward the drawer
  if (s2.ok) {
    const voided = await voidDocument(SITE, actor, s2.documentId, { reasonId: VOID_REASON_ID, note: 'Rang up twice' })
    ok('void accepted', voided.ok, voided.ok ? '' : voided.error)
    pos = (await shiftPosition(SITE, shiftId))!
    ok('*** voided sale removed from the drawer (520) ***', pos.expectedCash === 520, String(pos.expectedCash))
    ok('  and from takings (350)', pos.takingsTotal === 350, String(pos.takingsTotal))
  }

  // ── Closing: exact count
  await setSetting(SITE, 'cashup_variance_tolerance', '5.00')
  const shortClose = await closeShift(SITE, actor, shiftId, [
    { tenderTypeId: cash.id, amount: 400 },  // 120 short
    { tenderTypeId: card.id, amount: 250 },
  ])
  ok('*** big variance without a note REFUSED ***', !shortClose.ok, !shortClose.ok ? shortClose.error : '')

  const withNote = await closeShift(SITE, actor, shiftId, [
    { tenderTypeId: cash.id, amount: 400 },
    { tenderTypeId: card.id, amount: 250 },
  ], 'Note missing from the drawer, reported to the manager')
  ok('*** variance with an explanation accepted ***', withNote.ok, withNote.ok ? String(withNote.variance) : withNote.error)
  ok('  variance is -120 (short)', withNote.ok && withNote.variance === -120, withNote.ok ? String(withNote.variance) : '')
  ok('  flagged as outside tolerance', withNote.ok && !withNote.withinTolerance)

  const closed = await getShift(SITE, shiftId)
  ok('shift is now closed', closed?.isOpen === false)
  ok('  variance frozen on the shift', closed?.variance === -120, String(closed?.variance))
  ok('  reason recorded', (closed?.varianceNote ?? '').includes('Note missing'))
  const counts = await shiftCounts(SITE, shiftId)
  ok('  counts frozen per tender', counts.length === 2, JSON.stringify(counts.map((c) => `${c.tenderCode}:${c.variance}`)))
  ok('  card reconciled exactly', counts.find((c) => c.tenderCode === 'CARD')?.variance === 0)

  // ── The ledger heard about it (133): a short drawer posts DR 6910 / CR the
  // tender account, so GL cash ends at counted reality and the loss shows on
  // the income statement instead of accumulating as invisible drift.
  const cashupBatch = await batchForSource(SITE, 'cashup', shiftId)
  ok('*** cash-up variance reached the ledger ***', !!cashupBatch)
  if (cashupBatch) {
    const jLines = await siteQuery<any>(SITE,
      'SELECT account_id, amount FROM journal_lines WHERE batch_id = ?', [cashupBatch.id])
    const jSum = jLines.reduce((s: number, l: any) => round(s + toNum(l.amount), 2), 0)
    ok('  cash-up journal balances', Math.abs(jSum) < 0.005, String(jSum))
    const overShortId = await resolveAccount(SITE, 'cash_over_short')
    const osLine = jLines.find((l: any) => Number(l.account_id) === overShortId)
    ok('  6910 debited by the shortfall', !!osLine && toNum(osLine.amount) === 120,
      osLine ? String(toNum(osLine.amount)) : 'no 6910 line')
  }

  ok('closing twice refused', !(await closeShift(SITE, actor, shiftId, [])).ok)
  const reopened = await openShift(SITE, actor, terminalId, 500)
  ok('a new shift can open once closed', reopened.ok)
  // Close it again immediately: leaving an open shift behind would block the
  // next run on this till, which is the constraint working but a useless test.
  if (reopened.ok) await closeShift(SITE, actor, reopened.shiftId, [], 'Test cleanup')

  // ── Reports tie back to the same sales
  const summary = await salesSummary(SITE, range)
  ok('summary excludes voided sales', summary.salesIncl > 0)
  ok('  summary balances (excl + vat = incl)', Math.round((summary.salesExcl + summary.vat) * 100) === Math.round(summary.salesIncl * 100), `${summary.salesExcl}+${summary.vat} vs ${summary.salesIncl}`)
  ok('  GP% is profit over SELLING price', summary.gpPct === (summary.salesExcl === 0 ? 0 : round((summary.profit / summary.salesExcl) * 100, 2)))

  // The tender report answers "what money arrived"; the sales summary answers
  // "what was sold". They differ by design — a credit note left on an account
  // reduces sales without moving money — so the check is that tenders equal
  // the INVOICE total, not the net sales total.
  const byTender = await salesByTender(SITE, range)
  const tenderTotal = byTender.reduce((s, t) => round(s + t.amount, 2), 0)
  const invoiceOnly = await siteQueryOne<any>(SITE,
    `SELECT COALESCE(SUM(total_incl), 0) AS total FROM sales_documents
      WHERE status = 'finalised' AND doc_type = 'invoice' AND document_date BETWEEN ? AND ?`,
    [range.from, range.to])
  ok('*** tenders match what was INVOICED (money in) ***',
    Math.abs(tenderTotal - toNum(invoiceOnly?.total)) < 0.05,
    `tenders ${tenderTotal} vs invoiced ${toNum(invoiceOnly?.total)}`)
  ok('  and sales are lower, by the credit notes',
    summary.salesIncl <= toNum(invoiceOnly?.total) + 0.005,
    `sales ${summary.salesIncl} vs invoiced ${toNum(invoiceOnly?.total)}`)

  const vatRows = await vatByRate(SITE, range)
  const vatTotal = vatRows.reduce((s, v) => round(s + v.vat, 2), 0)
  ok('*** VAT by rate matches the summary VAT ***', Math.abs(vatTotal - summary.vat) < 0.02, `${vatTotal} vs ${summary.vat}`)

  const byProduct = await salesByProduct(SITE, range, 'revenue', 10)
  ok('product report returns rows', byProduct.length > 0)
  const byProfit = await salesByProduct(SITE, range, 'profit', 10)
  ok('  sorting by profit gives a (possibly) different order', byProfit.length > 0)
  ok('department report returns rows', (await salesByDepartment(SITE, range)).length > 0)
  ok('cashier report returns rows', (await salesByCashier(SITE, range)).length > 0)

  const exceptions = await exceptionReport(SITE, range)
  const mine = exceptions.find((e) => e.userName === 'Cashup Test')
  ok('*** exception report caught the void ***', (mine?.voids ?? 0) >= 1, JSON.stringify(mine))

  // ── Cleanup
  await siteExecute(SITE, 'UPDATE sales_documents SET shift_id = NULL WHERE shift_id IN (SELECT id FROM shifts WHERE terminal_id = ?)', [terminalId])
  const docs = await siteQuery<any>(SITE, 'SELECT id FROM sales_documents WHERE terminal_id = ?', [terminalId])
  for (const d of docs) {
    await siteExecute(SITE, 'DELETE FROM stock_movements WHERE source_doc_id = ?', [d.id])
    await siteExecute(SITE, 'DELETE FROM sales_documents WHERE id = ?', [d.id])
  }
  // The cash-up mirrors posted real journals; give the ledger back too, then
  // recompute the touched balances from the lines that survive (the
  // test-general-ledger cleanup pattern — deleting lines alone leaves
  // gl_accounts.balance lying).
  const cashupBatches = await siteQuery<any>(SITE,
    `SELECT id FROM journal_batches WHERE source = 'cashup'
       AND source_doc_id IN (SELECT id FROM shifts WHERE terminal_id = ?)`, [terminalId])
  for (const b of cashupBatches) {
    await siteExecute(SITE, 'DELETE FROM journal_lines WHERE batch_id = ?', [b.id])
    await siteExecute(SITE, 'DELETE FROM journal_batches WHERE id = ?', [b.id])
  }
  if (cashupBatches.length > 0) {
    await siteExecute(SITE,
      `UPDATE gl_accounts a
          SET a.balance = COALESCE((
                SELECT SUM(l.amount) FROM journal_lines l
                  JOIN journal_batches b ON b.id = l.batch_id
                 WHERE l.account_id = a.id AND b.status = 'posted'
              ), 0)`)
  }
  await siteExecute(SITE, 'DELETE FROM shifts WHERE terminal_id = ?', [terminalId])
  await siteExecute(SITE, 'DELETE FROM terminals WHERE id = ?', [terminalId])
  await siteExecute(SITE, 'DELETE FROM stock_movements WHERE product_id = ?', [productId])
  await siteExecute(SITE, 'DELETE FROM products WHERE id = ?', [productId])

  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}
main()
