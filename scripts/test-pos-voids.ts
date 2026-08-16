/**
 * Voids taken off a DRAFT sale — the till's record of what never got paid for.
 *
 * ── WHAT THIS IS NOT TESTING ───────────────────────────────────────────────
 *
 * Not `voidDocument`, which CANCELS a finalised sale and is covered by
 * test-void.ts. This suite is the other event: a line or an item removed from a
 * sale that was never finalised, where nothing posted and there is usually no
 * document at all.
 *
 * ── THE BUG THIS EXISTS TO PREVENT ─────────────────────────────────────────
 *
 * Double counting. Abandoning a basket writes a `sale` rollup AND one `line`
 * row per line, so any total spanning both counts every abandoned basket twice.
 * The catalog source and all three templates filter `voidType != 'sale'` for
 * that reason, and a regression there would silently inflate every void figure
 * a manager looks at — plausibly, and in the direction that starts an
 * accusation. The rollup/lines test below is the one that must never go quiet.
 *
 *   npm run test:pos-voids
 */
import { siteExecute, siteQueryOne } from '../src/lib/siteDb'
import { recordVoidEvents, voidSummary } from '../src/lib/site/posVoids'
import { findSalesReasonByCode } from '../src/lib/site/salesReasons'
import { getSource } from '../src/lib/reportBuilder/catalog'
import { runBuilderSpec } from '../src/lib/reportBuilder/run'
import { TEMPLATES } from '../src/lib/reportBuilder/templates'

const SITE = 1

/* Marks every row this suite writes, so cleanup can find them and no other
   suite's data can be swept by mistake. */
const TAG = 'VOIDTEST'

let fails = 0
function ok(label: string, condition: boolean, saw?: unknown) {
  if (condition) {
    console.log(`  PASS  ${label}`)
  } else {
    fails++
    console.log(`  FAIL  ${label}${saw === undefined ? '' : ` — saw ${JSON.stringify(saw)}`}`)
  }
}

async function sweep() {
  await siteExecute(SITE, 'DELETE FROM pos_void_events WHERE description LIKE ?', [`${TAG}%`])
}

