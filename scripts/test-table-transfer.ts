/**
 * Moving a whole tab between tables, and the pro-forma bill.
 *
 * The rules that matter:
 *
 *   A TRANSFER KEEPS THE DOCUMENT'S IDENTITY. The bill's id, lines and totals
 *   are untouched — only the pos_tables pointer moves. A split mints a new
 *   document; a transfer must not, or the tab's history dies with the move.
 *
 *   OCCUPIED MEANS "HAS AN OPEN BILL", NOT "HAS A POINTER". A table settled an
 *   hour ago keeps its stale pointer, and refusing it would strand a party.
 *
 *   THE PRO-FORMA BILL IS NOT A TAX INVOICE. No number, flagged pro-forma, and
 *   its totals must equal the document engine's own arithmetic exactly.
 */

import { transferTableBill } from '../src/lib/site/posSplit'
import { saveDraft, saveForLaterDocument, getDocument } from '../src/lib/site/salesDocuments'
import { seatTable, listTables } from '../src/lib/site/posTables'
import { billDataFor } from '../src/lib/billData'
import { documentTotals, lineTotals } from '../src/lib/documentMath'
import { siteExecute, siteQuery, siteQueryOne } from '../src/lib/siteDb'

const SITE = 1
const actor = { userId: 1, userName: 'Transfer Test' }

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

const stamp = Date.now().toString().slice(-6)
const tableIds: number[] = []
const docIds: number[] = []

async function makeTable(code: string, isActive = 1): Promise<number> {
  const res = await siteExecute(
    SITE,
    `INSERT INTO pos_tables (code, is_active) VALUES (?, ?)`,
    [code, isActive],
  )
  tableIds.push(res.insertId)
  return res.insertId
}

async function makeTab(tableId: number, amount: number): Promise<number> {
  const draft = await saveDraft(SITE, actor, {
    docType: 'invoice',
    customerName: 'Table',
    lines: [
      { description: `Test dish ${stamp}`, qty: 2, unitPriceIncl: amount / 2, vatRatePct: 15 },
    ],
  })
  if (!draft.ok) throw new Error(`draft refused: ${draft.error}`)
  docIds.push(draft.id)
  const parked = await saveForLaterDocument(SITE, draft.id)
  if (!parked.ok) throw new Error(`park refused: ${parked.error}`)
  const seated = await seatTable(SITE, tableId, draft.id)
  if (!seated.ok) throw new Error(`seat refused: ${seated.error}`)
  return draft.id
}

async function pointerOf(tableId: number): Promise<number | null> {
  const row = await siteQueryOne<{ document_id: unknown }>(
    SITE,
    'SELECT document_id FROM pos_tables WHERE id = ?',
    [tableId],
  )
  return row?.document_id === null ? null : Number(row?.document_id)
}

