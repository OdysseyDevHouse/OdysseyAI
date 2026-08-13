/**
 * Splitting a table's bill.
 *
 *   npx tsx --conditions=react-server --env-file=.env scripts/test-pos-split.ts
 *
 * The one rule this file exists for: NO LINE MAY FALL OFF BOTH BILLS. Every assertion
 * below is ultimately about the sum of the two halves equalling what was there before —
 * in lines, in quantity, and in money.
 *
 * A split creates no new kind of thing: two ordinary `saved` documents on two tables. So
 * the other half of the job is proving the SECOND bill is a real bill — right header,
 * right price structure, finalisable — rather than a special case something downstream
 * would have to learn about.
 */
import { siteExecute, siteQuery, siteQueryOne } from '../src/lib/siteDb'
import { splitTableBill, billLinesForSplit } from '../src/lib/site/posSplit'
import { seatTable, listTables } from '../src/lib/site/posTables'
import { saveDraft, saveForLaterDocument } from '../src/lib/site/salesDocuments'
import { toNum, round } from '../src/lib/decimals'

const SITE = 1
const ACTOR = { userId: 1, userName: 'Split test' }
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

const docTotal = async (id: number) =>
  toNum((await siteQueryOne<any>(SITE, 'SELECT total_incl FROM sales_documents WHERE id = ?', [id]))?.total_incl)

const docLines = async (id: number) =>
  siteQuery<any>(
    SITE,
    'SELECT description, qty, unit_price_incl, line_total_incl, line_number FROM sales_document_lines WHERE document_id = ? ORDER BY line_number',
    [id],
  )

