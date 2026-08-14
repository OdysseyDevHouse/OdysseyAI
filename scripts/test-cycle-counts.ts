/**
 * Cycle counts — recurring programmes that generate draft stock takes.
 *
 * THE RULE THIS EXISTS TO PROVE is the open-sheet gate: a programme whose
 * previous generated sheet is still open SKIPS instead of piling up. A pile of
 * identical drafts is how the same shelf gets counted against three different
 * snapshots, and posting the previous count is the honest gate on the next.
 *
 * Also proved: one sheet per generate press per programme (catch-up happens
 * across presses, not in one burst), `last_generated_for` idempotence, an
 * inactive programme is never due, a department scope pulls only that
 * department, and a generation FAILURE is not stamped — so it stays visible
 * and retryable instead of silently swallowing an occurrence.
 *
 * Every count here confirms the snapshot exactly (zero variance), so posting
 * writes no movements and no journal — the suite leaves the ledger alone.
 *
 *   npm run test:cycle-counts
 */
import { siteExecute, siteQuery, siteQueryOne } from '../src/lib/siteDb'
import { createLocation } from '../src/lib/site/stockLocations'
import {
  listCycleProgrammes,
  saveCycleProgramme,
  deleteCycleProgramme,
  generateDueCycleCounts,
} from '../src/lib/site/cycleCounts'
import { getStockTake, postStockTake, saveCounts, deleteStockTake } from '../src/lib/site/stockTakes'
import { reconcileStock } from '../src/lib/site/stockMovements'

const SITE = 1
const actor = { userId: 1, userName: 'Cycle Count Test' }
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

const CODE_PATTERN = '^ZCC[0-9]{8}'
const LOC_PATTERN = 'ZC%'
const DEPT_NAME = 'ZCC cycle dept'

/** Crashed prior runs leave rows on UNIQUE columns that kill the next run. */
async function sweepStrays() {
  const products = `(SELECT id FROM products WHERE code REGEXP '${CODE_PATTERN}')`
  const locs = `(SELECT id FROM stock_locations WHERE code LIKE '${LOC_PATTERN}')`
  await siteExecute(SITE, `DELETE FROM stock_take_lines WHERE product_id IN ${products}`)
  await siteExecute(SITE, `DELETE FROM stock_takes WHERE location_id IN ${locs}`)
  await siteExecute(SITE, `DELETE FROM cycle_count_programmes WHERE location_id IN ${locs}`)
  await siteExecute(SITE, `DELETE FROM stock_movements WHERE product_id IN ${products}`)
  await siteExecute(SITE, `DELETE FROM product_location_stock WHERE product_id IN ${products}`)
  await siteExecute(SITE, `DELETE FROM products WHERE code REGEXP '${CODE_PATTERN}'`)
  await siteExecute(SITE, `DELETE FROM stock_locations WHERE code LIKE '${LOC_PATTERN}' AND is_main = 0`)
  await siteExecute(SITE, `DELETE FROM departments WHERE name LIKE 'ZCC %'`)
}

