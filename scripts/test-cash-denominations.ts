/**
 * The cash-up's denominations, and the currency they are in.
 *
 *   npx tsx --conditions=react-server --env-file=.env scripts/test-cash-denominations.ts
 *
 * Switching a shop's currency REPLACES the grid a cashier counts into, and the
 * things worth proving are the ones no screen can show:
 *
 *   · A DENOMINATION THAT HAS BEEN COUNTED IS NEVER DELETED. Its id is
 *     referenced by shift_count_denominations, so a delete would break the join
 *     that renders a past declaration — the figures survive (168 copies label
 *     and value onto the count row) but the grid would render empty. It is
 *     deactivated instead, and this asserts that with a real counted row.
 *
 *   · AND IT IS STILL HIDDEN FROM THE NEW GRID. Deactivating is not enough on
 *     its own: the setup screen lists inactive rows on purpose, so without the
 *     currency filter on listDenominations a retired rand row would appear
 *     beside the Canadian ones — a grid of two currencies, which is the exact
 *     state the switch exists to prevent.
 *
 *   · THE SWITCH IS ALL-OR-NOTHING. A half-replaced grid reconciles to nothing,
 *     on the screen where being unable to work costs most.
 *
 * ── IT MAKES ITS OWN HISTORY, AND TAKES IT AWAY AGAIN ───────────────────────
 *
 * No dev site has a cash-up on file, so the counted row is seeded here. Every
 * row it creates is removed in a `finally` — including on a failure part-way
 * through, which is when litter would otherwise be left behind to fail an
 * unrelated suite later.
 */
import { siteQuery, siteExecute } from '../src/lib/siteDb'
import { switchCurrency, currencyState, addDenomination } from '../src/lib/site/cashDenominations'
import { listDenominations } from '../src/lib/site/cashupDeclaration'
import { CURRENCIES, currencyFor, symbolFor } from '../src/lib/currencies'

const SITE = 1

