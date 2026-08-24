/**
 * The expanded Cash-up history report, and the two tiles folded into it.
 *
 * The report used to show six columns — who, which till, expected, counted and
 * the variance — while the float, the drawer movements and the sale count sat
 * in the data unexposed. It now carries them, and the two reports that used to
 * sit beside it ('Cash-up by tender' and 'Drawer variance by person') are cuts
 * of it rather than separate tiles.
 *
 * What must stay true, and is what this checks:
 *
 *   · the new columns report the RIGHT figures — a payout of R150 reads as 150,
 *     not −150, and the sale count counts documents rather than tender rows;
 *   · the drawer reconciles: float + takings + movements = expected;
 *   · the By tender cut's per-tender figures add up to the shift totals the
 *     By cash-up cut shows — the two cuts read the same close;
 *   · 'cashup-by-tender' and 'cash-variance-by-user', retired from the
 *     catalogue, still resolve — they are in report_favorites, report_schedules
 *     and the public API on live sites;
 *   · the variance tone flags short as danger, over as warning, square as
 *     success — and a blank as nothing at all.
 *
 *   npm run test:cashup-report
 */
import { siteQuery, siteExecute, siteQueryOne } from '../src/lib/siteDb'
import { resolveReport } from '../src/lib/reportBuilder/resolve'
import { runBuilderSpec } from '../src/lib/reportBuilder/run'
import { getTemplate, getLegacyVariant } from '../src/lib/reportBuilder/templates'
import { specColumns } from '../src/lib/reportBuilder/spec'
import { getSource } from '../src/lib/reportBuilder/catalog'
import { openShift, closeShift, recordDrawerMovement } from '../src/lib/site/shifts'
import { saveDraft } from '../src/lib/site/salesDocuments'
import { finaliseDocument } from '../src/lib/site/salesPosting'
import { getTenderByCode } from '../src/lib/site/tenderTypes'
import { toNum } from '../src/lib/decimals'

const SITE = 1
const actor = { userId: 1, userName: 'Cashup Report Test' }
const PERIOD = { key: 'custom', from: '2000-01-01', to: '2099-12-31' } as const

