/**
 * Cash-up numbering (233).
 *
 * A cash-up is numbered the way an invoice is — CSH_01_000001 — rather than
 * being identified by a row id that means something different at every branch.
 * This proves the four things that makes true:
 *
 *   1. the SHAPE is right, and carries the store segment but no till segment;
 *   2. the number is allocated at OPEN, so a running shift can be referred to;
 *   3. two shifts never share one, under concurrency;
 *   4. verifySequence can audit the run, which is what registering `cashup` in
 *      OWN_TABLE_TYPES bought — and the reason 233 adds `shifts.status`.
 *
 *   npm run test:cashup-numbers
 */
import { siteExecute, siteQuery, siteQueryOne } from '../src/lib/siteDb'
import { openShift, closeShift, getShift, listShifts } from '../src/lib/site/shifts'
import { getSequence, verifySequence, SITE_SEQUENCE } from '../src/lib/site/sequences'
import { getTenderByCode } from '../src/lib/site/tenderTypes'
import { getSetting } from '../src/lib/site/settings'
import { normaliseSegment } from '../src/lib/site/numbering'
import { formatNumber, numberValueOf } from '../src/lib/numberFormat'

const SITE = 1
const actor = { userId: 1, userName: 'Cashup Number Test' }

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

/**
 * The lowest till number nobody is using.
 *
 * Queried, not hardcoded: `till_number` is UNIQUE and a fixed value fails at the
 * INSERT the moment an earlier crashed run leaves one behind — a failure that
 * looks like a broken schema and is really just litter. Counts DOWN from 99 so a
 * scratch till never takes a number a real one would want.
 */
async function freeTillNumber(): Promise<string> {
  const rows = await siteQuery<any>(
    SITE,
    'SELECT till_number FROM terminals WHERE till_number IS NOT NULL',
  )
  const taken = new Set(rows.map((r: any) => String(r.till_number)))
  for (let n = 99; n >= 50; n--) {
    if (!taken.has(String(n))) return String(n)
  }
  throw new Error('No free till number in 50..99 — sweep the scratch terminals.')
}