let failures = 0
function check(what: string, got: unknown, want: unknown) {
  const ok = got === want
  if (!ok) failures++
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${what}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`,
  )
}

let shiftId: number | null = null
let declarationId: number | null = null
let addedId: number | null = null

async function main() {
  console.log('\n── The shipped currency sets ──────────────────────────────────')
  check('every set has a unique ISO code', new Set(CURRENCIES.map((c) => c.code)).size, CURRENCIES.length)
  check('ZAR is known', currencyFor('zar')?.code, 'ZAR')
  check('lookup is case-insensitive', currencyFor('cad')?.symbol, '$')
  check('an unknown code has no set', currencyFor('XYZ'), null)
  check('an unknown symbol falls back to the code', symbolFor('XYZ'), 'XYZ')

  for (const c of CURRENCIES) {
    const values = c.denominations.map((d) => d.value)
    const sorted = [...values].sort((a, b) => b - a)
    /* Largest first is the order a person counts in, and switchCurrency assigns
       `position` straight from this order — so a set listed out of order would
       silently produce an out-of-order grid. */
    if (JSON.stringify(values) !== JSON.stringify(sorted)) {
      failures++
      console.log(`FAIL  ${c.code} is not listed largest-first`)
    }
    if (new Set(values).size !== values.length) {
      failures++
      console.log(`FAIL  ${c.code} has two denominations of the same value`)
    }
    if (values.some((v) => !Number.isFinite(v) || v <= 0)) {
      failures++
      console.log(`FAIL  ${c.code} has a denomination worth nothing`)
    }
  }
  console.log(`PASS  all ${CURRENCIES.length} sets are ordered, positive and free of duplicates`)

  console.log('\n── Seeding a counted denomination ─────────────────────────────')
  const denom = await siteQuery<Record<string, unknown>>(
    SITE,
    "SELECT id, label, value FROM cash_denominations WHERE currency_code = 'ZAR' ORDER BY value DESC LIMIT 1",
  )
  if (!denom[0]) throw new Error('no ZAR denominations — has 240 run?')
  const countedId = Number(denom[0].id)

  await siteExecute(
    SITE,
    `INSERT INTO shifts (document_number, mode, terminal_id, terminal_code, user_id, user_name, opening_float)
     VALUES ('TEST-DENOM', 'user', NULL, NULL, 1, 'denomination test', 0)`,
  )
  shiftId = Number((await siteQuery<Record<string, unknown>>(SITE, 'SELECT LAST_INSERT_ID() AS id'))[0].id)

  await siteExecute(SITE, 'INSERT INTO shift_declarations (shift_id, opening_float) VALUES (?, 0)', [
    shiftId,
  ])
  declarationId = Number(
    (await siteQuery<Record<string, unknown>>(SITE, 'SELECT LAST_INSERT_ID() AS id'))[0].id,
  )

  await siteExecute(
    SITE,
    `INSERT INTO shift_count_denominations (declaration_id, denomination_id, label, value, qty, amount)
     VALUES (?,?,?,?,1,?)`,
    [declarationId, countedId, denom[0].label, denom[0].value, denom[0].value],
  )
  console.log(`      counted ${denom[0].label} (id ${countedId}) on declaration ${declarationId}`)

  console.log('\n── Switching currency ─────────────────────────────────────────')
  const switched = await switchCurrency(SITE, 'CAD')
  check('the switch succeeds', switched.ok, true)

  const state = await currencyState(SITE)
  check('the shop is now on CAD', state.code, 'CAD')
  check('and its grid agrees', state.denominationCode, 'CAD')
  check('so nothing is mismatched', state.mismatched, false)

  const survived = await siteQuery<Record<string, unknown>>(
    SITE,
    'SELECT currency_code, is_active FROM cash_denominations WHERE id = ?',
    [countedId],
  )
  check('the counted row still exists', survived.length, 1)
  check('deactivated rather than deleted', Number(survived[0]?.is_active), 0)
  check('and still tagged with its own currency', String(survived[0]?.currency_code), 'ZAR')

  /* includeInactive = true, which is what the SETUP screen passes: the retired
     row must be hidden by CURRENCY, not merely by being inactive. */
  const visible = await listDenominations(SITE, true)
  check('the retired row is off the new grid', visible.some((d) => d.id === countedId), false)
  check('and the new grid is the full Canadian set', visible.length, currencyFor('CAD')!.denominations.length)

  const history = await siteQuery<Record<string, unknown>>(
    SITE,
    `SELECT c.label FROM shift_count_denominations c
       JOIN cash_denominations d ON d.id = c.denomination_id
      WHERE c.declaration_id = ?`,
    [declarationId],
  )
  check('the past declaration still joins', history.length, 1)
  check('and reads what it was counted as', String(history[0]?.label), String(denom[0].label))

  console.log('\n── Adding one by hand ─────────────────────────────────────────')
  const dup = await addDenomination(SITE, { label: 'Another $20', value: 20, isNote: true })
  check('a duplicate value is refused', dup.ok, false)

  const blank = await addDenomination(SITE, { label: '  ', value: 5, isNote: false })
  check('a blank name is refused', blank.ok, false)

  const zero = await addDenomination(SITE, { label: '$0', value: 0, isNote: false })
  check('a worthless denomination is refused', zero.ok, false)

  const added = await addDenomination(SITE, { label: '$1000', value: 1000, isNote: true })
  check('a genuinely new value is accepted', added.ok, true)
  const found = await siteQuery<Record<string, unknown>>(
    SITE,
    "SELECT id, position FROM cash_denominations WHERE label = '$1000' LIMIT 1",
  )
  addedId = found[0] ? Number(found[0].id) : null
  const withAdded = await listDenominations(SITE, true)
  check('and sorts to the top, being the largest', withAdded[0]?.label, '$1000')

  console.log('\n── Switching back ─────────────────────────────────────────────')
  check('back to ZAR', (await switchCurrency(SITE, 'ZAR')).ok, true)
  const home = await currencyState(SITE)
  check('the shop is on ZAR again', home.code, 'ZAR')
  check('and reads as matched', home.mismatched, false)
  const randGrid = await listDenominations(SITE, false)
  check('no dollar row survives on the active grid', randGrid.some((d) => d.label.startsWith('$')), false)
}

main()
  .catch((err) => {
    console.error('\nThe suite threw:', err)
    failures++
  })
  .finally(async () => {
    /* Everything this suite invented, removed — including after a failure. A
       leaked shift or a stray denomination fails an unrelated suite later, and
       that failure looks like a bug in whatever ran next. */
    try {
      if (declarationId) {
        await siteExecute(SITE, 'DELETE FROM shift_count_denominations WHERE declaration_id = ?', [
          declarationId,
        ])
        await siteExecute(SITE, 'DELETE FROM shift_declarations WHERE id = ?', [declarationId])
      }
      if (shiftId) await siteExecute(SITE, 'DELETE FROM shifts WHERE id = ?', [shiftId])
      if (addedId) await siteExecute(SITE, 'DELETE FROM cash_denominations WHERE id = ?', [addedId])

      /* Back to the DEFAULT state, not to what was read on the way in: putting
         back "the original" would faithfully restore a previous crashed run's
         pollution. 168's seed is eleven active rows plus an inactive 5c. */
      await switchCurrency(SITE, 'ZAR')
      await siteExecute(SITE, "DELETE FROM cash_denominations WHERE currency_code <> 'ZAR'")
      await siteExecute(SITE, "UPDATE cash_denominations SET is_active = 1 WHERE label <> '5c'")
      await siteExecute(SITE, "UPDATE cash_denominations SET is_active = 0 WHERE label = '5c'")
      console.log('\nRestored the site to its seeded rand grid.')
    } catch (e) {
      console.error('CLEANUP FAILED — check site', SITE, 'by hand:', e)
      failures++
    }

    console.log(
      failures === 0
        ? '\nAll checks passed.\n'
        : `\n${failures} check${failures === 1 ? '' : 's'} FAILED.\n`,
    )
    process.exit(failures === 0 ? 0 : 1)
  })