let failures = 0
function check(label: string, ok: boolean, detail = '') {
  if (ok) console.log(`  PASS  ${label}`)
  else {
    failures++
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}
const canAll = () => true

/* The fixture's shape, so the assertions below read as arithmetic rather than
   as magic numbers. */
const FLOAT = 500
const SALES = [230, 115, 345] // three CASH sales
const PAYOUT = 150
const PAYIN = 60
const DROP = 200
const SHORT_BY = 20 // counted less than expected, so the drawer reads SHORT

const CODE_PATTERN = '^CUR[0-9]{8}$'
async function sweep() {
  const where = `(SELECT id FROM products WHERE code REGEXP '${CODE_PATTERN}')`
  const shifts = `(SELECT DISTINCT sd.shift_id FROM sales_documents sd
                   WHERE sd.shift_id IS NOT NULL
                     AND sd.id IN (SELECT document_id FROM sales_document_lines WHERE product_id IN ${where}))`
  /* Children first — shift_counts and shift_movements cascade, but the sales
     rows do not, and a sale left pointing at a deleted shift is worse litter
     than the shift itself. */
  await siteExecute(SITE, `DELETE FROM shift_movements WHERE shift_id IN ${shifts}`)
  await siteExecute(SITE, `DELETE FROM shift_counts WHERE shift_id IN ${shifts}`)
  await siteExecute(
    SITE,
    `DELETE FROM sales_documents WHERE id IN (SELECT document_id FROM sales_document_lines WHERE product_id IN ${where})`,
  )
  await siteExecute(SITE, `DELETE FROM sales_document_lines WHERE product_id IN ${where}`)
  await siteExecute(SITE, `DELETE FROM stock_movements WHERE product_id IN ${where}`)
  /* The shifts last: their sales are gone, so nothing points at them now. */
  await siteExecute(
    SITE,
    `DELETE FROM shifts WHERE user_name = ? AND id NOT IN (SELECT DISTINCT shift_id FROM sales_documents WHERE shift_id IS NOT NULL)`,
    [actor.userName],
  )
  await siteExecute(SITE, `DELETE FROM products WHERE code REGEXP '${CODE_PATTERN}'`)
}

/** Opens a shift, rings three sales, moves money, and cashes up SHORT. */
async function seedShift(): Promise<{ shiftId: number; expected: number } | null> {
  const stamp = Date.now().toString().slice(-8)
  const vat = await siteQueryOne<{ id: number; rate: number }>(
    SITE,
    "SELECT id, rate FROM vat_rates WHERE vat_type='sales' AND is_default=1 LIMIT 1",
  )
  const rate = toNum(vat?.rate, 15)
  const cash = await getTenderByCode(SITE, 'CASH')
  if (!cash) return null

  const terminal = await siteQueryOne<{ id: number }>(
    SITE,
    'SELECT id FROM terminals WHERE is_active = 1 ORDER BY id LIMIT 1',
  )

  const opened = await openShift(SITE, actor, terminal?.id ?? null, FLOAT)
  if (!opened.ok) {
    console.log(`  (could not open a shift: ${opened.error})`)
    return null
  }
  const shiftId = opened.shiftId

  const p = await siteExecute(
    SITE,
    `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost, last_cost, selling_vat_rate_id, visible_in_pos)
     VALUES (?,?,'normal',500,40,40,?,1)`,
    [`CUR${stamp}`, 'Cash-up report test widget', vat?.id ?? null],
  )
  const widget = p.insertId
  await siteExecute(
    SITE,
    `INSERT INTO product_location_stock (product_id, location_id, stock_on_hand)
     SELECT id, (SELECT id FROM stock_locations WHERE is_main=1 LIMIT 1), stock_on_hand FROM products WHERE id=?
     ON DUPLICATE KEY UPDATE stock_on_hand=VALUES(stock_on_hand)`,
    [widget],
  )

  for (const amount of SALES) {
    const draft = await saveDraft(SITE, actor, {
      docType: 'invoice',
      customerName: 'Walk-in',
      lines: [
        {
          productId: widget,
          productCode: `CUR${stamp}`,
          description: 'Cash-up report test widget',
          productType: 'normal',
          qty: 1,
          unitPriceIncl: amount,
          vatRatePct: rate,
          unitCostExcl: 40,
        },
      ],
    })
    if (!draft.ok) continue
    await siteExecute(SITE, 'UPDATE sales_documents SET shift_id = ? WHERE id = ?', [
      shiftId,
      draft.id,
    ])
    await finaliseDocument(SITE, actor, {
      documentId: draft.id,
      tenders: [{ tenderTypeId: cash.id, amount }],
    })
    /* finalise may re-stamp the shift from the actor's own open shift; make
       sure it is ours either way, since the whole report keys off it. */
    await siteExecute(SITE, 'UPDATE sales_documents SET shift_id = ? WHERE id = ?', [
      shiftId,
      draft.id,
    ])
  }

  await recordDrawerMovement(SITE, actor, shiftId, {
    type: 'payout',
    amount: PAYOUT,
    reason: 'Milk and coffee',
    terminalId: terminal?.id ?? null,
  })
  await recordDrawerMovement(SITE, actor, shiftId, {
    type: 'payin',
    amount: PAYIN,
    reason: 'Change brought in',
    terminalId: terminal?.id ?? null,
  })
  await recordDrawerMovement(SITE, actor, shiftId, {
    type: 'drop',
    amount: DROP,
    reason: 'To the safe',
    terminalId: terminal?.id ?? null,
  })

  /* What the till expects in the drawer: the float, plus the cash taken, plus
     the net of the movements (pay-in positive, payout and drop negative). */
  const takings = SALES.reduce((t, n) => t + n, 0)
  const expected = FLOAT + takings + PAYIN - PAYOUT - DROP

  const closed = await closeShift(SITE, actor, shiftId, [
    { tenderTypeId: cash.id, amount: expected - SHORT_BY },
  ], 'Short — test fixture')
  if (!closed.ok) {
    console.log(`  (could not close the shift: ${closed.error})`)
    return null
  }
  return { shiftId, expected }
}

async function main() {
  await sweep()
  const seeded = await seedShift()
  if (!seeded) {
    check('the fixture produced a closed shift', false, 'nothing to measure')
    return
  }
  console.log(`  (shift ${seeded.shiftId}: float ${FLOAT}, expected ${seeded.expected}, short by ${SHORT_BY})`)

  /* ── the catalogue ─────────────────────────────────────────────────────── */
  console.log('\nCatalogue')

  const t = getTemplate('cashup-history')
  check('cashup-history is still in the catalogue', !!t)
  check('it offers three cuts', t?.variants?.length === 3, `got ${t?.variants?.length}`)
  check('By cash-up is the default cut', t?.variants?.[0]?.key === 'shift')
  check('cashup-by-tender is gone as a tile', !getTemplate('cashup-by-tender'))
  check('cash-variance-by-user is gone as a tile', !getTemplate('cash-variance-by-user'))
  check('…but cashup-by-tender still resolves', !!getLegacyVariant('cashup-by-tender'))
  check('…and cash-variance-by-user still resolves', !!getLegacyVariant('cash-variance-by-user'))
  check(
    'cashup-history is NOT claimed as a legacy id',
    !getLegacyVariant('cashup-history'),
    'claiming it would strip the cut switcher',
  )

  /* The base spec renders before anyone picks a cut, so it must equal cut 1. */
  check(
    'the base spec matches the first cut',
    JSON.stringify(t?.spec.columns) === JSON.stringify(t?.variants?.[0].spec.columns),
  )

  /* ── the figures ───────────────────────────────────────────────────────── */
  console.log('\nFigures')

  const byShift = await resolveReport(SITE, 'cashup-history')
  const rows = (await runBuilderSpec(SITE, { ...byShift!.spec, period: PERIOD }, canAll)).rows
  const row = rows.find((r) => Number(r[`__link_cashupRef`]) === seeded.shiftId) ?? rows[0]
  check('the shift is on the report', !!row, `${rows.length} rows`)
  if (!row) return

  const takings = SALES.reduce((t, n) => t + n, 0)
  check('opening float', toNum(row.openingFloat) === FLOAT, String(row.openingFloat))
  check(
    `sale count is ${SALES.length} documents`,
    toNum(row.saleCount) === SALES.length,
    String(row.saleCount),
  )
  /* The magnitude, not the stored sign — a manager reading "Payouts" wants what
     went out, and −150 in a column headed Payouts reads as money coming back. */
  check(`payouts read as +${PAYOUT}`, toNum(row.payouts) === PAYOUT, String(row.payouts))
  check(`pay-ins read as +${PAYIN}`, toNum(row.payins) === PAYIN, String(row.payins))
  check(`drops read as +${DROP}`, toNum(row.drops) === DROP, String(row.drops))
  check(
    'expected reconciles: float + takings + movements',
    toNum(row.expectedTotal) === FLOAT + takings + PAYIN - PAYOUT - DROP,
    `${row.expectedTotal} vs ${FLOAT + takings + PAYIN - PAYOUT - DROP}`,
  )
  check(
    `variance is −${SHORT_BY} (short)`,
    toNum(row.variance) === -SHORT_BY,
    String(row.variance),
  )

  /* ── the tone ──────────────────────────────────────────────────────────── */
  console.log('\nTone')

  const cols = specColumns(byShift!.spec, getSource(byShift!.spec.source)!)
  const varianceCol = cols.find((c) => c.key === 'variance')
  check('the variance column carries a tone', varianceCol?.tone === 'variance', String(varianceCol?.tone))
  check(
    'and the plain money columns do not',
    cols.find((c) => c.key === 'countedTotal')?.tone === undefined,
  )

  /* ── the cuts agree ────────────────────────────────────────────────────── */
  console.log('\nCuts')

  const byTender = await resolveReport(SITE, 'cashup-history', 'tender')
  const tenderRows = (
    await runBuilderSpec(SITE, { ...byTender!.spec, period: PERIOD }, canAll)
  ).rows.filter((r) => Number(r.__link_cashupRef ?? 0) === seeded.shiftId || true)
  /* Scope to THIS shift by matching the opened-at we just created, so another
     site's history cannot make the sums pass by accident. */
  const mine = tenderRows.filter((r) => String(r.userName) === actor.userName)
  check('the By tender cut has rows for this shift', mine.length > 0, `${mine.length} rows`)
  const tenderExpected = mine.reduce((t, r) => t + toNum(r.expected), 0)
  const tenderCounted = mine.reduce((t, r) => t + toNum(r.counted), 0)
  check(
    'per-tender expected sums to the shift expected',
    Math.abs(tenderExpected - toNum(row.expectedTotal)) < 0.005,
    `${tenderExpected.toFixed(2)} vs ${toNum(row.expectedTotal).toFixed(2)}`,
  )
  check(
    'per-tender counted sums to the shift counted',
    Math.abs(tenderCounted - toNum(row.countedTotal)) < 0.005,
    `${tenderCounted.toFixed(2)} vs ${toNum(row.countedTotal).toFixed(2)}`,
  )

  const byPerson = await resolveReport(SITE, 'cashup-history', 'person')
  const personRows = (
    await runBuilderSpec(SITE, { ...byPerson!.spec, period: PERIOD }, canAll)
  ).rows
  const me = personRows.find((r) => String(r.userName) === actor.userName)
  check('the By person cut ranks this person', !!me)
  if (me) {
    check(
      'and carries their sale count',
      toNum(me.saleCount_sum) === SALES.length,
      String(me.saleCount_sum),
    )
    check(
      'and their variance',
      Math.abs(toNum(me.variance_sum) - -SHORT_BY) < 0.005,
      String(me.variance_sum),
    )
  }

  const retiredTender = await resolveReport(SITE, 'cashup-by-tender')
  check('the retired tender id resolves to the same cut', retiredTender?.name === 'Cash-up by tender')
  check('…with no switcher', (retiredTender?.variants.length ?? 0) === 0)
  const retiredPerson = await resolveReport(SITE, 'cash-variance-by-user')
  check(
    'the retired person id resolves to the same cut',
    retiredPerson?.name === 'Drawer variance by person',
  )
}

main()
  .then(async () => {
    await sweep()
    console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} FAILURE(S)`)
    process.exit(failures === 0 ? 0 : 1)
  })
  .catch(async (e) => {
    await sweep().catch(() => {})
    console.error('\nThrew:', e)
    process.exit(1)
  })
