/**
 * The quantity rule — allow_fractions and qty_decimals, enforced on the SERVER.
 *
 * The rules that matter:
 *
 *   THE PRODUCT DECIDES, NOT THE SCREEN. Three selling screens used to disagree
 *   about the same product: the till asked it, the invoice grid hardcoded two
 *   decimals, the delivery panel hardcoded three. One rule, one answer.
 *
 *   THE FLAG IS ASKED FIRST. qty_decimals is meaningless while allow_fractions
 *   is off, and is deliberately left at whatever the shop chose — so a reader
 *   that consults the number alone lets a whole-unit product take 1.25.
 *
 *   A FLOAT ARTEFACT IS NOT A VIOLATION. 0.1 + 0.2 is 0.30000000000000004 in
 *   JavaScript, and refusing that as "too precise" would refuse a quantity a
 *   client built by adding two legitimate halves.
 *
 *   npm run test:quantity-guard
 */
import { siteExecute } from '../src/lib/siteDb'
import { createProduct } from '../src/lib/site/products'
import { checkQuantities } from '../src/lib/site/quantityGuard'

const SITE = 1
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

const stamp = Date.now().toString().slice(-8)
const CODE = (suffix: string) => `QTG${stamp}${suffix}`

/** Creates a product and returns its id, or throws with the reason. */
async function make(suffix: string, allowFractions: boolean, qtyDecimals: number) {
  const result = await createProduct(SITE, {
    code: CODE(suffix),
    description: `Quantity guard ${suffix}`,
    sellingPriceIncl: 100,
    /* Zero-rated, because site 1 is not VAT-registered and a standard rate is
       refused there. VAT has nothing to do with the quantity rule — this is the
       cheapest way to get a product onto the file. */
    sellingVatRateId: 2,
    purchaseVatRateId: 2,
    allowFractions,
    qtyDecimals,
  } as never)
  if (!result.ok) throw new Error(`could not create ${suffix}: ${result.error}`)
  return (result as { ok: true; id: number }).id
}

async function main() {
  const whole = await make('W', false, 3)
  const two = await make('T', true, 2)
  const four = await make('F', true, 4)

  const line = (productId: number, qty: number) => [{ productId, description: 'Test', qty }]

  /* ── A whole-unit product ────────────────────────────────────────────── */

  ok(
    '*** a whole-unit product REFUSES a fractional quantity ***',
    (await checkQuantities(SITE, line(whole, 1.5))) !== null,
  )
  ok(
    '  and the message says so in words a cashier can act on',
    ((await checkQuantities(SITE, line(whole, 1.5))) ?? '').includes('whole units'),
    (await checkQuantities(SITE, line(whole, 1.5))) ?? '',
  )
  ok('  a whole quantity passes', (await checkQuantities(SITE, line(whole, 3))) === null)
  ok(
    '  and so does a whole NEGATIVE one — a refund is a quantity too',
    (await checkQuantities(SITE, line(whole, -2))) === null,
  )
  ok(
    '  a fractional refund is refused like a fractional sale',
    (await checkQuantities(SITE, line(whole, -1.5))) !== null,
  )

  /* ── The number of decimals ──────────────────────────────────────────── */

  ok(
    '*** a two-decimal product refuses a THIRD decimal ***',
    (await checkQuantities(SITE, line(two, 1.234))) !== null,
  )
  ok('  two decimals pass', (await checkQuantities(SITE, line(two, 1.23))) === null)
  ok('  and so does one', (await checkQuantities(SITE, line(two, 1.2))) === null)
  ok('  and a whole number', (await checkQuantities(SITE, line(two, 5))) === null)
  ok(
    '*** a four-decimal product ACCEPTS the fourth ***',
    (await checkQuantities(SITE, line(four, 1.2345))) === null,
  )
  ok(
    '  but not a fifth — the column holds four',
    (await checkQuantities(SITE, line(four, 1.23456))) !== null,
  )

  /* ── Float artefacts ─────────────────────────────────────────────────── */

  ok(
    '*** 0.1 + 0.2 is not a violation, it is a float ***',
    (await checkQuantities(SITE, line(two, 0.1 + 0.2))) === null,
    `qty was ${0.1 + 0.2}`,
  )

  /* ── What is deliberately not checked ────────────────────────────────── */

  ok(
    'a line with NO product is left alone — free text has no rule',
    (await checkQuantities(SITE, [{ productId: null, description: 'Callout fee', qty: 1.5 }])) ===
      null,
  )
  ok(
    'an unresolvable product id is left alone rather than blocking the sale',
    (await checkQuantities(SITE, line(999_000_111, 1.5))) === null,
  )
  ok('an empty document passes', (await checkQuantities(SITE, [])) === null)

  /* ── It names the offending line ─────────────────────────────────────── */

  {
    const message = await checkQuantities(SITE, [
      { productId: two, description: 'Fine', qty: 1.5 },
      { productId: whole, description: 'Bad one', qty: 0.5 },
    ])
    ok(
      'the message names the RIGHT line when an earlier one is fine',
      (message ?? '').includes('Line 2') && (message ?? '').includes('Bad one'),
      message ?? 'passed when it should not have',
    )
  }

  // ── Cleanup
  await siteExecute(SITE, 'DELETE FROM products WHERE code LIKE ?', [`QTG${stamp}%`])

  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch(async (error) => {
  console.error(error)
  await siteExecute(SITE, "DELETE FROM products WHERE code LIKE 'QTG%'").catch(() => {})
  console.log('\nCRASHED — swept')
  process.exit(1)
})