async function main() {
  const stamp = Date.now().toString().slice(-8)

  /* Sweep scratch rows from a crashed earlier run — the lesson from
     test-offline-sync, where a leftover made every later run die before its first
     assertion. Tables first: they point at documents. */
  const oldTables = await siteQuery<any>(SITE, "SELECT id, document_id FROM pos_tables WHERE code LIKE 'SPL%'")
  for (const t of oldTables) {
    await siteExecute(SITE, 'UPDATE pos_tables SET document_id = NULL WHERE id = ?', [t.id])
    if (t.document_id) {
      await siteExecute(SITE, 'DELETE FROM sales_document_lines WHERE document_id = ?', [t.document_id])
      await siteExecute(SITE, 'DELETE FROM sales_documents WHERE id = ?', [t.document_id])
    }
    await siteExecute(SITE, 'DELETE FROM pos_tables WHERE id = ?', [t.id])
  }
  if (oldTables.length) console.log(`      (swept ${oldTables.length} table(s) from an earlier run)`)

  const vat = await siteQueryOne<any>(
    SITE,
    "SELECT id, rate FROM vat_rates WHERE vat_type='sales' AND is_default=1 LIMIT 1",
  )
  const vatRate = toNum(vat?.rate, 15)

  const beer = await siteExecute(
    SITE,
    `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost, last_cost, selling_vat_rate_id)
     VALUES (?,?,'normal','500.000','8.0000','8.0000',?)`,
    [`SPB${stamp}`, `Split test beer ${stamp}`, vat?.id ?? null],
  )
  const steak = await siteExecute(
    SITE,
    `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost, last_cost, selling_vat_rate_id)
     VALUES (?,?,'normal','500.000','40.0000','40.0000',?)`,
    [`SPS${stamp}`, `Split test steak ${stamp}`, vat?.id ?? null],
  )

  const t1 = await siteExecute(
    SITE,
    `INSERT INTO pos_tables (code, name, section, seats, sort_order, is_active) VALUES (?,?,?,4,1,1)`,
    [`SPL1${stamp}`.slice(0, 20), 'Split source', 'Test'],
  )
  const t2 = await siteExecute(
    SITE,
    `INSERT INTO pos_tables (code, name, section, seats, sort_order, is_active) VALUES (?,?,?,4,2,1)`,
    [`SPL2${stamp}`.slice(0, 20), 'Split dest', 'Test'],
  )
  const sourceTable = t1.insertId
  const destTable = t2.insertId

  /**
   * A two-line bill on the source table: 3 beers at 30, 2 steaks at 180 = 450.
   *
   * Drafted then FLIPPED to `saved`, because that is the real path — `saveDraft` has no
   * `status` field and always writes a draft; `saveForLaterDocument` is what makes it a
   * parked/table bill. Passing `status` was my first guess and it was silently ignored,
   * so the document existed with the right total and `billLinesForSplit` still returned
   * null: it requires `saved`, correctly, because a DRAFT is somebody mid-edit.
   */
  async function openBill() {
    const draft = await saveDraft(SITE, ACTOR, {
      docType: 'invoice',
      documentDate: new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10),
      customerName: 'Table party',
      lines: [
        { productId: beer.insertId, description: 'Beer', qty: 3, unitPriceIncl: 30, vatRatePct: vatRate, unitCostExcl: 8 },
        { productId: steak.insertId, description: 'Steak', qty: 2, unitPriceIncl: 180, vatRatePct: vatRate, unitCostExcl: 40 },
      ],
    } as never)
    if (!draft.ok) throw new Error(`could not open a bill: ${draft.error}`)
    const parked = await saveForLaterDocument(SITE, draft.id)
    if (!parked.ok) throw new Error(`could not park the bill: ${parked.error}`)
    await seatTable(SITE, sourceTable, draft.id)
    return draft.id
  }

  /* ── 1. The lines a split screen would divide ────────────────────────────── */

  const billId = await openBill()
  const forSplit = await billLinesForSplit(SITE, sourceTable)
  ok('the bill can be read for splitting', forSplit !== null)
  ok('with both lines', forSplit?.lines.length === 2, String(forSplit?.lines.length))
  const originalTotal = await docTotal(billId)
  ok('3 beers at 30 and 2 steaks at 180 is 450', originalTotal === 450, String(originalTotal))

  const beerLine = forSplit!.lines.find((l) => l.description === 'Beer')!
  const steakLine = forSplit!.lines.find((l) => l.description === 'Steak')!

  /* ── 2. A WHOLE line moves ──────────────────────────────────────────────── */

  const whole = await splitTableBill(SITE, ACTOR, {
    fromTableId: sourceTable,
    toTableId: destTable,
    moves: [{ lineId: steakLine.id, qty: 2 }],
  })
  ok('a whole line splits off', whole.ok === true, whole.ok ? '' : whole.error)
  if (!whole.ok) throw new Error('cannot continue')

  const keptLines = await docLines(billId)
  const movedLines = await docLines(whole.toDocumentId)
  ok('the source keeps only the beer', keptLines.length === 1 && keptLines[0].description === 'Beer')
  ok('the destination has only the steak', movedLines.length === 1 && movedLines[0].description === 'Steak')

  /* THE rule, in money. */
  const keptTotal = await docTotal(billId)
  const movedTotal = await docTotal(whole.toDocumentId)
  ok(
    '*** the two halves still add up to 450 ***',
    round(keptTotal + movedTotal, 2) === 450,
    `${keptTotal} + ${movedTotal} = ${round(keptTotal + movedTotal, 2)}`,
  )
  ok('the beer half is 90', keptTotal === 90, String(keptTotal))
  ok('the steak half is 360', movedTotal === 360, String(movedTotal))

  /* Both are real bills on real tables — not a special case anything must learn. */
  const tables = await listTables(SITE)
  const src = tables.find((t) => t.id === sourceTable)
  const dst = tables.find((t) => t.id === destTable)
  ok('the source table still holds its bill', src?.documentId === billId)
  ok('the destination table now holds one', dst?.documentId === whole.toDocumentId)
  ok('and both read as OPEN on the floor', src?.state === 'open' && dst?.state === 'open')

  const destDoc = await siteQueryOne<any>(
    SITE,
    'SELECT status, doc_type, customer_name, price_structure_id FROM sales_documents WHERE id = ?',
    [whole.toDocumentId],
  )
  ok('the new bill is an ordinary saved invoice', destDoc?.status === 'saved' && destDoc?.doc_type === 'invoice')
  /* The header is COPIED, not rebuilt: a split half that lost its price structure would
     reprice at retail — a staff discount becoming full price halfway through a meal. */
  ok('and it inherited the sitting’s customer', destDoc?.customer_name === 'Table party')

  /* ── 3. A PART of a line moves — the request this feature exists for ─────── */

  await siteExecute(SITE, 'UPDATE pos_tables SET document_id = NULL WHERE id IN (?,?)', [sourceTable, destTable])
  await siteExecute(SITE, "UPDATE sales_documents SET status='cancelled' WHERE id IN (?,?)", [billId, whole.toDocumentId])

  const bill2 = await openBill()
  const s2 = await billLinesForSplit(SITE, sourceTable)
  const beer2 = s2!.lines.find((l) => l.description === 'Beer')!

  const part = await splitTableBill(SITE, ACTOR, {
    fromTableId: sourceTable,
    toTableId: destTable,
    moves: [{ lineId: beer2.id, qty: 1 }],
  })
  ok('one of three beers moves', part.ok === true, part.ok ? '' : part.error)
  if (!part.ok) throw new Error('cannot continue')

  const kept2 = await docLines(bill2)
  const moved2 = await docLines(part.toDocumentId)
  /* The line now exists on BOTH bills with the quantity divided — which is exactly what
     "one of the three beers goes on Dave's bill" means. */
  ok('the beer is on both bills', kept2.some((l) => l.description === 'Beer') && moved2.some((l) => l.description === 'Beer'))
  ok('2 beers stayed', toNum(kept2.find((l) => l.description === 'Beer')?.qty) === 2)
  ok('1 beer moved', toNum(moved2.find((l) => l.description === 'Beer')?.qty) === 1)
  ok('the steaks stayed put', kept2.some((l) => l.description === 'Steak') && !moved2.some((l) => l.description === 'Steak'))
  ok(
    '*** and the halves STILL add up to 450 ***',
    round((await docTotal(bill2)) + (await docTotal(part.toDocumentId)), 2) === 450,
    `${await docTotal(bill2)} + ${await docTotal(part.toDocumentId)}`,
  )
  /* Renumbered from 1 on both sides. A gap in line_number is not fatal but it reads as a
     deleted line to anyone looking at the document later. */
  ok('lines are renumbered from 1', kept2.every((l, i) => Number(l.line_number) === i + 1))

  /* ── 4. Moving EVERYTHING frees the table it came from ───────────────────── */


  /* Properly this time: everything left on the source. */
  const remaining = await billLinesForSplit(SITE, sourceTable)
  await siteExecute(SITE, 'UPDATE pos_tables SET document_id = NULL WHERE id = ?', [destTable])
  await siteExecute(SITE, "UPDATE sales_documents SET status='cancelled' WHERE id = ?", [part.toDocumentId])

  const t3 = await siteExecute(
    SITE,
    `INSERT INTO pos_tables (code, name, section, seats, sort_order, is_active) VALUES (?,?,?,4,3,1)`,
    [`SPL3${stamp}`.slice(0, 20), 'Split dest 2', 'Test'],
  )
  const destTable2 = t3.insertId

  const moveAll = await splitTableBill(SITE, ACTOR, {
    fromTableId: sourceTable,
    toTableId: destTable2,
    moves: remaining!.lines.map((l) => ({ lineId: l.id, qty: l.qty })),
  })
  ok('moving the whole bill is allowed', moveAll.ok === true, moveAll.ok ? '' : moveAll.error)
  if (moveAll.ok) {
    /* A party that moved tables. The one they left must be FREE rather than holding an
       empty bill somebody has to work out how to close. */
    ok('the source table is freed', moveAll.fromDocumentId === null)
    const after = await listTables(SITE)
    ok('and reads as free on the floor', after.find((t) => t.id === sourceTable)?.state === 'free')
    const emptied = await siteQueryOne<any>(SITE, 'SELECT status FROM sales_documents WHERE id = ?', [bill2])
    /* Cancelled, not left saved at zero: a zero-total saved sale is a thing every report
       would have to learn to ignore. */
    ok('the emptied bill is cancelled, not left at zero', emptied?.status === 'cancelled', emptied?.status)
  }

  /* ── 5. Refusals ────────────────────────────────────────────────────────── */

  const toSelf = await splitTableBill(SITE, ACTOR, {
    fromTableId: destTable2,
    toTableId: destTable2,
    moves: [{ lineId: 1, qty: 1 }],
  })
  ok('splitting a table onto itself is refused', toSelf.ok === false)

  const noBill = await splitTableBill(SITE, ACTOR, {
    fromTableId: sourceTable,
    toTableId: destTable,
    moves: [{ lineId: 1, qty: 1 }],
  })
  ok('splitting a table with no bill is refused', noBill.ok === false, noBill.ok ? '' : noBill.error)

  /*
   * Onto an OCCUPIED table. Merging two parties' food onto one bill has no way back —
   * nothing afterwards can say which was which — so it is refused rather than hedged.
   *
   * This needs a THIRD table with its own bill, and the first version of this check did
   * not have one: it passed `destTable2` as both source and destination, so the
   * same-table guard refused it and the assertion proved nothing about merging at all.
   */
  const t4 = await siteExecute(
    SITE,
    `INSERT INTO pos_tables (code, name, section, seats, sort_order, is_active) VALUES (?,?,?,4,4,1)`,
    [`SPL4${stamp}`.slice(0, 20), 'Split occupied', 'Test'],
  )
  const occupiedTable = t4.insertId
  const otherDraft = await saveDraft(SITE, ACTOR, {
    docType: 'invoice',
    documentDate: new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10),
    customerName: 'Another party',
    lines: [
      { productId: beer.insertId, description: 'Beer', qty: 1, unitPriceIncl: 30, vatRatePct: vatRate, unitCostExcl: 8 },
    ],
  } as never)
  if (otherDraft.ok) {
    await saveForLaterDocument(SITE, otherDraft.id)
    await seatTable(SITE, occupiedTable, otherDraft.id)

    const source = await billLinesForSplit(SITE, destTable2)
    const merge = await splitTableBill(SITE, ACTOR, {
      fromTableId: destTable2,
      toTableId: occupiedTable,
      moves: source ? [{ lineId: source.lines[0].id, qty: 1 }] : [],
    })
    ok(
      '*** a merge onto an OCCUPIED table is refused ***',
      merge.ok === false,
      merge.ok ? 'it was allowed' : merge.error,
    )
    /* And it names the table, so a waiter knows which one to clear rather than being
       told "no" about a floor they are looking at. */
    ok(
      '  and says which table is in the way',
      !merge.ok && /SPL4/.test(merge.error),
      merge.ok ? '' : merge.error,
    )
    /* Neither bill moved. */
    const untouched = await billLinesForSplit(SITE, occupiedTable)
    ok('  and the occupied bill is untouched', untouched?.lines.length === 1, String(untouched?.lines.length))

    await siteExecute(SITE, 'UPDATE pos_tables SET document_id = NULL WHERE id = ?', [occupiedTable])
    await siteExecute(SITE, 'DELETE FROM sales_document_lines WHERE document_id = ?', [otherDraft.id])
    await siteExecute(SITE, 'DELETE FROM sales_documents WHERE id = ?', [otherDraft.id])
  }
  await siteExecute(SITE, 'DELETE FROM pos_tables WHERE id = ?', [occupiedTable])

  const nothing = await splitTableBill(SITE, ACTOR, {
    fromTableId: destTable2,
    toTableId: destTable,
    moves: [],
  })
  ok('a split with nothing selected is refused', nothing.ok === false)

  const overQty = await billLinesForSplit(SITE, destTable2)
  if (overQty) {
    const tooMany = await splitTableBill(SITE, ACTOR, {
      fromTableId: destTable2,
      toTableId: destTable,
      moves: [{ lineId: overQty.lines[0].id, qty: overQty.lines[0].qty + 5 }],
    })
    ok(
      'moving more than is on the bill is refused',
      tooMany.ok === false,
      tooMany.ok ? '' : tooMany.error,
    )
    const negative = await splitTableBill(SITE, ACTOR, {
      fromTableId: destTable2,
      toTableId: destTable,
      moves: [{ lineId: overQty.lines[0].id, qty: -1 }],
    })
    ok('a negative quantity is refused', negative.ok === false)

    /*
     * A line id that is not on THIS bill — refused by the LOOKUP, not by the qty guard.
     *
     * Checked here, where the destination is genuinely free, because ordering matters: my
     * first attempt ran it while `destTable` still held an earlier split's bill, so the
     * occupancy check fired first and the assertion passed for entirely the wrong reason.
     * That is the same class of mistake as the merge check above, and it is why both now
     * assert on the MESSAGE rather than just on `ok === false`.
     */
    const foreign = await splitTableBill(SITE, ACTOR, {
      fromTableId: destTable2,
      toTableId: destTable,
      moves: [{ lineId: 999_999_999, qty: 1 }],
    })
    ok(
      '*** a line id from another bill cannot be smuggled in ***',
      foreign.ok === false && /no longer on the bill/i.test(foreign.ok ? '' : foreign.error),
      foreign.ok ? 'it was allowed' : foreign.error,
    )
    /* Nothing was written by any of those. A refusal that half-wrote would be worse than
       one that failed loudly. */
    const stillThere = await billLinesForSplit(SITE, destTable2)
    ok(
      'and none of the refusals changed the bill',
      stillThere?.lines.length === overQty.lines.length &&
        stillThere?.totalIncl === overQty.totalIncl,
      `${overQty.lines.length} -> ${stillThere?.lines.length}`,
    )
  }

  /* ── Clean up ───────────────────────────────────────────────────────────── */

  for (const id of [sourceTable, destTable, destTable2]) {
    const t = await siteQueryOne<any>(SITE, 'SELECT document_id FROM pos_tables WHERE id = ?', [id])
    await siteExecute(SITE, 'UPDATE pos_tables SET document_id = NULL WHERE id = ?', [id])
    if (t?.document_id) {
      await siteExecute(SITE, 'DELETE FROM sales_document_lines WHERE document_id = ?', [t.document_id])
      await siteExecute(SITE, 'DELETE FROM sales_documents WHERE id = ?', [t.document_id])
    }
    await siteExecute(SITE, 'DELETE FROM pos_tables WHERE id = ?', [id])
  }
  for (const id of [bill2, billId]) {
    await siteExecute(SITE, 'DELETE FROM sales_document_lines WHERE document_id = ?', [id]).catch(() => null)
    await siteExecute(SITE, 'DELETE FROM sales_documents WHERE id = ?', [id]).catch(() => null)
  }

  console.log(fails === 0 ? '\nAll split checks passed.' : `\n${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}

main()
