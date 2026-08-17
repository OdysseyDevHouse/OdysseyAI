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
import {
  splitTableBill,
  splitBillOntoDocument,
  billLinesForSplit,
  billLinesForSplitByDocument,
} from '../src/lib/site/posSplit'
import { seatTable, listTables } from '../src/lib/site/posTables'
import {
  saveDraft,
  saveForLaterDocument,
  claimDocument,
  getDocument,
} from '../src/lib/site/salesDocuments'
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
   * Onto an OCCUPIED table. The lines are APPENDED to the bill already there — "these two
   * are paying with that table" is an ordinary request, and refusing it sends the waiter
   * to retype the order by hand, which is the one way a line really does get lost.
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
    const sourceBeer = source!.lines.find((l) => l.description === 'Beer')!
    const sourceSteak = source!.lines.find((l) => l.description === 'Steak')!
    const beforeTotal = round((await docTotal(otherDraft.id)) + source!.totalIncl, 2)

    /* One beer (which the destination already has, at the same price) and one steak
       (which it does not). The pair is the point: one line has somewhere to fuse and the
       other does not, so both halves of the append rule are exercised in one write. */
    const merge = await splitTableBill(SITE, ACTOR, {
      fromTableId: destTable2,
      toTableId: occupiedTable,
      moves: [
        { lineId: sourceBeer.id, qty: 1 },
        { lineId: sourceSteak.id, qty: 1 },
      ],
    })
    ok(
      '*** a merge onto an OCCUPIED table appends to its bill ***',
      merge.ok === true,
      merge.ok ? '' : merge.error,
    )

    if (merge.ok) {
      /* The SAME document, not a new one. A table that was already occupied keeps the
         bill it had — minting a second one would leave the party with two. */
      ok(
        '  and it is the bill that was already there',
        merge.toDocumentId === otherDraft.id,
        `${merge.toDocumentId} vs ${otherDraft.id}`,
      )

      const after = await docLines(otherDraft.id)
      /* Two rows, not three: the beer FUSED into the one already on the bill (same
         product, same price, same note), the steak arrived as its own row. */
      ok('  the identical beer fused rather than doubling the rows', after.length === 2, String(after.length))
      ok(
        '  and the fused line carries both beers',
        toNum(after.find((l) => l.description === 'Beer')?.qty) === 2,
        String(toNum(after.find((l) => l.description === 'Beer')?.qty)),
      )
      ok('  the steak came across as its own line', after.some((l) => l.description === 'Steak'))

      /* The one rule that matters, stated in money: nothing fell off either bill. */
      const afterTotal = round(
        (await docTotal(otherDraft.id)) + ((await billLinesForSplit(SITE, destTable2))?.totalIncl ?? 0),
        2,
      )
      ok(
        '*** and the two bills STILL add up to what they did before ***',
        afterTotal === beforeTotal,
        `${afterTotal} vs ${beforeTotal}`,
      )
    }

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
     * Asserted on the MESSAGE rather than just on `ok === false`, because a refusal can be
     * the right answer for the wrong reason: an earlier version of this check passed
     * because a DIFFERENT guard fired first, and proved nothing about the lookup at all.
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

  /* ── What TRAVELS with a moved line ─────────────────────────────────────── */

  /*
   * The order, not just the money.
   *
   * All four of these used to be dropped by `rewriteLines`, silently: a split
   * stripped "allergy: nuts" off the moved line, lost its modifiers, reset what
   * the kitchen had been told, and restarted the line's age. None of it changed
   * a total, so nothing in this suite noticed.
   */
  {
    const ordered = new Date(Date.now() - 40 * 60_000).toISOString().slice(0, 19).replace('T', ' ')
    const draft = await saveDraft(SITE, ACTOR, {
      docType: 'invoice',
      documentDate: new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
        .toISOString()
        .slice(0, 10),
      customerName: 'Carry party',
      lines: [
        {
          productId: beer.insertId,
          description: 'Beer',
          qty: 3,
          unitPriceIncl: 30,
          vatRatePct: vatRate,
          unitCostExcl: 8,
          note: 'allergy: nuts',
          orderedAt: Date.parse(ordered + 'Z'),
          instructions: [
            {
              groupId: null,
              groupName: 'Extras',
              optionId: null,
              optionName: 'No onions',
              qty: 1,
              priceAdjustIncl: 0,
              productId: null,
              stockQtyPer: 0,
              printsOnKitchen: true,
              printsOnReceipt: true,
            },
          ],
        },
      ],
    } as never)
    if (!draft.ok) throw new Error(`could not open the carry bill: ${draft.error}`)
    const parked = await saveForLaterDocument(SITE, draft.id)
    if (!parked.ok) throw new Error(`could not park the carry bill: ${parked.error}`)
    await seatTable(SITE, sourceTable, draft.id)

    /* The kitchen has been told about 2 of the 3. Set directly, as
       markKitchenSentAction would. */
    await siteExecute(
      SITE,
      `UPDATE sales_document_lines SET kitchen_sent_qty = 2 WHERE document_id = ?`,
      [draft.id],
    )

    const before = await billLinesForSplit(SITE, sourceTable)
    const beerLine2 = before!.lines.find((l) => l.description === 'Beer')!

    // One of the three moves. Two stay.
    const carried = await splitTableBill(SITE, ACTOR, {
      fromTableId: sourceTable,
      toTableId: destTable,
      moves: [{ lineId: beerLine2.id, qty: 1 }],
    })
    ok('a part-line split with answers succeeds', carried.ok === true, carried.ok ? '' : carried.error)

    if (carried.ok) {
      const movedRow = await siteQueryOne<any>(
        SITE,
        `SELECT id, qty, line_note, kitchen_sent_qty, ordered_at
           FROM sales_document_lines WHERE document_id = ?`,
        [carried.toDocumentId],
      )
      const keptRow = await siteQueryOne<any>(
        SITE,
        `SELECT id, qty, line_note, kitchen_sent_qty, ordered_at
           FROM sales_document_lines WHERE document_id = ?`,
        [draft.id],
      )

      ok(
        '*** the allergy note travels with the moved line ***',
        movedRow?.line_note === 'allergy: nuts',
        `moved note: ${JSON.stringify(movedRow?.line_note)}`,
      )
      ok(
        'and stays on the half that did not move',
        keptRow?.line_note === 'allergy: nuts',
        `kept note: ${JSON.stringify(keptRow?.line_note)}`,
      )

      const movedAnswers = await siteQuery<any>(
        SITE,
        `SELECT option_name, qty FROM sales_document_line_instructions WHERE line_id = ?`,
        [movedRow.id],
      )
      const keptAnswers = await siteQuery<any>(
        SITE,
        `SELECT option_name, qty FROM sales_document_line_instructions WHERE line_id = ?`,
        [keptRow.id],
      )
      ok(
        '*** the modifiers travel with the moved line ***',
        movedAnswers.length === 1 && movedAnswers[0].option_name === 'No onions',
        `moved answers: ${JSON.stringify(movedAnswers.map((a: any) => a.option_name))}`,
      )
      ok(
        'and stay on the half that did not move',
        keptAnswers.length === 1 && keptAnswers[0].option_name === 'No onions',
        `kept answers: ${JSON.stringify(keptAnswers.map((a: any) => a.option_name))}`,
      )

      /* 2 of 3 were sent. The kept half is 2, the moved half 1 — so the kept
         side absorbs both sent units and the moved unit is still owed to the
         kitchen. The two must SUM to what was actually sent, or a split either
         re-fires food or loses track of it. */
      const movedSent = toNum(movedRow?.kitchen_sent_qty)
      const keptSent = toNum(keptRow?.kitchen_sent_qty)
      ok(
        '*** the sent quantities still sum to what the kitchen was told ***',
        movedSent + keptSent === 2,
        `kept ${keptSent} + moved ${movedSent}`,
      )
      ok(
        'and neither half claims more sent than it has',
        keptSent <= toNum(keptRow?.qty) && movedSent <= toNum(movedRow?.qty),
        `kept ${keptSent}/${keptRow?.qty}, moved ${movedSent}/${movedRow?.qty}`,
      )

      /* The age. Both halves are the same order, so both keep the same time —
         a moved starter is not a new starter. */
      const movedAge = movedRow?.ordered_at ? new Date(movedRow.ordered_at).getTime() : 0
      const keptAge = keptRow?.ordered_at ? new Date(keptRow.ordered_at).getTime() : 0
      ok(
        '*** the order time survives the move ***',
        movedAge > 0 && movedAge === keptAge,
        `moved ${movedRow?.ordered_at}, kept ${keptRow?.ordered_at}`,
      )

      await siteExecute(SITE, 'UPDATE pos_tables SET document_id = NULL WHERE document_id = ?', [
        carried.toDocumentId,
      ])
      await siteExecute(SITE, 'DELETE FROM sales_documents WHERE id = ?', [carried.toDocumentId])
    }

    await siteExecute(SITE, 'UPDATE pos_tables SET document_id = NULL WHERE document_id = ?', [
      draft.id,
    ])
    await siteExecute(SITE, 'DELETE FROM sales_documents WHERE id = ?', [draft.id])
  }

  /* ── Splitting the table the till is sitting IN ──────────────────────────
     The gesture a waiter actually makes: open the table, press Split. That means the
     bill is CLAIMED by the operator at the moment it is split, which the old
     arm-from-the-floor route never produced.

     It is also the regression this guards. The claim used to be spelled by moving the
     document to `draft`, and both `listTables` and `splitTableBill` require `saved` — so
     a waiter sitting in a table saw it as free, was told there was nothing to split, and
     could not have split it even if the screen had let them. */
  {
    const held = await saveDraft(SITE, ACTOR, {
      docType: 'invoice',
      customerName: 'Table',
      lines: [
        { productId: beer.insertId, description: 'Beer', productType: 'normal', qty: 2, unitPriceIncl: 50, vatRatePct: vatRate, unitCostExcl: 8 },
        { productId: steak.insertId, description: 'Steak', productType: 'normal', qty: 1, unitPriceIncl: 200, vatRatePct: vatRate, unitCostExcl: 40 },
      ],
    } as never)
    if (!held.ok) throw new Error(`could not open the held bill: ${held.error}`)
    await saveForLaterDocument(SITE, held.id)
    await seatTable(SITE, sourceTable, held.id)

    /* The waiter opens the table. This is what the till does on resume. */
    /* Terminal-owned since 177, so this is the till the waiter is standing at
       rather than the waiter themselves. */
    const TILL = 9101
    const claim = await claimDocument(SITE, held.id, ACTOR.userId, TILL)
    ok('a waiter can claim a table bill', claim.ok, claim.ok ? '' : claim.error)

    const whileHeld = (await listTables(SITE)).find((t) => t.id === sourceTable)
    ok(
      '*** the table is STILL occupied while the till holds it ***',
      whileHeld?.state === 'open',
      `state=${whileHeld?.state}`,
    )

    const heldLines = (await billLinesForSplit(SITE, sourceTable))!.lines
    ok('  so the split screen can read its lines', heldLines.length === 2, String(heldLines.length))

    const steakLine = heldLines.find((l) => l.description === 'Steak')!
    const heldSplit = await splitTableBill(SITE, ACTOR, {
      fromTableId: sourceTable,
      toTableId: destTable,
      moves: [{ lineId: steakLine.id, qty: 1 }],
    })
    ok('*** a HELD bill can still be split ***', heldSplit.ok, heldSplit.ok ? '' : heldSplit.error)

    const afterHeld = await listTables(SITE)
    const keptSide = afterHeld.find((t) => t.id === sourceTable)
    const movedSide = afterHeld.find((t) => t.id === destTable)
    ok('  the source keeps the beers', Number(keptSide?.totalIncl) === 100, String(keptSide?.totalIncl))
    ok('  the destination takes the steak', Number(movedSide?.totalIncl) === 200, String(movedSide?.totalIncl))
    ok(
      '*** and both halves still add up ***',
      Number(keptSide?.totalIncl) + Number(movedSide?.totalIncl) === 300,
      `${keptSide?.totalIncl} + ${movedSide?.totalIncl}`,
    )

    const keptDoc = await getDocument(SITE, held.id)
    ok(
      '*** the kept half is still SAVED, so the floor keeps showing it ***',
      keptDoc?.status === 'saved',
      String(keptDoc?.status),
    )

    /* The till re-reads the kept half straight after the split, or its stale basket
       would overwrite the document and undo the move. That is a SAME-USER re-claim,
       which must succeed or a waiter is locked out of their own table. */
    const reread = await claimDocument(SITE, held.id, ACTOR.userId, TILL)
    ok('*** the waiter can re-read the kept half ***', reread.ok, reread.ok ? '' : reread.error)
    const keptLines = (await billLinesForSplit(SITE, sourceTable))!.lines
    ok('  and it carries only what stayed', keptLines.length === 1, String(keptLines.length))
    ok('    2 × Beer', keptLines[0]?.description === 'Beer' && Number(keptLines[0]?.qty) === 2)

    for (const id of [sourceTable, destTable]) {
      const t = await siteQueryOne<any>(SITE, 'SELECT document_id FROM pos_tables WHERE id = ?', [id])
      await siteExecute(SITE, 'UPDATE pos_tables SET document_id = NULL WHERE id = ?', [id])
      if (t?.document_id) {
        await siteExecute(SITE, 'DELETE FROM sales_document_lines WHERE document_id = ?', [t.document_id])
        await siteExecute(SITE, 'DELETE FROM sales_documents WHERE id = ?', [t.document_id])
      }
    }
    await siteExecute(SITE, 'DELETE FROM sales_document_lines WHERE document_id = ?', [held.id]).catch(() => null)
    await siteExecute(SITE, 'DELETE FROM sales_documents WHERE id = ?', [held.id]).catch(() => null)
  }

  /* ── Splitting onto an open SALE, not a table ────────────────────────────
     The destination a waiter actually picks. Most open bills on a hospitality till are
     free-text tabs — "Walk-in", a takeaway — with no pos_tables row at all, so the
     table-keyed split could never offer them: a floor with four open sales showed one
     destination, and a single-table floor showed "no other tables" with three live bills
     behind the dialog. */
  {
    const mkBill = async (name: string, lines: unknown[]) => {
      const d = await saveDraft(SITE, ACTOR, { docType: 'invoice', customerName: name, lines } as never)
      if (!d.ok) throw new Error(`could not open ${name}: ${d.error}`)
      await saveForLaterDocument(SITE, d.id)
      return d.id
    }

    const src = await mkBill('Table 9', [
      { productId: beer.insertId, description: 'Beer', productType: 'normal', qty: 2, unitPriceIncl: 50, vatRatePct: vatRate, unitCostExcl: 8 },
      { productId: steak.insertId, description: 'Steak', productType: 'normal', qty: 1, unitPriceIncl: 200, vatRatePct: vatRate, unitCostExcl: 40 },
    ])
    /* A tab on NO table — the case the whole change exists for. */
    const tab = await mkBill('Walk-in', [
      { productId: beer.insertId, description: 'Beer', productType: 'normal', qty: 1, unitPriceIncl: 50, vatRatePct: vatRate, unitCostExcl: 8 },
    ])

    const srcLines = (await billLinesForSplitByDocument(SITE, src))!.lines
    const steakLine = srcLines.find((l) => l.description === 'Steak')!

    const ontoTab = await splitBillOntoDocument(SITE, ACTOR, {
      fromDocumentId: src,
      toDocumentId: tab,
      moves: [{ lineId: steakLine.id, qty: 1 }],
    })
    ok('*** a bill can be split onto a TAB with no table ***', ontoTab.ok, ontoTab.ok ? '' : ontoTab.error)

    ok('  the steak joined the tab', (await docTotal(tab)) === 250, String(await docTotal(tab)))
    ok('  the beers stayed behind', (await docTotal(src)) === 100, String(await docTotal(src)))
    ok(
      '*** and the money is conserved ***',
      (await docTotal(tab)) + (await docTotal(src)) === 350,
      `${await docTotal(tab)} + ${await docTotal(src)}`,
    )
    /* Appending must not MOVE the destination: a tab on no table stays on none. */
    const tabTable = await siteQueryOne<any>(SITE, 'SELECT id FROM pos_tables WHERE document_id = ?', [tab])
    ok('  and the tab is still on no table', !tabTable)

    /* Onto a brand new sale — the only destination on a floor with one open bill. */
    const beerLine = (await billLinesForSplitByDocument(SITE, src))!.lines.find((l) => l.description === 'Beer')!
    const ontoNew = await splitBillOntoDocument(SITE, ACTOR, {
      fromDocumentId: src,
      toDocumentId: null,
      newSaleName: 'Dave',
      moves: [{ lineId: beerLine.id, qty: 1 }],
    })
    ok('*** a bill can be split onto a NEW sale ***', ontoNew.ok, ontoNew.ok ? '' : (ontoNew as any).error)
    if (ontoNew.ok) {
      const fresh = await getDocument(SITE, ontoNew.toDocumentId)
      ok('  the new sale carries the name it was given', fresh?.customerName === 'Dave', String(fresh?.customerName))
      ok('  with one beer on it', Number(fresh?.totalIncl) === 50, String(fresh?.totalIncl))
      ok('  and it is saved, so the floor lists it', fresh?.status === 'saved', String(fresh?.status))
      ok('  the source kept the other beer', (await docTotal(src)) === 50, String(await docTotal(src)))
      await siteExecute(SITE, 'DELETE FROM sales_document_lines WHERE document_id = ?', [ontoNew.toDocumentId]).catch(() => null)
      await siteExecute(SITE, 'DELETE FROM sales_documents WHERE id = ?', [ontoNew.toDocumentId]).catch(() => null)
    }

    /* Splitting a bill onto ITSELF is a no-op that would double its lines. */
    const ontoSelf = await splitBillOntoDocument(SITE, ACTOR, {
      fromDocumentId: src,
      toDocumentId: src,
      moves: [{ lineId: beerLine.id, qty: 1 }],
    })
    ok('*** a bill cannot be split onto itself ***', !ontoSelf.ok, ontoSelf.ok ? '' : ontoSelf.error)

    for (const id of [src, tab]) {
      await siteExecute(SITE, 'DELETE FROM sales_document_lines WHERE document_id = ?', [id]).catch(() => null)
      await siteExecute(SITE, 'DELETE FROM sales_documents WHERE id = ?', [id]).catch(() => null)
    }
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

  /*
   * ── AND THE PRODUCTS THIS RUN MADE ──────────────────────────────────────
   *
   * Every run of this test has left two behind since it was written, and they
   * are not inert: reconcileStock is asserted by OTHER suites, so a "Split test
   * beer" left in a state where its stock and its movements disagree fails
   * test:credit-notes, which has never heard of it.
   *
   * ── WHAT ACTUALLY GOES WRONG, WHICH IS NOT WHAT IT LOOKS LIKE ───────────
   *
   * The products are created with stock_on_hand 500 and a matching `opening`
   * movement, so on their own they reconcile perfectly. Drift appears when a
   * run DIES PART-WAY: a sale moved the stock, the movement row never landed,
   * and the pair are left disagreeing forever.
   *
   * So the sweep is not "delete the litter" — most of these cannot be deleted
   * and should not be, because a finalised document and a real stock movement
   * point at them, and removing the row would break a posted record to tidy up
   * a test. It is "make stored agree with movements again", which is what
   * reconcileStock is asking of every product in the shop.
   */
  const strays = await siteQuery<{ id: number; refs: number }>(
    SITE,
    `SELECT p.id,
            (SELECT COUNT(*) FROM sales_document_lines l WHERE l.product_id = p.id)
          + (SELECT COUNT(*) FROM stock_movements m WHERE m.product_id = p.id) AS refs
       FROM products p
      WHERE p.code LIKE 'SPB%' OR p.code LIKE 'SPS%'`,
  )
  let removed = 0
  for (const p of strays) {
    /* Unreferenced ones can simply go — nothing posted points at them. */
    if (Number(p.refs) === 0) {
      await siteExecute(SITE, 'DELETE FROM products WHERE id = ?', [p.id]).catch(() => null)
      removed++
    }
  }
  /* The rest keep their rows and get their arithmetic put right. */
  const repaired = await siteExecute(
    SITE,
    `UPDATE products p
        SET p.stock_on_hand = COALESCE(
              (SELECT SUM(m.qty_change) FROM stock_movements m WHERE m.product_id = p.id), 0)
      WHERE (p.code LIKE 'SPB%' OR p.code LIKE 'SPS%')
        AND p.stock_on_hand <> COALESCE(
              (SELECT SUM(m.qty_change) FROM stock_movements m WHERE m.product_id = p.id), 0)`,
  )
  if (removed || repaired.affectedRows) {
    console.log(
      `      (removed ${removed} unused product(s), repaired stock on ${repaired.affectedRows})`,
    )
  }

  /*
   * Proved, not assumed — and proved against the SAME sum reconcileStock uses.
   *
   * An earlier version of this check asserted stock_on_hand was zero, which
   * passed while making the drift worse: zeroing a product whose movements say
   * 500 simply moves the disagreement from +500 to −500.
   */
  const drifting = await siteQuery<{ code: string; stored: number; computed: number }>(
    SITE,
    `SELECT p.code, p.stock_on_hand AS stored,
            COALESCE((SELECT SUM(m.qty_change) FROM stock_movements m WHERE m.product_id = p.id), 0)
              AS computed
       FROM products p
      WHERE (p.code LIKE 'SPB%' OR p.code LIKE 'SPS%')
        AND p.stock_on_hand <> COALESCE(
              (SELECT SUM(m.qty_change) FROM stock_movements m WHERE m.product_id = p.id), 0)`,
  )
  ok(
    '*** the test leaves no stock drift behind ***',
    drifting.length === 0,
    drifting.length ? JSON.stringify(drifting.slice(0, 3)) : '',
  )

  console.log(fails === 0 ? '\nAll split checks passed.' : `\n${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}

main()
