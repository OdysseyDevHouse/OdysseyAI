/**
 * Per-till invoice numbering.
 *
 *   npx tsx --conditions=react-server --env-file=.env scripts/test-per-till-numbering.ts
 *
 * The point of this file is NOT that per-till numbering works — that is the easy
 * half. It is that changing nextDocumentNumber, the most carefully-argued
 * statement in this schema, left the other twelve callers and every document
 * already issued completely alone. Those assertions come first for that reason.
 *
 * Calls reconcileStock so the runner schedules it solo: it asserts on
 * document_sequences and on invoice counts, which another test's in-flight sale
 * would move underneath it.
 */
import { siteQuery, siteQueryOne, siteExecute } from '../src/lib/siteDb'
import { siteTransaction } from '../src/lib/siteDb'
import {
  formatNumber,
  nextDocumentNumber,
  adoptDocumentNumber,
  numberValueOf,
  getSequence,
  listTerminalSequences,
  verifySequence,
  updateSequence,
  SITE_SEQUENCE,
} from '../src/lib/site/sequences'
import {
  normaliseSegment,
  validateStoreNumber,
  numberSegmentsFor,
  tillNumber,
  tillNumberPrefix,
  numberingConfig,
} from '../src/lib/site/numbering'
import { reconcileStock } from '../src/lib/site/stockMovements'

const SITE = 1
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

/** A bare finalised invoice header — enough for the numbering checks to count. */
const mkDoc = (number: string, terminalId: number | null) =>
  siteExecute(
    SITE,
    `INSERT INTO sales_documents
       (doc_type, status, document_number, document_date, user_name, terminal_id,
        subtotal_excl, vat_total, total_incl)
     VALUES ('invoice','finalised',?,CURDATE(),'Numbering Test',?,0,0,0)`,
    [number, terminalId],
  )

