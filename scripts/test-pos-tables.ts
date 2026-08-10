/**
 * Tables — the floor, and what holds a bill.
 *
 *   npx tsx --conditions=react-server --env-file=.env scripts/test-pos-tables.ts
 *
 * The decision under test is that a table holds an ORDINARY SAVED SALE — the same
 * mechanism the retail till parks a basket with — rather than a bill of its own. So the
 * assertions are about the seams that decision creates:
 *
 *   · OCCUPANCY IS DERIVED. There is no status column, so a bill paid or voided from
 *     the back office must free the table by itself. A stored status would fall out of
 *     step the first time that happened, leaving a table nobody could seat.
 *   · TWO WAITERS, ONE TABLE. Seating is a locked read-then-write, so the second one is
 *     told the table is taken rather than silently taking the first one's bill.
 *   · ONE BASKET, ONE TABLE. `uq_table_document` refuses the same document on two
 *     tables, which would let two waiters take payment for one bill.
 *   · A table with a bill open cannot be taken out of service — the alternative is a
 *     bill nobody can reach.
 */
import { siteExecute, siteQuery, siteQueryOne } from '../src/lib/siteDb'
import {
  listTables,
  getTable,
  createTable,
  updateTable,
  deactivateTable,
  seatTable,
  freeTable,
  freeTableForDocument,
  markBillAsked,
  tableForDocument,
  validateTable,
} from '../src/lib/site/posTables'
import { saveDraft, saveForLaterDocument } from '../src/lib/site/salesDocuments'
import { finaliseDocument } from '../src/lib/site/salesPosting'
import { getTenderByCode } from '../src/lib/site/tenderTypes'
import { toNum } from '../src/lib/decimals'

const SITE = 1
const actor = { userId: 1, userName: 'Tables test' }
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