async function main() {
  const stamp = Date.now().toString().slice(-8)

  /* Sweep terminals an earlier crashed run left behind, so the unique till
     number is free. Only ones holding no sales — a scratch till that somehow
     issued a document is holding a real row, and deleting it orphans that
     sale. */
  const orphans = await siteQuery<any>(
    SITE,
    `SELECT id FROM terminals
      WHERE code LIKE 'CN%'
        AND (SELECT COUNT(*) FROM sales_documents d WHERE d.terminal_id = terminals.id) = 0`,
  )
  for (const o of orphans) {
    await siteExecute(SITE, 'DELETE FROM shifts WHERE terminal_id = ?', [o.id]).catch(() => null)
    await siteExecute(SITE, 'DELETE FROM document_sequences WHERE terminal_id = ?', [
      o.id,
    ]).catch(() => null)
    await siteExecute(SITE, 'DELETE FROM terminals WHERE id = ?', [o.id]).catch(() => null)
  }

  // ── The sequence exists at all ──────────────────────────────────────────
  const sequence = await getSequence(SITE, 'cashup')
  ok('a cashup sequence exists', sequence !== null, 'run site-migrate for 233')
  if (!sequence) process.exit(1)
  ok('it is the SITE-wide sequence, not a till one', sequence.terminalId === SITE_SEQUENCE)
  ok('prefixed CSH', sequence.prefix === 'CSH', sequence.prefix)
  ok('padded to 6', sequence.padding === 6, String(sequence.padding))
  /* No yearly reset. A register that restarts each January makes CSH_01_000001
     ambiguous across years, and the store segment cannot disambiguate a year. */
  ok('does not reset yearly', sequence.resetPeriod === 'none', sequence.resetPeriod)

  const store = normaliseSegment(await getSetting(SITE, 'store_number'), '01')

  const term = await siteExecute(
    SITE,
    'INSERT INTO terminals (code, name, till_number) VALUES (?,?,?)',
    [`CN${stamp}`.slice(0, 24), 'Cash-up number test till', await freeTillNumber()],
  )
  const terminalId = term.insertId

  // ── 1 & 2. Allocated at OPEN, in the right shape ────────────────────────
  const before = await getSequence(SITE, 'cashup')
  const opened = await openShift(SITE, actor, terminalId, 100)
  ok('*** shift opened ***', opened.ok, opened.ok ? '' : (opened as any).error)
  if (!opened.ok) process.exit(1)

  const shift = await getShift(SITE, opened.shiftId)
  ok('the shift exists', shift !== null)
  const number = shift?.documentNumber ?? null

  /* The whole point of allocating at open: a RUNNING shift can be referred to.
     Asserted against isOpen so this cannot silently pass by testing a shift
     that had already closed. */
  ok('an OPEN shift already carries its number', shift?.isOpen === true && number !== null, String(number))

  const expected = formatNumber('CSH', before!.nextNumber, 6, null, { store })
  ok(`the number is ${expected}`, number === expected, String(number))

  /* The SHAPE, asserted directly rather than only against formatNumber — that
     function is half of what is being tested, so a bug inside it would agree
     with itself. Three underscore-separated fields and no more: a till segment
     would make four, and a user-mode shift has no till to put there. */
  ok('it reads CSH_<store>_<counter>', /^CSH_\d{2,}_\d{6}$/.test(number ?? ''), String(number))
  ok('it carries NO till segment', (number ?? '').split('_').length === 3, String(number))
  ok('the store segment is this store', (number ?? '').split('_')[1] === store, store)
  ok('numberValueOf reads the counter back', numberValueOf(number ?? '') === before!.nextNumber)

  // The sequence actually moved, rather than the number being formatted from a
  // counter nobody claimed.
  const after = await getSequence(SITE, 'cashup')
  ok('the sequence advanced by one', after!.nextNumber === before!.nextNumber + 1)
  ok('last_issued_number is the number issued', after!.lastIssuedNumber === before!.nextNumber)

  // ── The number survives the close, and the status moves with it ─────────
  const cash = await getTenderByCode(SITE, 'CASH')
  if (!cash) {
    console.log('missing CASH tender')
    process.exit(1)
  }
  /* Counted to exactly the float so the variance is zero: a clean drawer skips
     the GL mirror entirely, which keeps this test out of the ledger and out of
     the cleanup that would otherwise need. Variance itself is test-cashup's job. */
  const closed = await closeShift(SITE, actor, opened.shiftId, [
    { tenderTypeId: cash.id, amount: 100 },
  ])
  ok('*** shift closed clean ***', closed.ok, closed.ok ? '' : (closed as any).error)

  const reread = await getShift(SITE, opened.shiftId)
  ok('the number is unchanged by closing', reread?.documentNumber === number, String(reread?.documentNumber))

  /* 233 adds `status` for verifySequence's contract alone. It has to move with
     closed_at or the audit below counts an open shift as a cancelled number. */
  const statusRow = await siteQueryOne<any>(SITE, 'SELECT status FROM shifts WHERE id = ?', [
    opened.shiftId,
  ])
  ok('status followed closed_at to "closed"', String(statusRow?.status) === 'closed', String(statusRow?.status))

  ok('listShifts publishes the number', (await listShifts(SITE, { terminalId })).some((s) => s.documentNumber === number))

  // ── 3. Two shifts never share a number ──────────────────────────────────
  /*
   * Opened CONCURRENTLY, on separate tills, because that is the only way the
   * failure this guards against can appear. nextDocumentNumber's atomic UPDATE
   * takes the row lock and a sequential test would pass with a broken
   * SELECT-then-UPDATE implementation — see the crux note in sequences.ts.
   */
  const extraTills: number[] = []
  for (let i = 0; i < 4; i++) {
    const t = await siteExecute(
      SITE,
      'INSERT INTO terminals (code, name, till_number) VALUES (?,?,?)',
      [`CN${stamp}X${i}`.slice(0, 24), `Cash-up race till ${i}`, await freeTillNumber()],
    )
    extraTills.push(t.insertId)
  }

  const raced = await Promise.all(extraTills.map((t) => openShift(SITE, actor, t, 0)))
  const racedIds = raced.flatMap((r) => (r.ok ? [r.shiftId] : []))
  ok('every concurrent shift opened', racedIds.length === extraTills.length)

  const racedShifts = await Promise.all(racedIds.map((id) => getShift(SITE, id)))
  const racedNumbers = racedShifts.map((s) => s?.documentNumber ?? null)
  ok('every concurrent shift got a number', racedNumbers.every((n) => n !== null), JSON.stringify(racedNumbers))
  ok(
    '*** no two shifts share a number ***',
    new Set(racedNumbers).size === racedNumbers.length,
    JSON.stringify(racedNumbers),
  )

  /* Consecutive, not merely distinct. Distinctness alone would also hold if the
     sequence skipped — and a skipped number is the one thing the audit below
     exists to prove never happens. */
  const racedCounters = racedNumbers.map((n) => numberValueOf(n ?? '') ?? -1).sort((a, b) => a - b)
  ok(
    'and they are consecutive',
    racedCounters.every((v, i) => i === 0 || v === racedCounters[i - 1] + 1),
    JSON.stringify(racedCounters),
  )

  // ── 4. The run audits ───────────────────────────────────────────────────
  /*
   * The reason `cashup` is registered in OWN_TABLE_TYPES. Without it this
   * function looks in sales_documents, finds no CSH numbers, and reports every
   * cash-up ever opened as MISSING — the exact omission that bit stock takes,
   * job cards, customer assets and laybys in turn.
   *
   * ── WHY `missing` IS NOT ASSERTED TO BE ZERO ──────────────────────────
   *
   * It cannot be, on a dev site, and a test that demanded it would fail for a
   * reason that is not a bug. Every previous run of THIS file deleted its
   * shifts on the way out while deliberately leaving the counter where it
   * stood — see the cleanup note below. Those numbers are issued with no row to
   * show for them, which is precisely what `missing` counts, so it climbs by
   * five each run and no amount of correct code brings it back to zero.
   *
   * Deleting a numbered row is not something the app can do; only a test is
   * that rude. So what is asserted is what the app guarantees: the numbers
   * THIS run issued are all present and accounted for. The audit itself is
   * still exercised — it has to find and classify them.
   */
  const check = await verifySequence(SITE, 'cashup')
  ok('the audit reaches shifts, not sales_documents', (check.lastNumber ?? '').startsWith('CSH_'), String(check.lastNumber))
  ok('the audit sees the run this test issued', check.live >= 1 + racedIds.length, JSON.stringify(check))

  /* Every number this run claimed is on a row. THAT is the invariant the app
     owns — the sequence and the shift are written in one transaction, so a
     claimed number with no shift behind it means the transaction leaked. */
  const mine = [number, ...racedNumbers].filter(Boolean) as string[]
  const found = await siteQuery<any>(
    SITE,
    `SELECT document_number FROM shifts WHERE document_number IN (${mine.map(() => '?').join(',')})`,
    mine,
  )
  ok(
    '*** every number this run issued has a shift behind it ***',
    found.length === mine.length,
    `${found.length} of ${mine.length}`,
  )

  /* And no OTHER shift crept onto one of them. The unique index makes this
     impossible, which is the point of asserting it: the guard is load-bearing
     and a migration that dropped it would otherwise go unnoticed. */
  const dupes = await siteQueryOne<any>(
    SITE,
    `SELECT COUNT(*) n FROM (
       SELECT document_number FROM shifts
        WHERE document_number IS NOT NULL
        GROUP BY document_number HAVING COUNT(*) > 1
     ) d`,
  )
  ok('*** no number is shared by two shifts, site-wide ***', Number(dupes?.n ?? 0) === 0, String(dupes?.n))

  // ── Cleanup ─────────────────────────────────────────────────────────────
  /*
   * The shifts go, but the SEQUENCE is deliberately left where it stands. Winding
   * next_number back to reclaim the test's numbers is how a later run collides
   * with a number this one already used — and a gap in a cash-up run is exactly
   * the explainable kind. Deleting the rows is what a voided document does.
   */
  const allTills = [terminalId, ...extraTills]
  for (const t of allTills) {
    await siteExecute(SITE, 'DELETE FROM shift_counts WHERE shift_id IN (SELECT id FROM shifts WHERE terminal_id = ?)', [t])
    await siteExecute(SITE, 'DELETE FROM shifts WHERE terminal_id = ?', [t])
    await siteExecute(SITE, 'DELETE FROM document_sequences WHERE terminal_id = ?', [t])
    await siteExecute(SITE, 'DELETE FROM terminals WHERE id = ?', [t])
  }

  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}
main()