async function main() {
  console.log('\n── A transfer moves the pointer, not the document ──────────\n')

  const t1 = await makeTable(`TT1${stamp}`)
  const t2 = await makeTable(`TT2${stamp}`)
  const t3 = await makeTable(`TT3${stamp}`)
  const closed = await makeTable(`TTX${stamp}`, 0)

  const doc = await makeTab(t1, 230)
  const before = await getDocument(SITE, doc)

  const moved = await transferTableBill(SITE, actor, { fromTableId: t1, toTableId: t2 })
  ok('the transfer succeeds', moved.ok, moved.ok ? '' : moved.error)
  ok('*** the document kept its id ***', moved.ok && moved.documentId === doc)
  ok('the source table is freed', (await pointerOf(t1)) === null)
  ok('the destination holds the bill', (await pointerOf(t2)) === doc)

  const after = await getDocument(SITE, doc)
  ok('*** the lines are byte-for-byte untouched ***',
      JSON.stringify(before?.lines) === JSON.stringify(after?.lines))
  ok('the totals are untouched', before?.totalIncl === after?.totalIncl)
  ok('still a saved bill, not a new document', after?.status === 'saved')

  const audit = await siteQuery<{ action: string; detail: string }>(
    SITE,
    `SELECT action, detail FROM document_audit WHERE document_id = ? AND action = 'transferred'`,
    [doc],
  )
  ok('*** the move left a trail ***', audit.length === 1, JSON.stringify(audit))
  ok('…that names both tables',
      audit[0]?.detail.includes(`TT1${stamp}`) && audit[0]?.detail.includes(`TT2${stamp}`))

  console.log('\n── What a transfer refuses ─────────────────────────────────\n')

  const same = await transferTableBill(SITE, actor, { fromTableId: t2, toTableId: t2 })
  ok('same table refused', !same.ok)

  const empty = await transferTableBill(SITE, actor, { fromTableId: t1, toTableId: t3 })
  ok('a free source has nothing to move', !empty.ok)

  const doc3 = await makeTab(t3, 100)
  const occupied = await transferTableBill(SITE, actor, { fromTableId: t2, toTableId: t3 })
  ok('*** an occupied destination is refused — merging is not offered ***', !occupied.ok)
  ok('…and the message names the table',
      !occupied.ok && occupied.error.includes(`TT3${stamp}`), occupied.ok ? '' : occupied.error)

  const inactive = await transferTableBill(SITE, actor, { fromTableId: t2, toTableId: closed })
  ok('a deactivated table is refused', !inactive.ok)

  /* A SETTLED destination is free: cancel t3's bill (a test shortcut for "it was
     paid") and the stale pointer must not block the move. */
  await siteExecute(SITE, `UPDATE sales_documents SET status = 'cancelled' WHERE id = ?`, [doc3])
  const ontoSettled = await transferTableBill(SITE, actor, { fromTableId: t2, toTableId: t3 })
  ok('*** a stale pointer to a settled bill does not block the destination ***',
      ontoSettled.ok, ontoSettled.ok ? '' : ontoSettled.error)
  ok('the bill now sits on the once-settled table', (await pointerOf(t3)) === doc)

  console.log('\n── The floor reads it back ─────────────────────────────────\n')

  const floor = await listTables(SITE)
  const dest = floor.find((t) => t.id === t3)
  ok('the destination reads as occupied', dest?.state !== 'free', dest?.state)
  ok('…with the bill total on the tile', dest?.totalIncl === 230, String(dest?.totalIncl))

  console.log('\n── The pro-forma bill matches the engine ───────────────────\n')

  const billDoc = await getDocument(SITE, doc)
  if (!billDoc) throw new Error('bill document vanished')
  const bill = billDataFor(billDoc, { name: 'Test Shop', vatNumber: '4123456789' }, {
    printedAt: '2026-08-14 12:00',
  })

  const engine = documentTotals(
    billDoc.lines.map((l) => ({
      ...lineTotals({
        qty: l.qty,
        unitPriceIncl: l.unitPriceIncl,
        discountPct: l.discountPct,
        vatRatePct: l.vatRatePct,
      }),
      vatRatePct: l.vatRatePct,
    })),
  )
  ok('*** the bill total equals documentTotals exactly ***', bill.totalIncl === engine.totalIncl,
      `${bill.totalIncl} vs ${engine.totalIncl}`)
  ok('excl + VAT = incl', bill.subtotalExcl + bill.vatTotal === bill.totalIncl)
  ok('*** flagged pro-forma ***', bill.proForma === true)
  ok('the VAT split carries the 15% band',
      bill.vatByRate.some((r) => r.ratePct === 15 && r.vat > 0))
  ok('the tab label rides along', bill.label.length > 0, bill.label)

  console.log('\n── Cleanup ────────────────────────────────────────────────\n')

  for (const id of tableIds) {
    await siteExecute(SITE, 'UPDATE pos_tables SET document_id = NULL WHERE id = ?', [id])
    await siteExecute(SITE, 'DELETE FROM pos_tables WHERE id = ?', [id])
  }
  for (const id of docIds) {
    await siteExecute(SITE, 'DELETE FROM document_audit WHERE document_id = ?', [id])
    await siteExecute(SITE, 'DELETE FROM sales_document_lines WHERE document_id = ?', [id])
    await siteExecute(SITE, 'DELETE FROM sales_documents WHERE id = ?', [id])
  }
  // Saved bills carry no document number, so no sequence was consumed.
  const leftTables = await siteQuery(SITE, 'SELECT id FROM pos_tables WHERE code LIKE ?', [
    `TT%${stamp}`,
  ])
  const leftDocs = docIds.length
    ? await siteQuery(
        SITE,
        `SELECT id FROM sales_documents WHERE id IN (${docIds.map(() => '?').join(',')})`,
        docIds,
      )
    : []
  ok('test data cleaned up', leftTables.length === 0 && leftDocs.length === 0,
      `${leftTables.length} tables, ${leftDocs.length} docs left`)

  console.log(fails === 0 ? '\nAll table-transfer rules hold.\n' : `\n${fails} FAILURE(S)\n`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
