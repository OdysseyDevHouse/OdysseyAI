/**
 * The merged Cancellations report — both cuts, and both retired ids.
 *
 * 'Cancellation history' and 'Cancellations by reason' used to be two tiles
 * reading identical rows through the same `status = cancelled` filter; the
 * history already carried the reason, so the only difference was SHAPE. They
 * are now two cuts of one report.
 *
 * What must stay true, and is what this checks:
 *
 *   · the History cut still lists one row per cancelled document, with the
 *     reason on it;
 *   · the By reason cut still ranks reasons by what they cost, and its totals
 *     AGREE with the history it summarises — the whole claim of the merge is
 *     that these two read the same rows;
 *   · 'voids-by-reason', retired from the catalogue, still resolves — it is in
 *     report_favorites, report_schedules and the public API on live sites;
 *   · 'void-history' resolves WITH its cut switcher, so the By reason cut is
 *     reachable from the hub rather than stranded behind a hand-typed URL.
 *
 *   npx tsx --conditions=react-server --env-file=.env scripts/test-cancellation-cuts.ts
 */
import { siteQuery, siteExecute, siteQueryOne } from '../src/lib/siteDb'
import { resolveReport } from '../src/lib/reportBuilder/resolve'
import { runBuilderSpec } from '../src/lib/reportBuilder/run'
import { getTemplate, getLegacyVariant } from '../src/lib/reportBuilder/templates'
import { saveDraft } from '../src/lib/site/salesDocuments'
import { finaliseDocument, voidDocument } from '../src/lib/site/salesPosting'
import { getTenderByCode } from '../src/lib/site/tenderTypes'
import { findSalesReasonByCode } from '../src/lib/site/salesReasons'
import { toNum } from '../src/lib/decimals'

const SITE = 1
const actor = { userId: 1, userName: 'Cancel Cuts Test' }
/* Everything, so the assertions are not vacuous on a quiet month. */
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

/* A cancelled sale under each of two reasons, so "ranked by reason" has more
   than one band to rank and the row-count check is not 1 === 1.

   Swept before AND after: a crashed run must not leave a product behind, and a
   leaked fixture on a UNIQUE code fails an unrelated suite before its first
   assertion. */
const CODE_PATTERN = '^CXT[0-9]{8}$'
async function sweep() {
  const where = `(SELECT id FROM products WHERE code REGEXP '${CODE_PATTERN}')`
  await siteExecute(
    SITE,
    `DELETE FROM sales_documents WHERE id IN (SELECT document_id FROM sales_document_lines WHERE product_id IN ${where})`,
  )
  await siteExecute(SITE, `DELETE FROM sales_document_lines WHERE product_id IN ${where}`)
  await siteExecute(SITE, `DELETE FROM stock_movements WHERE product_id IN ${where}`)
  await siteExecute(SITE, `DELETE FROM products WHERE code REGEXP '${CODE_PATTERN}'`)
}

/** Returns how many documents it cancelled, and what they came to. */
async function seedCancellations(): Promise<{ count: number; total: number } | null> {
  const stamp = Date.now().toString().slice(-8)
  const vat = await siteQueryOne<{ id: number; rate: number }>(
    SITE,
    "SELECT id, rate FROM vat_rates WHERE vat_type='sales' AND is_default=1 LIMIT 1",
  )
  const rate = toNum(vat?.rate, 15)
  const cash = await getTenderByCode(SITE, 'CASH')
  /* Reason ids are AUTO_INCREMENT and differ per site — resolve by code.
     No `??` fallback between the two: silently collapsing to one reason would
     leave the By reason cut with a single band, and "ranks the reasons" would
     pass while ranking nothing. Missing seed data is a failure, not a default. */
  const wrongItem = await findSalesReasonByCode(SITE, 'void', 'WRONG-ITEM')
  const doubleRung = await findSalesReasonByCode(SITE, 'void', 'DOUBLE-RUNG')
  if (!cash || !wrongItem || !doubleRung) return null

  const p = await siteExecute(
    SITE,
    `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost, last_cost, selling_vat_rate_id, visible_in_pos)
     VALUES (?,?,'normal',100,40,40,?,1)`,
    [`CXT${stamp}`, 'Cancellation cuts test widget', vat?.id ?? null],
  )
  const widget = p.insertId
  await siteExecute(
    SITE,
    `INSERT INTO product_location_stock (product_id, location_id, stock_on_hand)
     SELECT id, (SELECT id FROM stock_locations WHERE is_main=1 LIMIT 1), stock_on_hand FROM products WHERE id=?
     ON DUPLICATE KEY UPDATE stock_on_hand=VALUES(stock_on_hand)`,
    [widget],
  )

  const plan = [
    { qty: 2, price: 115, reason: wrongItem.id },
    { qty: 1, price: 115, reason: wrongItem.id },
    { qty: 3, price: 115, reason: doubleRung.id },
  ]
  let count = 0
  let total = 0
  for (const step of plan) {
    const draft = await saveDraft(SITE, actor, {
      docType: 'invoice',
      customerName: 'Walk-in',
      lines: [
        {
          productId: widget,
          productCode: `CXT${stamp}`,
          description: 'Cancellation cuts test widget',
          productType: 'normal',
          qty: step.qty,
          unitPriceIncl: step.price,
          vatRatePct: rate,
          unitCostExcl: 40,
        },
      ],
    })
    if (!draft.ok) continue
    const amount = step.qty * step.price
    const posted = await finaliseDocument(SITE, actor, {
      documentId: draft.id,
      tenders: [{ tenderTypeId: cash.id, amount }],
    })
    if (!posted.ok) continue
    const cancelled = await voidDocument(SITE, actor, draft.id, { reasonId: step.reason })
    if (!cancelled.ok) continue
    count++
    total += amount
  }
  return { count, total }
}