async function main() {
  const stamp = Date.now().toString().slice(-6)

  /* Sweep what an earlier crashed run left. `code` is UNIQUE, so litter fails the
     INSERT rather than the assertion it was making. */
  await siteExecute(SITE, "DELETE FROM pos_tables WHERE code LIKE 'T9%'")

  const vat = await siteQueryOne<any>(
    SITE,
    "SELECT id, rate FROM vat_rates WHERE vat_type='sales' AND is_default=1 LIMIT 1",
  )
  const rate = toNum(vat?.rate, 15)
  const cash = await getTenderByCode(SITE, 'CASH')
  if (!cash) throw new Error('This site has no CASH tender.')

  const prod = await siteExecute(
    SITE,
    `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost, last_cost,
                           selling_vat_rate_id, visible_in_pos)
     VALUES (?,?,'service',0,4,4,?,1)`,
    [`TBL${stamp}`, `Table test item ${stamp}`, vat?.id ?? null],
  )
  const productId = prod.insertId

  /** A parked basket, exactly as the retail till makes one. */
  async function openBasket(amount: number): Promise<number> {
    const draft = await saveDraft(SITE, actor, {
      docType: 'invoice',
      customerName: 'Table',
      lines: [
        {
          productId,
          description: 'Table test item',
          productType: 'service',
          qty: 1,
          unitPriceIncl: amount,
          vatRatePct: rate,
          unitCostExcl: 4,
        },
      ],
    } as never)
    if (!draft.ok) throw new Error(`draft failed: ${draft.error}`)
    /* Parked, not left as a draft. `listTables` joins on `status = 'saved'`, which is
       the same predicate the saved-sales list uses — a table holding a plain draft
       would read as free. */
    const parked = await saveForLaterDocument(SITE, draft.id)
    if (!parked.ok) throw new Error(`park failed: ${parked.error}`)
    return draft.id
  }

  /* ── 1. Validation ──────────────────────────────────────────────────────── */

  ok('a table needs a code', !!validateTable({ code: '  ' }))
  ok('a long code is refused', !!validateTable({ code: 'x'.repeat(17) }))
  ok('negative seats are refused', !!validateTable({ code: 'T1', seats: -1 }))
  ok('a plain table is accepted', validateTable({ code: 'T1', seats: 4 }) === null)

  /* ── 2. Building a floor ────────────────────────────────────────────────── */

  const t1 = await createTable(SITE, { code: `T9${stamp}A`, section: 'Patio', seats: 4 })
  const t2 = await createTable(SITE, { code: `T9${stamp}B`, section: 'Patio', seats: 2 })
  ok('tables are created', t1.ok && t2.ok, t1.ok ? '' : t1.error)
  if (!t1.ok || !t2.ok) process.exit(1)

  const dup = await createTable(SITE, { code: `T9${stamp}A` })
  ok('a duplicate code is refused', !dup.ok, dup.ok ? '' : dup.error)

  const floor = (await listTables(SITE)).filter((t) => t.code.startsWith('T9'))
  ok('both are on the floor', floor.length === 2, String(floor.length))
  ok('and both start FREE', floor.every((t) => t.state === 'free'), floor.map((t) => t.state).join(','))
  ok('  with nothing on them', floor.every((t) => t.totalIncl === 0 && t.lineCount === 0))
  ok(
    '  sort_order is appended, not left at zero',
    new Set(floor.map((t) => t.sortOrder)).size === 2,
    floor.map((t) => t.sortOrder).join(','),
  )

  /* ── 3. Seating ─────────────────────────────────────────────────────────── */

  const bill = await openBasket(120)
  const seated = await seatTable(SITE, t1.id, bill)
  ok('a table is seated with a basket', seated.ok, seated.ok ? '' : seated.error)

  const afterSeat = await getTable(SITE, t1.id)
  ok('it reads as OPEN', afterSeat?.state === 'open', String(afterSeat?.state))
  ok('  showing what is on the bill', afterSeat?.totalIncl === 120, String(afterSeat?.totalIncl))
  ok('  and how many lines', afterSeat?.lineCount === 1, String(afterSeat?.lineCount))
  ok('  and when it was opened', afterSeat?.openedAt !== null)

  const found = await tableForDocument(SITE, bill)
  ok('the table can be found from its document', found?.id === t1.id, String(found?.id))

  /* ── 4. TWO WAITERS, ONE TABLE ──────────────────────────────────────────
     Seating is a locked read-then-write, so the second is REFUSED rather than
     silently taking the first one's bill. */

  const otherBill = await openBasket(50)
  const stolen = await seatTable(SITE, t1.id, otherBill)
  ok('*** a second basket cannot take an occupied table ***', !stolen.ok, stolen.ok ? '' : stolen.error)
  const stillFirst = await getTable(SITE, t1.id)
  ok('  the first bill is untouched', stillFirst?.documentId === bill, String(stillFirst?.documentId))

  ok(
    're-seating the SAME basket is allowed, so a retry is safe',
    (await seatTable(SITE, t1.id, bill)).ok,
  )

  /* ── 5. ONE BASKET, ONE TABLE ───────────────────────────────────────────
     The other axis. Two tables holding one document would let two waiters take
     payment for the same bill; uq_table_document refuses it. */

  let sameBillTwice = false
  try {
    await siteExecute(SITE, 'UPDATE pos_tables SET document_id = ? WHERE id = ?', [bill, t2.id])
    sameBillTwice = true
  } catch {
    // The unique index did its job.
  }
  ok('*** one basket cannot be on two tables ***', !sameBillTwice, 'uq_table_document')

  /* ── 6. Asking for the bill ─────────────────────────────────────────────── */

  const asked = await markBillAsked(SITE, t1.id)
  ok('the bill can be asked for', asked.ok, asked.ok ? '' : asked.error)
  const waiting = await getTable(SITE, t1.id)
  ok('  the table now reads BILL, not open', waiting?.state === 'bill', String(waiting?.state))
  ok('  and records when', waiting?.billAskedAt !== null)

  const askedFree = await markBillAsked(SITE, t2.id)
  ok('asking for the bill on a FREE table is refused', !askedFree.ok, askedFree.ok ? '' : askedFree.error)

  /* ── 7. OCCUPANCY IS DERIVED ────────────────────────────────────────────
     THE assertion in this file. The bill is finalised — as it would be from the back
     office, with nothing telling the table about it — and the table must read free
     because occupancy is a join, not a stored flag. */

  const posted = await finaliseDocument(SITE, actor, {
    documentId: bill,
    tenders: [{ tenderTypeId: cash.id, amount: 120 }],
  })
  ok('the bill posts', posted.ok, posted.ok ? '' : posted.error)

  const afterPost = await getTable(SITE, t1.id)
  ok(
    '*** a bill paid elsewhere frees the table by itself ***',
    afterPost?.state === 'free',
    `state ${afterPost?.state} — occupancy is derived, not stored`,
  )
  ok('  and shows nothing on it', afterPost?.totalIncl === 0, String(afterPost?.totalIncl))

  /* The pointer is still there until something clears it, which is what
     freeTableForDocument is for — and the state above is already correct regardless,
     which is the whole point of deriving it. */
  await freeTableForDocument(SITE, bill)
  const cleared = await getTable(SITE, t1.id)
  ok('freeing by document clears the pointer', cleared?.documentId === null)
  ok('  and is idempotent', (await freeTableForDocument(SITE, bill)) === undefined)

  /* ── 8. Out of service ──────────────────────────────────────────────────── */

  await seatTable(SITE, t2.id, otherBill)
  const busy = await deactivateTable(SITE, t2.id)
  ok('a table with a bill open cannot be retired', !busy.ok, busy.ok ? '' : busy.error)

  await freeTable(SITE, t2.id)
  const retired = await deactivateTable(SITE, t2.id)
  ok('once free, it can be', retired.ok, retired.ok ? '' : retired.error)
  const remaining = (await listTables(SITE)).filter((t) => t.code.startsWith('T9'))
  ok('  and it leaves the floor', remaining.length === 1, String(remaining.length))

  const renamed = await updateTable(SITE, t1.id, { code: `T9${stamp}Z`, seats: 6 })
  ok('a table can be renamed', renamed.ok, renamed.ok ? '' : renamed.error)

  /* ── Clean up ───────────────────────────────────────────────────────────── */
  await siteExecute(SITE, "DELETE FROM pos_tables WHERE code LIKE 'T9%'")
  await siteExecute(SITE, 'DELETE FROM sales_document_lines WHERE product_id = ?', [productId])
  await siteExecute(SITE, 'DELETE FROM sales_documents WHERE id = ?', [otherBill]).catch(() => null)
  await siteExecute(SITE, 'DELETE FROM stock_movements WHERE product_id = ?', [productId]).catch(
    () => null,
  )
  await siteExecute(SITE, 'DELETE FROM products WHERE id = ?', [productId]).catch(() => null)

  const left = await siteQuery<any>(SITE, "SELECT COUNT(*) AS n FROM pos_tables WHERE code LIKE 'T9%'")
  ok('the test leaves no tables behind', Number(left[0]?.n) === 0, String(left[0]?.n))

  console.log(fails === 0 ? '\nAll table checks passed.' : `\n${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