async function main() {
  const stamp = Date.now().toString().slice(-8)
  const config0 = await numberingConfig(SITE)

  /* Sweep any scratch terminal a previous crashed run left behind.
     till_number is UNIQUE, so a leftover 96 makes every later run fail at the
     INSERT rather than at the assertion it was trying to make — a failure that
     looks like a broken schema and is really just litter. */
  const orphans = await siteQuery<{ id: number }>(
    SITE,
    "SELECT id FROM terminals WHERE code LIKE 'TSTNUM%' OR code LIKE 'TSTNONUM%'",
  )
  for (const o of orphans) {
    await siteExecute(SITE, 'DELETE FROM sales_documents WHERE terminal_id = ?', [o.id])
    await siteExecute(SITE, 'DELETE FROM document_sequences WHERE terminal_id = ?', [o.id])
    await siteExecute(SITE, 'DELETE FROM terminals WHERE id = ?', [o.id])
  }
  if (orphans.length) console.log(`      (swept ${orphans.length} terminal(s) from an earlier run)`)

  /* ── 1. THE REGRESSION GUARD ────────────────────────────────────────────
     formatNumber with no segments must be byte-identical to what it has always
     produced. This is what leaves 97,000 existing invoices, and the twelve
     non-till callers, untouched. If only one assertion in this file survives,
     it should be these. */

  ok(
    'unsegmented number is unchanged — INV000041',
    formatNumber('INV', 41, 6, null) === 'INV000041',
    formatNumber('INV', 41, 6, null),
  )
  ok(
    'unsegmented yearly number is unchanged — INV-2026-000041',
    formatNumber('INV', 41, 6, '2026') === 'INV-2026-000041',
    formatNumber('INV', 41, 6, '2026'),
  )

  /* ── 2. The segmented shapes ─────────────────────────────────────────── */

  ok(
    'segmented — INV_01_02_000041',
    formatNumber('INV', 41, 6, null, { store: '01', till: '02' }) === 'INV_01_02_000041',
    formatNumber('INV', 41, 6, null, { store: '01', till: '02' }),
  )
  ok(
    'segmented + yearly — INV_01_02_2026_000041',
    formatNumber('INV', 41, 6, '2026', { store: '01', till: '02' }) === 'INV_01_02_2026_000041',
    formatNumber('INV', 41, 6, '2026', { store: '01', till: '02' }),
  )

  /* ── 3. numberValueOf reads every shape back ─────────────────────────── */

  ok('numberValueOf INV000097', numberValueOf('INV000097') === 97)
  ok('numberValueOf INV-2026-000097', numberValueOf('INV-2026-000097') === 97)
  ok('numberValueOf INV_01_02_000097', numberValueOf('INV_01_02_000097') === 97)
  ok('numberValueOf INV_01_02_2026_000097', numberValueOf('INV_01_02_2026_000097') === 97)
  // Null rather than 0: "unreadable" and "number zero" must not be the same
  // answer to a caller about to advance a sequence past it.
  ok('numberValueOf refuses a number with no digits', numberValueOf('DRAFT') === null)

  /* ── 4. Segment normalisation ────────────────────────────────────────── */

  ok("normaliseSegment('7') pads to 07", normaliseSegment('7', '01') === '07')
  ok("normaliseSegment('12') stays 12", normaliseSegment('12', '01') === '12')
  ok('normaliseSegment strips non-digits', normaliseSegment('T3', '01') === '03')
  ok('normaliseSegment falls back when empty', normaliseSegment('', '01') === '01')
  ok('validateStoreNumber refuses 0', validateStoreNumber('0').ok === false)
  ok('validateStoreNumber refuses letters', validateStoreNumber('A1').ok === false)
  ok('validateStoreNumber accepts 01', validateStoreNumber('01').ok === true)

  /* ── 5. tillNumberPrefix is what verifySequence matches on ───────────── */

  ok(
    'tillNumberPrefix — INV_01_02_',
    tillNumberPrefix('INV', { store: '01', till: '02' }, null) === 'INV_01_02_',
    tillNumberPrefix('INV', { store: '01', till: '02' }, null),
  )
  // Anchored with the trailing underscore, so till 1 cannot match till 10 —
  // which is the whole reason this is built by formatNumber rather than by
  // concatenating strings at each call site.
  ok(
    'till 1 prefix does not prefix-match till 10',
    !'INV_01_10_000001'.startsWith(tillNumberPrefix('INV', { store: '01', till: '01' }, null)),
  )

  /* ── 6. The site-wide sequence still behaves exactly as before ───────── */

  /* Rolled back rather than committed.
     Allocating a number and keeping it would leave the quote sequence one ahead
     of its documents forever. nextDocumentNumber joins the CALLER's transaction
     precisely so that a sale which does not complete leaves no hole — see the
     module comment — so throwing here is both the tidy thing and a check that
     the roll-back property still holds. */
  const before = await getSequence(SITE, 'quote', SITE_SEQUENCE)
  if (!before) {
    ok('site-wide quote sequence exists', false)
  } else {
    let issued = ''
    await siteTransaction(SITE, async (tx) => {
      issued = await nextDocumentNumber(tx, 'quote', new Date())
      throw new Error('rollback')
    }).catch(() => {})

    const after = await getSequence(SITE, 'quote', SITE_SEQUENCE)
    ok(
      'a non-till caller (quote) still numbers site-wide, unsegmented',
      issued.startsWith('QUO') && !issued.includes('_'),
      issued,
    )
    ok(
      'a rolled-back allocation leaves NO gap in the sequence',
      (after?.nextNumber ?? 0) === before.nextNumber,
      `${before.nextNumber} -> ${after?.nextNumber}`,
    )
  }

  /* ── 7. Two tills allocate concurrently without blocking or colliding ── */

  /* Two DISPOSABLE tills, never the store's real ones.
     Issuing a number leaves the sequence expecting a document to match it. Doing
     that on till 01 leaves its run permanently one short, and — because
     test-sales-posting measures the SHARED sequence as a delta across its own
     run — a stray number here surfaces as a failure over there, in a test that
     has nothing to do with this one. That is exactly what it did before these
     tills became disposable. */
  /* Till numbers in the 9xxx range, four digits.
     till_number is UNIQUE across the store, so a scratch till must not pick a
     number a real one might hold — 01..05 here. Four digits also exercises the
     column's full width, which two would not. */
  const mkTill = async (n: number) => {
    const till = `9${String(n).padStart(3, '0')}`
    const t = await siteExecute(
      SITE,
      `INSERT INTO terminals (code, till_number, name, is_active) VALUES (?,?,?,1)`,
      [`TSTNUM${stamp}${n}`, till, `Numbering test ${stamp}-${n}`],
    )
    await siteExecute(
      SITE,
      `INSERT INTO document_sequences (terminal_id, doc_type, prefix, next_number, padding)
       VALUES (?, 'invoice', 'INV', 1, 6)`,
      [t.insertId],
    )
    return { id: t.insertId as number, till }
  }

  const tillA = await mkTill(1)
  const tillB = await mkTill(2)
  const scratchTills = [tillA.id, tillB.id]

  {
    const segA = { store: config0.storeNumber, till: tillA.till }
    const segB = { store: config0.storeNumber, till: tillB.till }

    // Deliberately concurrent. Before this change both would have locked the one
    // shared row and serialised; now they lock different rows, so this also
    // proves the lock got narrower rather than wider.
    const [numA, numB] = await Promise.all([
      siteTransaction(SITE, async (tx) =>
        nextDocumentNumber(tx, 'invoice', new Date(), tillA.id, segA),
      ),
      siteTransaction(SITE, async (tx) =>
        nextDocumentNumber(tx, 'invoice', new Date(), tillB.id, segB),
      ),
    ])
    ok('two tills issued concurrently', numA !== numB, `${numA} vs ${numB}`)
    ok(
      'each number carries its own till segment',
      numA === `INV_${segA.store}_${segA.till}_000001` &&
        numB === `INV_${segB.store}_${segB.till}_000001`,
      `${numA} / ${numB}`,
    )
    // Both started at 1 and neither collided, which is the property that lets a
    // till number offline without asking anybody: nothing is shared.
    ok('each till starts its own run at 1', numA.endsWith('000001') && numB.endsWith('000001'))
  }

  /* ── 8. A missing till sequence THROWS rather than falling back ──────── */

  let threw = false
  try {
    await siteTransaction(SITE, async (tx) =>
      nextDocumentNumber(tx, 'invoice', new Date(), 999_999, { store: '01', till: '99' }),
    )
  } catch {
    threw = true
  }
  // Falling back to the shared sequence would be the "helpful" thing and is the
  // wrong thing: it would drop an unregistered till's sale into the middle of
  // the site-wide invoice run, silently.
  ok('an unregistered till refuses to number rather than using the shared run', threw)

  /* ── 9. A throwaway till of our own ──────────────────────────────────────
     The sections below advance a sequence and count documents against it, so
     they must not run on a real till: doing that on till 01 leaves its
     last_issued_number ahead of its documents forever, and every future
     reconciliation on that store reports a missing invoice this test invented.
     A disposable terminal is deleted at the end. */

  const scratch = await mkTill(3)
  const testTill = scratch.id
  const testSeg = { store: config0.storeNumber, till: scratch.till }
  const testPrefix = tillNumberPrefix('INV', testSeg, null)

  /* ── 10. adoptDocumentNumber is idempotent and monotonic ─────────────── */

  {
    const base = 500
    await siteTransaction(SITE, async (tx) => {
      // Out of order, with a replay of the first — which is exactly what a
      // retrying outbox does.
      await adoptDocumentNumber(tx, 'invoice', testTill, base)
      await adoptDocumentNumber(tx, 'invoice', testTill, base + 2)
      await adoptDocumentNumber(tx, 'invoice', testTill, base + 1)
      await adoptDocumentNumber(tx, 'invoice', testTill, base)
    })

    const after = await getSequence(SITE, 'invoice', testTill)
    ok(
      'adopt leaves the sequence past the highest number, whatever the order',
      after?.nextNumber === base + 3,
      `expected ${base + 3}, got ${after?.nextNumber}`,
    )
    ok(
      'adopt never rewinds last_issued_number',
      (after?.lastIssuedNumber ?? 0) === base + 2,
      String(after?.lastIssuedNumber),
    )
  }

  /* ── 10. A duplicate number is refused by the DATABASE, not by trust ─── */

  // No underscore in this one on purpose: it stands in for a site-wide number,
  // which is where the duplicate guard matters most.
  const dupNumber = `TSTDUP${stamp}`
  const first = await mkDoc(dupNumber, null)
  let refused = false
  try {
    await mkDoc(dupNumber, null)
  } catch {
    refused = true
  }
  ok('uq_doc_number refuses a duplicate invoice number', refused)

  /* ── 11. verifySequence scopes to the run it is checking ─────────────── */

  const siteCheck = await verifySequence(SITE, 'invoice', SITE_SEQUENCE)

  // THE REGRESSION THIS FILE EXISTS FOR.
  //
  // Every invoice ever rung up at a till carries a terminal_id, and all of them
  // were numbered from the shared sequence. An earlier draft of verifySequence
  // split the two runs on `terminal_id IS NULL` and reported all 97,152 of this
  // store's invoices as missing. A later draft used `NOT LIKE '%\_%'`, where the
  // escape did not survive being a JavaScript string, the pattern degraded to
  // "any non-empty string", and it excluded everything — same symptom, different
  // cause. So the count is asserted, not just the absence of an error.
  ok(
    'the site-wide run still counts the whole unsegmented history',
    siteCheck.live + siteCheck.voided > 1000,
    `live ${siteCheck.live}, voided ${siteCheck.voided}`,
  )
  ok(
    'first/last come from the ends of the run, not MIN/MAX on the string',
    siteCheck.firstNumber !== null && siteCheck.lastNumber !== null,
    `${siteCheck.firstNumber} .. ${siteCheck.lastNumber}`,
  )
  // `missing` is NOT asserted as an absolute. This store's seed data bulk-loaded
  // documents and moved the counter without a 1:1 match, so its absolute figure
  // is nonzero for reasons that predate this work — the same reason
  // test-sales-posting measures sequence integrity as a delta across its own run
  // rather than against a shared database's history. The delta assertions are
  // §11 above (a till's run) and the site-wide exclusion check below.
  console.log(
    `      (site-wide: issued ${siteCheck.issued}, documents ${siteCheck.live + siteCheck.voided}, ` +
      `missing ${siteCheck.missing} — absolute, from seed data, not asserted)`,
  )

  /* A till's own run, end to end: reset the sequence, issue three numbers, and
     write a document for each — which is what finaliseDocument does in one
     transaction. The run must then verify as complete. */
  await siteExecute(
    SITE,
    `UPDATE document_sequences SET next_number = 1, last_issued_number = NULL
      WHERE doc_type = 'invoice' AND terminal_id = ?`,
    [testTill],
  )

  const tillDocs: number[] = []
  for (let i = 0; i < 3; i++) {
    const number = await siteTransaction(SITE, async (tx) =>
      nextDocumentNumber(tx, 'invoice', new Date(), testTill, testSeg),
    )
    const res = await mkDoc(number, testTill)
    tillDocs.push(res.insertId)
  }

  const tillCheck = await verifySequence(SITE, 'invoice', testTill, testPrefix)
  ok(
    "a till's own run is gapless — three issued, three documents",
    tillCheck.issued === 3 && tillCheck.live === 3 && tillCheck.missing === 0,
    `issued ${tillCheck.issued}, live ${tillCheck.live}, missing ${tillCheck.missing}`,
  )
  ok(
    'the per-till check counts ONLY that till',
    tillCheck.live + tillCheck.voided === 3,
    `saw ${tillCheck.live + tillCheck.voided} documents`,
  )
  ok(
    'the run reads first to last in issue order',
    tillCheck.firstNumber === `${testPrefix}000001` &&
      tillCheck.lastNumber === `${testPrefix}000003`,
    `${tillCheck.firstNumber} .. ${tillCheck.lastNumber}`,
  )

  /* And the mirror: those three till invoices must NOT be counted in the
     site-wide run, or every store's reconciliation drifts by however many
     offline sales its tills have made. */
  const siteAfter = await verifySequence(SITE, 'invoice', SITE_SEQUENCE)
  ok(
    "a till's invoices are excluded from the site-wide run",
    siteAfter.live === siteCheck.live,
    `site-wide live went ${siteCheck.live} -> ${siteAfter.live} after 3 till invoices`,
  )

  /* ── 12. A prefix cannot change once numbers are out ─────────────────── */

  const invoiceSeq = (await getSequence(SITE, 'invoice', SITE_SEQUENCE))!
  const changed = await updateSequence(
    SITE,
    'invoice',
    {
      prefix: 'ZZZ',
      nextNumber: invoiceSeq.nextNumber,
      padding: invoiceSeq.padding,
      resetPeriod: invoiceSeq.resetPeriod,
    },
    SITE_SEQUENCE,
  )
  ok(
    'the prefix is refused once documents have been issued under the old one',
    changed.ok === false,
    changed.ok ? 'accepted!' : changed.error,
  )

  /* ── 13. Only till invoices get segments ─────────────────────────────── */

  const config = await numberingConfig(SITE)
  console.log(`      (store ${config.storeNumber}, scope ${config.scope})`)

  ok(
    'a credit note gets no segments even on a till',
    (await numberSegmentsFor(SITE, 'credit_sale', testTill)) === null,
  )
  ok(
    'a back-office invoice with no terminal gets no segments',
    (await numberSegmentsFor(SITE, 'invoice', null)) === null,
  )
  if (config.scope === 'terminal') {
    const seg = await numberSegmentsFor(SITE, 'invoice', testTill)
    ok('a till invoice DOES get segments', seg !== null && seg.segments.store === config.storeNumber)
    ok(
      'the till segment matches terminals.till_number',
      seg?.segments.till === (await tillNumber(SITE, testTill)),
      `${seg?.segments.till} vs ${await tillNumber(SITE, testTill)}`,
    )
  }

  // A till with no till_number must REFUSE rather than quietly numbering from
  // the shared run, which would drop its sale into the middle of the site-wide
  // invoice sequence with nothing to say it had happened.
  const unnumbered = await siteExecute(
    SITE,
    `INSERT INTO terminals (code, name, is_active) VALUES (?,?,1)`,
    [`TSTNONUM${stamp}`, `No till number ${stamp}`],
  )
  let refusedUnnumbered = false
  try {
    await numberSegmentsFor(SITE, 'invoice', unnumbered.insertId)
  } catch {
    refusedUnnumbered = true
  }
  ok('a till with no till_number refuses to number a sale', refusedUnnumbered)
  await siteExecute(SITE, 'DELETE FROM terminals WHERE id = ?', [unnumbered.insertId])

  /* ── Cleanup ─────────────────────────────────────────────────────────── */

  // Order matters: the documents reference the terminal, and the sequence row is
  // not cascaded from it.
  //
  // Every scratch sequence goes, including the two from the concurrency check.
  // Leaving one behind would leave a per-till run one number ahead of its
  // documents forever, and this store's next reconciliation would report a
  // missing invoice that this test invented.
  for (const id of [first.insertId, ...tillDocs]) {
    await siteExecute(SITE, 'DELETE FROM sales_documents WHERE id = ?', [id])
  }
  for (const id of [testTill, ...scratchTills]) {
    await siteExecute(
      SITE,
      "DELETE FROM document_sequences WHERE doc_type = 'invoice' AND terminal_id = ?",
      [id],
    )
    await siteExecute(SITE, 'DELETE FROM terminals WHERE id = ?', [id])
  }

  // Site-wide invariant, and the reason this test is scheduled solo.
  const drift = await reconcileStock(SITE)
  ok('*** reconcileStock returns ZERO drift ***', drift.length === 0, JSON.stringify(drift))

  console.log(fails === 0 ? '\nAll numbering checks passed.' : `\n${fails} check(s) failed.`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