async function main() {
  await sweepStrays()

  const stamp = Date.now().toString().slice(-8)
  const stockDriftBefore = (await reconcileStock(SITE)).length

  /* ── Fixtures ────────────────────────────────────────────────────────── */

  const room = await createLocation(SITE, { code: `ZC${stamp.slice(0, 6)}`, name: 'Cycle count room' })
  if (!room.ok) { console.log('location setup failed'); process.exit(1) }
  const roomId = room.id

  const dept = await siteExecute(SITE, 'INSERT INTO departments (name) VALUES (?)', [DEPT_NAME])
  const deptId = dept.insertId
  const otherDept = await siteExecute(SITE, 'INSERT INTO departments (name) VALUES (?)', ['ZCC other dept'])

  const vat = await siteQueryOne<any>(
    SITE, "SELECT id FROM vat_rates WHERE vat_type='sales' AND is_default=1 LIMIT 1")

  const makeProduct = async (suffix: string, departmentId: number, qty: number) => {
    const r = await siteExecute(SITE,
      `INSERT INTO products (code, description, product_type, department_id, stock_on_hand,
                             average_cost, last_cost, selling_vat_rate_id)
       VALUES (?,?,'normal',?,0,5,5,?)`,
      [`ZCC${stamp}${suffix}`, `Cycle count ${suffix}`, departmentId, vat?.id ?? null])
    await siteExecute(SITE,
      `INSERT INTO product_location_stock (product_id, location_id, stock_on_hand) VALUES (?,?,?)`,
      [r.insertId, roomId, qty])
    await siteExecute(SITE, 'UPDATE products SET stock_on_hand = ? WHERE id = ?', [qty, r.insertId])
    await siteExecute(SITE,
      `INSERT INTO stock_movements (product_id, location_id, movement_type, qty_change, qty_after,
                                    unit_cost_excl, source, user_id, user_name)
       VALUES (?,?,'opening',?,?,5,'opening',1,'Cycle Count Test')`,
      [r.insertId, roomId, qty, qty])
    return r.insertId as number
  }

  const inDept = await makeProduct('A', deptId, 12)
  const inDeptToo = await makeProduct('B', deptId, 7)
  const elsewhere = await makeProduct('C', otherDept.insertId, 9)

  /* ── 1. Validation, before anything touches the calendar ─────────────── */

  const noName = await saveCycleProgramme(SITE, actor, null, {
    name: '  ', locationId: roomId, scope: 'full', frequency: 'weekly', dayOfWeek: 1,
    startsOn: '2026-07-06',
  })
  ok('*** a programme with no name is refused ***', !noName.ok)

  const noRef = await saveCycleProgramme(SITE, actor, null, {
    name: 'No ref', locationId: roomId, scope: 'department', frequency: 'weekly', dayOfWeek: 1,
    startsOn: '2026-07-06',
  })
  ok('  a department programme with no department is refused', !noRef.ok)

  const noDay = await saveCycleProgramme(SITE, actor, null, {
    name: 'No day', locationId: roomId, scope: 'full', frequency: 'weekly', dayOfWeek: null,
    startsOn: '2026-07-06',
  })
  ok('  a weekly programme with no weekday is refused', !noDay.ok)

  const backwards = await saveCycleProgramme(SITE, actor, null, {
    name: 'Backwards', locationId: roomId, scope: 'full', frequency: 'weekly', dayOfWeek: 1,
    startsOn: '2026-07-06', endsOn: '2026-07-01',
  })
  ok('  an end date before the start is refused', !backwards.ok)

  /* ── 2. A weekly programme, due ──────────────────────────────────────── */

  // Mondays from 2026-07-06; asAt two Mondays later, so TWO occurrences are
  // owed. Dates are handed in explicitly — the suite must not depend on which
  // day of the week it happens to run on.
  const saved = await saveCycleProgramme(SITE, actor, null, {
    name: 'ZCC weekly dept count', locationId: roomId, scope: 'department', scopeRefId: deptId,
    frequency: 'weekly', dayOfWeek: 1, startsOn: '2026-07-06',
  })
  ok('*** a valid programme saves ***', saved.ok, saved.ok ? `#${saved.id}` : saved.error)
  if (!saved.ok) { console.log('cannot continue'); process.exit(1) }
  const progId = saved.id

  const listed = (await listCycleProgrammes(SITE, '2026-07-20')).find((p) => p.id === progId)
  ok('  the list shows it due on the FIRST owed Monday', listed?.nextDue === '2026-07-06',
    `nextDue=${listed?.nextDue}`)
  ok('  with no open sheet yet', listed?.openTakeId === null)

  const run1 = await generateDueCycleCounts(SITE, actor, '2026-07-20')
  const mine1 = run1.generated.filter((g) => g.programmeId === progId)
  ok('*** generating creates exactly ONE sheet, not the whole backlog ***',
    mine1.length === 1, `${mine1.length} generated`)
  const take1 = mine1[0]
  ok('  dated for the occurrence it covers', take1?.forDate === '2026-07-06', take1?.forDate)

  const sheet1 = await getStockTake(SITE, take1.stockTakeId)
  ok('  the sheet is an ordinary draft', sheet1?.status === 'draft')
  ok('  stamped with its programme', sheet1?.programmeId === progId,
    `programme_id=${sheet1?.programmeId}`)
  ok('*** a department scope pulls BOTH department products and nothing else ***',
    sheet1?.lines.length === 2 &&
      sheet1.lines.some((l) => l.productId === inDept) &&
      sheet1.lines.some((l) => l.productId === inDeptToo) &&
      !sheet1.lines.some((l) => l.productId === elsewhere),
    `${sheet1?.lines.length} lines`)

  const stamped = await siteQueryOne<any>(
    SITE, 'SELECT last_generated_for FROM cycle_count_programmes WHERE id=?', [progId])
  ok('  the occurrence is stamped', String(stamped?.last_generated_for).startsWith('2026-07-06'),
    String(stamped?.last_generated_for))

  /* ── 3. The open-sheet gate ──────────────────────────────────────────── */

  const run2 = await generateDueCycleCounts(SITE, actor, '2026-07-20')
  ok('*** while the sheet is open, generating again SKIPS the programme ***',
    run2.generated.filter((g) => g.programmeId === progId).length === 0 &&
      run2.skipped.some((s) => s.programmeId === progId && /not been posted/i.test(s.reason)),
    run2.skipped.find((s) => s.programmeId === progId)?.reason ?? 'no skip recorded')

  const listedOpen = (await listCycleProgrammes(SITE, '2026-07-20')).find((p) => p.id === progId)
  ok('  and the list points at the open sheet', listedOpen?.openTakeId === take1.stockTakeId)

  /* ── 4. Posting unlocks the next occurrence ──────────────────────────── */

  // Count everything exactly right, so posting moves nothing and writes no
  // journal — this suite is about the calendar, not the arithmetic.
  const counts = sheet1!.lines.map((l) => ({ lineId: l.id, countedQty: l.snapshotQty }))
  const savedCounts = await saveCounts(SITE, actor, take1.stockTakeId, counts)
  ok('the sheet counts clean', savedCounts.ok)
  const posted = await postStockTake(SITE, actor, take1.stockTakeId)
  ok('and posts', posted.ok, posted.ok ? posted.documentNumber : posted.error)

  const run3 = await generateDueCycleCounts(SITE, actor, '2026-07-20')
  const mine3 = run3.generated.filter((g) => g.programmeId === progId)
  ok('*** with the sheet posted, the NEXT press generates the next Monday ***',
    mine3.length === 1 && mine3[0].forDate === '2026-07-13',
    mine3[0]?.forDate ?? 'nothing generated')

  /* ── 5. Caught up means quiet ────────────────────────────────────────── */

  // Post the second sheet too, then generate as at a date before the third
  // Monday: nothing is owed, nothing happens.
  const sheet2 = await getStockTake(SITE, mine3[0].stockTakeId)
  await saveCounts(SITE, actor, mine3[0].stockTakeId,
    sheet2!.lines.map((l) => ({ lineId: l.id, countedQty: l.snapshotQty })))
  await postStockTake(SITE, actor, mine3[0].stockTakeId)

  const run4 = await generateDueCycleCounts(SITE, actor, '2026-07-19')
  ok('*** a caught-up programme generates nothing ***',
    run4.generated.filter((g) => g.programmeId === progId).length === 0 &&
      run4.skipped.filter((s) => s.programmeId === progId).length === 0)

  /* ── 6. Inactive programmes are never due ────────────────────────────── */

  const off = await saveCycleProgramme(SITE, actor, progId, {
    name: 'ZCC weekly dept count', locationId: roomId, scope: 'department', scopeRefId: deptId,
    frequency: 'weekly', dayOfWeek: 1, startsOn: '2026-07-06', isActive: false,
  })
  ok('a programme can be switched off', off.ok)
  const run5 = await generateDueCycleCounts(SITE, actor, '2026-12-31')
  ok('*** an inactive programme is never due, however far behind ***',
    run5.generated.filter((g) => g.programmeId === progId).length === 0 &&
      run5.skipped.filter((s) => s.programmeId === progId).length === 0)
  ok('  and the list shows no next date',
    (await listCycleProgrammes(SITE, '2026-12-31')).find((p) => p.id === progId)?.nextDue === null)

  /* ── 7. A generation failure is NOT stamped ──────────────────────────── */

  // A programme scoped to a department with no stocked products: the sheet
  // build refuses, the occurrence must NOT be stamped, and the reason surfaces.
  const emptyDept = await siteExecute(SITE, 'INSERT INTO departments (name) VALUES (?)', ['ZCC empty dept'])
  const doomed = await saveCycleProgramme(SITE, actor, null, {
    name: 'ZCC doomed count', locationId: roomId, scope: 'department', scopeRefId: emptyDept.insertId,
    frequency: 'weekly', dayOfWeek: 1, startsOn: '2026-07-06',
  })
  if (!doomed.ok) { console.log('doomed setup failed'); process.exit(1) }
  const run6 = await generateDueCycleCounts(SITE, actor, '2026-07-20')
  ok('*** a programme whose sheet cannot build skips with the reason ***',
    run6.generated.filter((g) => g.programmeId === doomed.id).length === 0 &&
      run6.skipped.some((s) => s.programmeId === doomed.id),
    run6.skipped.find((s) => s.programmeId === doomed.id)?.reason ?? 'no skip recorded')
  const doomedStamp = await siteQueryOne<any>(
    SITE, 'SELECT last_generated_for FROM cycle_count_programmes WHERE id=?', [doomed.id])
  ok('  and the occurrence is NOT stamped, so it stays retryable',
    doomedStamp?.last_generated_for === null, String(doomedStamp?.last_generated_for))

  /* ── 8. Deleting a programme keeps its history readable ──────────────── */

  await deleteCycleProgramme(SITE, actor, progId)
  const orphan = await siteQueryOne<any>(
    SITE, 'SELECT programme_id, status FROM stock_takes WHERE id=?', [take1.stockTakeId])
  ok('*** deleting a programme keeps its posted sheets, unhooked ***',
    orphan !== null && orphan.programme_id === null && String(orphan.status) === 'posted',
    `programme_id=${orphan?.programme_id} status=${orphan?.status}`)

  /* ── 9. The invariants held throughout ───────────────────────────────── */

  ok('*** every count confirmed the pile, so the stock invariants held ***',
    (await reconcileStock(SITE)).length === stockDriftBefore)
  const journal = await siteQuery<any>(SITE,
    `SELECT b.id FROM journal_batches b
      WHERE b.source='stock_take' AND b.source_doc_id IN (?,?)`,
    [take1.stockTakeId, mine3[0].stockTakeId])
  ok('  and zero-variance posts wrote NO journal', journal.length === 0, `${journal.length} batches`)

  /* ── Clean up ────────────────────────────────────────────────────────── */

  await deleteCycleProgramme(SITE, actor, doomed.id)
  // Posted sheets refuse deleteStockTake by design; the sweep removes them raw,
  // the same way test-stock-takes retires its posted fixtures.
  const drafts = await siteQuery<any>(SITE,
    "SELECT id FROM stock_takes WHERE location_id=? AND status IN ('draft','counting')", [roomId])
  for (const d of drafts) await deleteStockTake(SITE, d.id)
  await sweepStrays()
  const leftovers = await siteQuery<any>(
    SITE, `SELECT id FROM products WHERE code REGEXP '${CODE_PATTERN}'`)
  ok('the run leaves nothing behind', leftovers.length === 0)

  console.log(fails === 0 ? '\nAll cycle count checks passed.' : `\n${fails} FAILED`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