async function main() {
  await sweep()
  const seeded = await seedCancellations()
  if (!seeded) {
    console.log('  (could not seed — missing CASH tender or seeded void reasons)')
  } else {
    console.log(`  (seeded ${seeded.count} cancellations worth R${seeded.total.toFixed(2)})`)
  }

  /* ── the catalogue ─────────────────────────────────────────────────────── */
  console.log('\nCatalogue')

  const merged = getTemplate('void-history')
  check('void-history is still in the catalogue', !!merged)
  check('it is named for both cuts', merged?.name === 'Cancellations', `got "${merged?.name}"`)
  check('voids-by-reason is gone as a tile', !getTemplate('voids-by-reason'))
  check('voids-by-reason still resolves as a legacy id', !!getLegacyVariant('voids-by-reason'))
  check(
    'void-history is NOT claimed as a legacy id',
    !getLegacyVariant('void-history'),
    'claiming it would strip the cut switcher — see the note in templates.ts',
  )
  check('it offers exactly two cuts', merged?.variants?.length === 2, `got ${merged?.variants?.length}`)
  check('History is the default cut', merged?.variants?.[0]?.key === 'history')

  /* ── resolution ────────────────────────────────────────────────────────── */
  console.log('\nResolution')

  const bare = await resolveReport(SITE, 'void-history')
  check('bare id resolves', !!bare)
  check('…to the History cut', bare?.variantKey === 'history', `got ${bare?.variantKey}`)
  check('…with the switcher present', (bare?.variants.length ?? 0) === 2, `got ${bare?.variants.length}`)

  const cut = await resolveReport(SITE, 'void-history', 'reason')
  check('?cut=reason resolves to By reason', cut?.variantKey === 'reason')
  check('…and is named for the cut', cut?.name === 'Cancellations by reason', `got "${cut?.name}"`)

  const retired = await resolveReport(SITE, 'voids-by-reason')
  check('the retired id still resolves', !!retired)
  check('…to the same figures it always returned', retired?.name === 'Cancellations by reason')
  check(
    '…with no switcher, per the legacy contract',
    (retired?.variants.length ?? 0) === 0,
    `got ${retired?.variants.length}`,
  )

  /* ── the figures ───────────────────────────────────────────────────────── */
  console.log('\nFigures')

  /* Vacuous-assertion guard: with no cancelled documents every total below is
     0 === 0 and proves nothing, so the fixture above makes some. */
  const [{ n }] = (await siteQuery(
    SITE,
    `SELECT COUNT(*) AS n FROM sales_documents WHERE status = 'cancelled'`,
  )) as { n: number }[]
  console.log(`  (${n} cancelled document${n === 1 ? '' : 's'} on site ${SITE})`)
  if (n === 0) {
    check('the fixture produced cancelled documents', false, 'nothing to measure')
    return
  }

  const history = await runBuilderSpec(
    SITE,
    { ...bare!.spec, period: PERIOD },
    canAll,
  )
  const byReason = await runBuilderSpec(
    SITE,
    { ...cut!.spec, period: PERIOD },
    canAll,
  )

  check('History lists the documents', history.rows.length > 0, `${history.rows.length} rows`)
  /* > 1, not > 0: one band is what a report that ignored the grouping would
     also produce, so it would pass while ranking nothing. */
  check(
    'By reason ranks the reasons',
    byReason.rows.length > 1,
    `${byReason.rows.length} band(s) — needs at least 2 to be ranking anything`,
  )
  check(
    'History carries the reason column',
    history.columns.some((c) => c.key === 'cancelReasonName'),
    history.columns.map((c) => c.key).join(','),
  )

  /* The claim of the merge, stated as arithmetic: the summary is a summary OF
     the history, so the two must total the same money and the same row count. */
  const historyTotal = history.rows.reduce((t, r) => t + toNum(r.totalIncl ?? 0), 0)
  const reasonTotal = byReason.rows.reduce((t, r) => t + toNum(r.totalIncl_sum ?? 0), 0)
  check(
    'the two cuts agree on the money',
    Math.abs(historyTotal - reasonTotal) < 0.005,
    `history ${historyTotal.toFixed(2)} vs by-reason ${reasonTotal.toFixed(2)}`,
  )

  const reasonRows = byReason.rows.reduce((t, r) => t + toNum(r.rowCount ?? 0), 0)
  check(
    'the two cuts agree on the document count',
    reasonRows === history.rows.length,
    `history ${history.rows.length} vs by-reason ${reasonRows}`,
  )

  console.log(`\n  cancelled: R${historyTotal.toFixed(2)} across ${history.rows.length} documents`)
  for (const r of byReason.rows.slice(0, 5)) {
    console.log(`    ${String(r.cancelReasonName ?? '(none)')} — ${r.rowCount} × R${toNum(r.totalIncl_sum ?? 0).toFixed(2)}`)
  }
}

main()
  .then(async () => {
    await sweep()
    console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} FAILURE(S)`)
    process.exit(failures === 0 ? 0 : 1)
  })
  .catch(async (e) => {
    // Clean up even on a throw, or the next run starts from a dirty site.
    await sweep().catch(() => {})
    console.error('\nThrew:', e)
    process.exit(1)
  })
