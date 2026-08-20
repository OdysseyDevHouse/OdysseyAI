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
import {
  saveDraft,
  saveForLaterDocument,
  claimDocument,
  documentClaim,
  overrideClaim,
  releaseDocument,
  cancelUnpostedDocument,
  getDocument,
  CLAIM_LEASE_MINUTES,
} from '../src/lib/site/salesDocuments'
import { finaliseDocument } from '../src/lib/site/salesPosting'
import { getTenderByCode } from '../src/lib/site/tenderTypes'
import { toNum } from '../src/lib/decimals'
import { tabPurpose } from '../src/lib/site/tabRouting'

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
  await siteExecute(SITE, "DELETE FROM pos_tables WHERE code LIKE 'T9%'", [], await tabPurpose(SITE))

  /* NOT routed: vat_rates is a shop table and lives only in the cloud. The box
     holds open tabs, not the rate card — see sql/box/001_spool.sql. */
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
    } as never, undefined, await tabPurpose(SITE))
    if (!draft.ok) throw new Error(`draft failed: ${draft.error}`)
    /* Parked, not left as a draft. `listTables` joins on `status = 'saved'`, which is
       the same predicate the saved-sales list uses — a table holding a plain draft
       would read as free. */
    const parked = await saveForLaterDocument(SITE, draft.id, await tabPurpose(SITE))
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
    await siteExecute(SITE, 'UPDATE pos_tables SET document_id = ? WHERE id = ?', [bill, t2.id], await tabPurpose(SITE))
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
     because occupancy is a join, not a stored flag.

     ── WHY THIS SECTION SKIPS ON A HYBRID SITE ───────────────────────────
     finaliseDocument runs in the CLOUD, always. It reaches into stock, the
     ledger, loyalty, serials, tips and shifts — none of which the box has, and
     none of which it should: two stock ledgers cannot be reconciled. On a
     hybrid site a tab is finalised when it reaches the cloud through the
     outbox, not against the box it was opened on.

     So this section is not merely inapplicable here — it describes a path that
     does not exist on a hybrid site, and forcing it would be asserting
     something untrue about the product. The behaviour it guards is unchanged
     for every cloud site, which is where it is exercised. */

  if ((await tabPurpose(SITE)) !== 'master') {
    console.log('\n**SKIPPED**  sections 7-9: finalising happens in the cloud on a hybrid site.\n')
    const p = await tabPurpose(SITE)
    await siteExecute(SITE, "UPDATE pos_tables SET document_id = NULL WHERE code LIKE 'T9%'", [], p)
    await siteExecute(SITE, "DELETE FROM pos_tables WHERE code LIKE 'T9%'", [], p)
    await siteExecute(SITE, 'DELETE FROM sales_document_lines WHERE product_id = ?', [productId], p)
    for (const id of [bill, otherBill]) {
      await siteExecute(SITE, 'DELETE FROM sales_documents WHERE id = ?', [id], p).catch(() => null)
    }
    await siteExecute(SITE, 'DELETE FROM stock_movements WHERE product_id = ?', [productId]).catch(
      () => null,
    )
    await siteExecute(SITE, 'DELETE FROM products WHERE id = ?', [productId]).catch(() => null)
    console.log(fails === 0 ? '\nAll table checks passed.' : `\n${fails} FAILURE(S)`)
    process.exit(fails === 0 ? 0 : 1)
  }

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

  /* ── 7b. A VOIDED bill leaves the floor ──────────────────────────────────
     The regression this guards actually shipped: voiding a hospitality sale
     cleared the till screen and nothing else, so the table stayed pointed at a
     fully populated `saved` document. The waiter watched the order vanish, the
     next person to tap that table got it back, and the floor was right — the
     sale had never been cancelled anywhere but on the screen.

     CANCELLED, not deleted, is the other half. `pos_void_events` rows carry the
     document_id, so removing the row would orphan the trail explaining why the
     sale went. */

  const voidedBill = await openBasket(75)
  const voidTable = await createTable(SITE, { code: `T9${stamp}V`, section: 'Patio', seats: 2 })
  ok('a table is created for the void test', voidTable.ok, voidTable.ok ? '' : voidTable.error)
  if (!voidTable.ok) process.exit(1)
  await seatTable(SITE, voidTable.id, voidedBill)
  ok('a table is seated for the void test', (await getTable(SITE, voidTable.id))?.state === 'open')

  /* CLAIMED first, because that is the real state a void happens from: the
     waiter is holding the bill on their till at the moment they void it. Without
     this the claim assertion below would be checking a column that was already
     NULL and would pass no matter what the cancel did. */
  const heldForVoid = await claimDocument(SITE, voidedBill, 1, 9003)
  ok('  and claimed by the till voiding it', heldForVoid.ok, heldForVoid.ok ? '' : heldForVoid.error)

  const cancelled = await cancelUnpostedDocument(SITE, voidedBill, await tabPurpose(SITE))
  ok('a parked bill can be cancelled', cancelled.ok, cancelled.ok ? '' : cancelled.error)

  const voidedDoc = await getDocument(SITE, voidedBill, await tabPurpose(SITE))
  ok(
    '*** the document is CANCELLED, not deleted ***',
    voidedDoc?.status === 'cancelled',
    `status ${voidedDoc?.status} — the void trail points at this row`,
  )
  /* Read off the COLUMN, not off getDocument — that mapper does not carry
     claimed_by, so `doc.claimedBy == null` would be true of every document ever
     written and would prove nothing about the cancel. */
  const claimRow = await siteQueryOne<{ claimed_by: number | null; claimed_at: string | null }>(
    SITE,
    'SELECT claimed_by, claimed_at FROM sales_documents WHERE id = ?',
    [voidedBill], await tabPurpose(SITE))
  ok(
    '  and its claim is let go with it',
    claimRow?.claimed_by === null && claimRow?.claimed_at === null,
    `claimed_by=${claimRow?.claimed_by} claimed_at=${claimRow?.claimed_at}`,
  )

  await freeTableForDocument(SITE, voidedBill)
  const freedByVoid = await getTable(SITE, voidTable.id)
  ok(
    '*** the table is free again after the void ***',
    freedByVoid?.state === 'free',
    `state ${freedByVoid?.state}`,
  )
  ok('  with nothing left on it', freedByVoid?.totalIncl === 0, String(freedByVoid?.totalIncl))
  ok('  and no pointer to the dead bill', freedByVoid?.documentId === null)

  /* A finalised sale must never go down this path: that is real money, and
     reversing it is voidDocument's job — which writes counter-entries this one
     deliberately does not. */
  const paidAgain = await openBasket(30)
  const paidDoc = await finaliseDocument(SITE, actor, {
    documentId: paidAgain,
    tenders: [{ tenderTypeId: cash.id, amount: 30 }],
  })
  ok('a second bill posts, to test the refusal', paidDoc.ok, paidDoc.ok ? '' : paidDoc.error)
  const refused = await cancelUnpostedDocument(SITE, paidAgain, await tabPurpose(SITE))
  ok('*** a FINALISED sale is refused by this path ***', !refused.ok, refused.ok ? '' : refused.error)

  /* Off the floor again before section 8, which counts the surviving T9 tables.
     Leaving this one active would fail that assertion with a number that has
     nothing to do with what it is testing. */
  await freeTableForDocument(SITE, paidAgain)
  await deactivateTable(SITE, voidTable.id)

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

  /* ── 9. A claimed bill is still a bill (171) ────────────────────────────────
     The regression this guards is the one that shipped: the claim used to be spelled by
     moving the document to `draft`, and `listTables` joins on `saved` — so resuming a
     table made the floor read it as FREE, hid its money from the split screen, and
     stranded it outright if the till never came back. */

  const claimTable = await createTable(SITE, { code: `T9${stamp}C`, seats: 2 })
  if (!claimTable.ok) throw new Error('claim table not created')
  const claimBill = await openBasket(120)
  await seatTable(SITE, claimTable.id, claimBill)

  /* Claims belong to the TERMINAL now (177), so these are terminal ids, not
     user ids. TILL_A and TILL_B stand for two machines on one floor. */
  const TILL_A = 9001
  const TILL_B = 9002

  const taken = await claimDocument(SITE, claimBill, 1, TILL_A)
  ok('a waiter can claim a table bill', taken.ok, taken.ok ? '' : taken.error)

  const whileHeld = (await listTables(SITE)).find((t) => t.id === claimTable.id)
  ok(
    '*** a claimed table is STILL occupied on the floor ***',
    whileHeld?.state === 'open' && whileHeld?.documentId === claimBill,
    `state=${whileHeld?.state} doc=${whileHeld?.documentId}`,
  )
  ok('  and its money is still on it', Number(whileHeld?.totalIncl) === 120, String(whileHeld?.totalIncl))

  /* The whole reason the claim exists: a SECOND till must be refused. */
  const stolenClaim = await claimDocument(SITE, claimBill, 2, TILL_B)
  ok(
    '*** a second till cannot take a held bill ***',
    !stolenClaim.ok,
    stolenClaim.ok ? '' : stolenClaim.error,
  )

  /* Its own TILL re-claiming is a reload, not a conflict — refusing that would lock a
     waiter out of the bill with their own stale claim. */
  const again = await claimDocument(SITE, claimBill, 1, TILL_A)
  ok('  but its own till may re-claim it', again.ok, again.ok ? '' : again.error)

  /* ── THE CHANGE 177 MAKES ────────────────────────────────────────────────
     The claim follows the MACHINE, not the person. A different operator signing
     in at the same till resumes what the last one left — the night shift picking
     up the day shift's table, which a user-owned claim refused. */
  const differentPerson = await claimDocument(SITE, claimBill, 2, TILL_A)
  ok(
    '*** a different operator on the SAME till may resume it ***',
    differentPerson.ok,
    differentPerson.ok ? '' : differentPerson.error,
  )

  /* And a terminal claim does NOT age out. A till that is merely offline looks
     exactly like one that is dead, and expiring its claim would hand the bill to
     a second till while the first is still adding to it. */
  await siteExecute(
    SITE,
    'UPDATE sales_documents SET claimed_at = UTC_TIMESTAMP() - INTERVAL ? MINUTE WHERE id = ?',
    [CLAIM_LEASE_MINUTES + 60, claimBill], await tabPurpose(SITE))
  const afterLongSilence = await claimDocument(SITE, claimBill, 2, TILL_B)
  ok(
    '*** an OLD terminal claim still holds — silence is not death ***',
    !afterLongSilence.ok,
    afterLongSilence.ok ? 'it was taken' : afterLongSilence.error,
  )

  /* Which is why there is an override: a till that is genuinely gone must not
     hold a table forever, and only a person can tell those two apart. */
  const holder = await documentClaim(SITE, claimBill)
  ok('  and the refusal can name who holds it', holder?.terminalId === TILL_A, JSON.stringify(holder))

  const forced = await overrideClaim(SITE, claimBill, TILL_B, 2)
  ok('*** a supervisor can break it ***', forced.ok, forced.ok ? '' : forced.error)
  const afterForce = await documentClaim(SITE, claimBill)
  ok('  and the bill moves to the new till', afterForce?.terminalId === TILL_B, JSON.stringify(afterForce))

  const released = await releaseDocument(SITE, claimBill)
  ok('releasing hands it back', released.ok, released.ok ? '' : released.error)
  const afterRelease = await getDocument(SITE, claimBill, await tabPurpose(SITE))
  ok(
    '  and leaves the bill saved, not draft',
    afterRelease?.status === 'saved',
    String(afterRelease?.status),
  )
  ok('  with no claim left on it', (await documentClaim(SITE, claimBill)) === null)
  const freeAgain = await claimDocument(SITE, claimBill, 2, TILL_B)
  ok('  so anyone may claim it again', freeAgain.ok, freeAgain.ok ? '' : freeAgain.error)

  await freeTable(SITE, claimTable.id)

  /* ── Clean up ───────────────────────────────────────────────────────────── */
  await siteExecute(SITE, "DELETE FROM pos_tables WHERE code LIKE 'T9%'", [], await tabPurpose(SITE))
  await siteExecute(SITE, 'DELETE FROM sales_document_lines WHERE product_id = ?', [productId], await tabPurpose(SITE))
  await siteExecute(SITE, 'DELETE FROM sales_documents WHERE id = ?', [otherBill], await tabPurpose(SITE)).catch(() => null)
  await siteExecute(SITE, 'DELETE FROM sales_documents WHERE id = ?', [claimBill], await tabPurpose(SITE)).catch(() => null)
  await siteExecute(SITE, 'DELETE FROM stock_movements WHERE product_id = ?', [productId]).catch(
    () => null,
  )
  await siteExecute(SITE, 'DELETE FROM products WHERE id = ?', [productId]).catch(() => null)

  const left = await siteQuery<any>(SITE, "SELECT COUNT(*) AS n FROM pos_tables WHERE code LIKE 'T9%'", [], await tabPurpose(SITE))
  ok('the test leaves no tables behind', Number(left[0]?.n) === 0, String(left[0]?.n))

  console.log(fails === 0 ? '\nAll table checks passed.' : `\n${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