async function main() {
  console.log('POS voids\n')

  // Fresh start even if a previous run crashed mid-way. A leaked row here would
  // land in the aggregates below and fail an assertion that has nothing to do
  // with what actually broke.
  await sweep()

  const reason = await findSalesReasonByCode(SITE, 'void', 'WRONG-ITEM')
  const other = await findSalesReasonByCode(SITE, 'void', 'CUST-LEFT')
  if (!reason || !other) {
    console.log('Seeded void reasons missing — run site-migrate for 102.')
    process.exit(1)
  }

  const actor = {
    userId: null,
    userName: `${TAG} cashier`,
    terminalId: null,
    terminalCode: 'T-TEST',
    shiftId: null,
  }

  // ── 1. An item void: one unit off a line that survives ────────────────────
  console.log('An item void')
  const wrote = await recordVoidEvents(SITE, actor, [
    {
      voidType: 'item',
      reasonId: reason.id,
      reasonCode: reason.code,
      note: 'scanned twice',
      productId: null,
      productCode: 'ABC',
      description: `${TAG} tinned beans`,
      qty: 1,
      valueIncl: 12.5,
    },
  ])
  ok('the write reports success', wrote)

  const itemRow = await siteQueryOne<{ void_type: string; qty: string; value_incl: string; note: string | null; reason_code: string }>(
    SITE,
    'SELECT void_type, qty, value_incl, note, reason_code FROM pos_void_events WHERE description = ?',
    [`${TAG} tinned beans`],
  )
  ok('it is stored as an item void', itemRow?.void_type === 'item', itemRow?.void_type)
  ok('the quantity is what came off', Number(itemRow?.qty) === 1, itemRow?.qty)
  ok('the value is what it was worth', Number(itemRow?.value_incl) === 12.5, itemRow?.value_incl)
  ok('the note survives', itemRow?.note === 'scanned twice', itemRow?.note)
  ok('the reason code is denormalised onto the row', itemRow?.reason_code === 'WRONG-ITEM', itemRow?.reason_code)

  // ── 2. A line void ────────────────────────────────────────────────────────
  console.log('\nA line void')
  await recordVoidEvents(SITE, actor, [
    {
      voidType: 'line',
      reasonId: reason.id,
      reasonCode: reason.code,
      productId: null,
      productCode: 'DEF',
      description: `${TAG} bread`,
      qty: 3,
      valueIncl: 45,
    },
  ])
  const lineRow = await siteQueryOne<{ void_type: string; qty: string }>(
    SITE,
    'SELECT void_type, qty FROM pos_void_events WHERE description = ?',
    [`${TAG} bread`],
  )
  ok('it is stored as a line void', lineRow?.void_type === 'line', lineRow?.void_type)
  ok('the whole line quantity came off', Number(lineRow?.qty) === 3, lineRow?.qty)

  // ── 3. A sale void writes its rollup AND its lines ────────────────────────
  //
  // The reason both are written is that neither alone answers the question:
  // without the lines a product report cannot see the goods, and without the
  // rollup nobody can tell one abandoned basket from several mistakes.
  console.log('\nA sale void')
  const groupId = '11111111-2222-3333-4444-555555555555'
  await recordVoidEvents(SITE, actor, [
    {
      voidType: 'sale',
      groupId,
      reasonId: other.id,
      reasonCode: other.code,
      productId: null,
      productCode: null,
      description: `${TAG} 2 lines`,
      qty: 2,
      valueIncl: 100,
    },
    {
      voidType: 'line',
      groupId,
      reasonId: other.id,
      reasonCode: other.code,
      productId: null,
      productCode: 'GHI',
      description: `${TAG} milk`,
      qty: 1,
      valueIncl: 40,
    },
    {
      voidType: 'line',
      groupId,
      reasonId: other.id,
      reasonCode: other.code,
      productId: null,
      productCode: 'JKL',
      description: `${TAG} cheese`,
      qty: 1,
      valueIncl: 60,
    },
  ])

  const grouped = await siteQueryOne<{ n: string }>(
    SITE,
    'SELECT COUNT(*) AS n FROM pos_void_events WHERE group_id = ?',
    [groupId],
  )
  ok('the basket wrote a rollup and one row per line', Number(grouped?.n) === 3, grouped?.n)

  const rollup = await siteQueryOne<{ value_incl: string }>(
    SITE,
    "SELECT value_incl FROM pos_void_events WHERE group_id = ? AND void_type = 'sale'",
    [groupId],
  )
  ok('the rollup carries the basket total', Number(rollup?.value_incl) === 100, rollup?.value_incl)

  const linesOnly = await siteQueryOne<{ total: string }>(
    SITE,
    "SELECT SUM(value_incl) AS total FROM pos_void_events WHERE group_id = ? AND void_type = 'line'",
    [groupId],
  )
  ok(
    'the lines under it add up to the same money',
    Number(linesOnly?.total) === 100,
    linesOnly?.total,
  )

  // The whole point. Summing every row in the group double counts the basket,
  // which is why every report filters the rollup out.
  const naive = await siteQueryOne<{ total: string }>(
    SITE,
    'SELECT SUM(value_incl) AS total FROM pos_void_events WHERE group_id = ?',
    [groupId],
  )
  ok(
    'summing rollup AND lines together double counts — the trap the filters avoid',
    Number(naive?.total) === 200,
    naive?.total,
  )

  // ── 4. The summary helper ─────────────────────────────────────────────────
  console.log('\nThe summary')
  const today = new Date()
  const from = new Date(today.getTime() - 86_400_000).toISOString().slice(0, 19).replace('T', ' ')
  const to = new Date(today.getTime() + 86_400_000).toISOString().slice(0, 19).replace('T', ' ')
  const summary = await voidSummary(SITE, from, to)

  const wrongItem = summary.filter((r) => r.reasonCode === 'WRONG-ITEM')
  ok('the summary found the reason we wrote under', wrongItem.length > 0, summary.length)
  const itemGroup = wrongItem.find((r) => r.voidType === 'item')
  ok('it keeps item voids in their own group', itemGroup !== undefined && itemGroup.events >= 1, itemGroup)
  ok(
    'the reason name is resolved, not just the code',
    wrongItem.every((r) => r.reasonName === 'Wrong item rung up'),
    wrongItem.map((r) => r.reasonName),
  )

  // ── 5. The report source runs ─────────────────────────────────────────────
  //
  // Not a smoke test: a catalog field whose SQL does not compile takes the
  // whole report down at request time, and nothing else in the suite would
  // notice. This runs the real engine over the real table.
  console.log('\nThe report source')
  const source = getSource('posVoids')
  ok('the catalog knows the source', source !== undefined)
  ok('it points at the right table', source?.table === 'pos_void_events', source?.table)

  const templates = TEMPLATES.filter((t) => t.spec.source === 'posVoids')
  ok('the built-in void reports are registered', templates.length === 3, templates.length)

  for (const template of templates) {
    try {
      /* Everything permitted: this is testing that the SQL compiles and runs,
         not the capability gate, which run.ts covers on its own. */
      const result = await runBuilderSpec(
        SITE,
        /* A template spec carries no name of its own — the template supplies it.
           The engine wants a complete saved spec, so it is put back here. */
        { ...template.spec, name: template.name },
        () => true,
      )
      ok(`"${template.name}" runs and returns rows`, Array.isArray(result.rows))
    } catch (error) {
      ok(`"${template.name}" runs`, false, (error as Error).message)
    }
  }

  // Every aggregate template must exclude the rollup, or it reports double.
  const summing = templates.filter((t) => t.spec.groupFields.length > 0)
  ok(
    'every grouped void report filters the sale rollup out',
    summing.length > 0 &&
      summing.every((t) =>
        t.spec.filters.some((f) => f.field === 'voidType' && f.op === 'ne' && f.value === 'sale'),
      ),
    summing.map((t) => t.id),
  )

  // ── 6. A deleted reason must not blank the history ────────────────────────
  //
  // reason_id is ON DELETE SET NULL, so the stored code is the only thing left.
  // A report that showed a blank here would lose real history to a tidy-up.
  console.log('\nA reason that no longer exists')
  await siteExecute(SITE, 'UPDATE pos_void_events SET reason_id = NULL WHERE description = ?', [
    `${TAG} bread`,
  ])
  const orphaned = await voidSummary(SITE, from, to)
  const stillThere = orphaned.find((r) => r.reasonCode === 'WRONG-ITEM' && r.voidType === 'line')
  ok('the void still reports under its stored code', stillThere !== undefined, orphaned)

  await sweep()
  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch(async (error) => {
  console.error(error)
  await sweep()
  console.log('\nCRASHED — test rows swept')
  process.exit(1)
})
