import { siteTransaction, siteQuery, siteExecute } from '../src/lib/siteDb'
import { nextDocumentNumber, getSequence, updateSequence, verifySequence, formatNumber, previewNext } from '../src/lib/site/sequences'

const SITE = 1
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

async function main() {
  // Fresh sequence for the test so real invoice numbers are untouched.
  await siteExecute(SITE, "DELETE FROM document_sequences WHERE doc_type = 'test_seq'")
  await siteExecute(SITE, "INSERT INTO document_sequences (doc_type, prefix, next_number, padding) VALUES ('test_seq','TST',1,6)")

  // ---- formatting
  ok('formats with padding', formatNumber('INV', 41, 6, null) === 'INV000041', formatNumber('INV', 41, 6, null))
  ok('yearly sequence embeds the year', formatNumber('INV', 41, 6, '2026') === 'INV-2026-000041')

  // ---- sequential issue
  const seen: string[] = []
  for (let i = 0; i < 5; i++) {
    const n = await siteTransaction(SITE, async (tx) => nextDocumentNumber(tx, 'test_seq'))
    seen.push(n)
  }
  ok('issues sequentially', seen.join(',') === 'TST000001,TST000002,TST000003,TST000004,TST000005', seen.join(','))

  // ---- THE CONCURRENCY TEST: 50 simultaneous claims must give 50 distinct numbers
  const concurrent = await Promise.all(
    Array.from({ length: 50 }, () =>
      siteTransaction(SITE, async (tx) => nextDocumentNumber(tx, 'test_seq')),
    ),
  )
  const unique = new Set(concurrent)
  ok('*** 50 CONCURRENT claims -> 50 DISTINCT numbers ***', unique.size === 50, `${unique.size} distinct of ${concurrent.length}`)

  // And they must form an unbroken run with no holes.
  const numbers = concurrent.map((n) => Number(n.replace('TST', ''))).sort((a, b) => a - b)
  const contiguous = numbers.every((n, i) => i === 0 || n === numbers[i - 1] + 1)
  ok('*** and they are contiguous (no holes) ***', contiguous, `${numbers[0]}..${numbers[numbers.length - 1]}`)

  // ---- rollback must NOT consume a number
  const before = (await getSequence(SITE, 'test_seq'))!.nextNumber
  try {
    await siteTransaction(SITE, async (tx) => {
      await nextDocumentNumber(tx, 'test_seq')
      throw new Error('simulated finalise failure')
    })
  } catch { /* expected */ }
  const after = (await getSequence(SITE, 'test_seq'))!.nextNumber
  ok('*** rolled-back finalise leaves NO gap ***', before === after, `before=${before} after=${after}`)

  // ---- missing sequence throws rather than inventing one
  let threw = false
  try {
    await siteTransaction(SITE, async (tx) => nextDocumentNumber(tx, 'no_such_type'))
  } catch { threw = true }
  ok('unknown doc type throws', threw)

  // ---- yearly reset
  await siteExecute(SITE, "UPDATE document_sequences SET reset_period='yearly', period_key='2020', next_number=77 WHERE doc_type='test_seq'")
  const rolled = await siteTransaction(SITE, async (tx) => nextDocumentNumber(tx, 'test_seq'))
  ok('yearly reset restarts at 1 in a new period', rolled.endsWith('-000001'), rolled)
  const seqAfter = (await getSequence(SITE, 'test_seq'))!
  ok('  and stamps the new period', seqAfter.periodKey === String(new Date().getFullYear()), String(seqAfter.periodKey))
  const second = await siteTransaction(SITE, async (tx) => nextDocumentNumber(tx, 'test_seq'))
  ok('  then continues from 2', second.endsWith('-000002'), second)

  // ---- guards
  const back = await updateSequence(SITE, 'test_seq', { prefix: 'TST', nextNumber: 1, padding: 6, resetPeriod: 'none' })
  ok('refuses to move next_number backwards', !back.ok, !back.ok ? back.error : '')
  const badPrefix = await updateSequence(SITE, 'test_seq', { prefix: 'IN2', nextNumber: 9999, padding: 6, resetPeriod: 'none' })
  ok('refuses a digit in the prefix', !badPrefix.ok, !badPrefix.ok ? badPrefix.error : '')
  const fwd = await updateSequence(SITE, 'test_seq', { prefix: 'TST', nextNumber: 9999, padding: 6, resetPeriod: 'none' })
  ok('allows moving forward', fwd.ok)

  // ---- preview claims nothing
  const seqNow = (await getSequence(SITE, 'test_seq'))!
  const preview = previewNext(seqNow)
  const stillSame = (await getSequence(SITE, 'test_seq'))!.nextNumber
  ok('preview does not consume a number', stillSame === seqNow.nextNumber, `${preview} / next stays ${stillSame}`)

  // ---- verifySequence classifies rather than just counting.
  //
  // Deliberately NOT asserting missing === 0 on the shared database: other
  // tests issue numbers and delete their documents afterwards, which leaves
  // exactly the kind of gap verifySequence is built to report. Asserting on a
  // clean history here would make this test depend on what else has run.
  const check = await verifySequence(SITE, 'invoice')
  ok(
    'verifySequence classifies issued vs live vs voided',
    check.live + check.voided + check.missing === check.issued || check.issued === 0,
    JSON.stringify(check),
  )

  await siteExecute(SITE, "DELETE FROM document_sequences WHERE doc_type = 'test_seq'")
  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}
main()
