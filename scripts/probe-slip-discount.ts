/**
 * Does a special actually reach the slip?
 *
 * The renderers are unit-tested against a hand-built ReceiptData, which proves
 * the LAYOUT and nothing about the plumbing: `specialNames` runs real SQL, and
 * a column that does not exist compiles perfectly. This walks the whole path —
 * a real special, a real sale priced by the real engine, the real slip builder.
 *
 * It CREATES its own special, product and sale rather than hunting for one: no
 * site here has ever rung a promotion up, so a probe that only looked would
 * pass vacuously on the half of the change that matters most.
 *
 *   npx tsx --conditions=react-server --env-file=.env scripts/probe-slip-discount.ts
 */
import { siteExecute, siteQueryOne } from '../src/lib/siteDb'
import { saveSpecial, specialNames, liveSpecials, deleteSpecial } from '../src/lib/site/specials'
import { computeSpecials } from '../src/lib/specialsEngine'
import { saveDraft, getDocument } from '../src/lib/site/salesDocuments'
import { finaliseDocument } from '../src/lib/site/salesPosting'
import { getTenderByCode } from '../src/lib/site/tenderTypes'
import { receiptDataFor } from '../src/lib/receiptData'
import { renderReceipt } from '../src/lib/escpos/slips'

const SITE = Number(process.env.PROBE_SITE ?? 1)
const ACTOR = { userId: 1, userName: 'Probe' }
const stamp = String(Date.now()).slice(-8)

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

/** 'YYYY-MM-DDTHH:mm' local — the shape a special stores. */
function localStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

/** Control bytes out, so the roll can be read in a terminal. */
const readable = (s: string) =>
  [...s].filter((c) => c.codePointAt(0)! >= 0x20).join('')

async function main() {
  console.log(`\n── Setting up a real promotion (site ${SITE}) ──────────────\n`)

  const dept = await siteQueryOne<{ id: number }>(
    SITE,
    'SELECT id FROM departments ORDER BY id LIMIT 1',
  )
  const departmentId = dept ? Number(dept.id) : null

  const code = `PSD${stamp}`
  await siteExecute(
    SITE,
    `INSERT INTO products (code, description, product_type, department_id) VALUES (?,?,'stock',?)`,
    [code, `Probe pudding ${stamp}`, departmentId],
  )
  const product = await siteQueryOne<{ id: number }>(
    SITE,
    'SELECT id FROM products WHERE code = ?',
    [code],
  )
  const productId = Number(product!.id)

  const yesterday = new Date(Date.now() - 86_400_000)
  const nextWeek = new Date(Date.now() + 7 * 86_400_000)
  const SPECIAL_NAME = `Probe Pudding Hour ${stamp}`

  const saved = await saveSpecial(
    SITE,
    {
      id: null,
      name: SPECIAL_NAME,
      shape: 'happy_hour',
      isActive: true,
      startsAt: localStamp(yesterday),
      endsAt: localStamp(nextWeek),
      dailyStart: '',
      dailyEnd: '',
      daysOfWeek: '1111111',
      discountPct: 10,
      triggerQty: 0,
      bundlePriceIncl: 0,
      spendAmountIncl: 0,
      items: [{ role: 'scope', productId, departmentId: null, qty: 1, priceIncl: 0 }],
      tiers: [],
    },
    'Probe',
  )
  if (!saved.ok) throw new Error(`saveSpecial failed: ${saved.error}`)
  const specialId = saved.id
  ok('the special saved', specialId > 0, SPECIAL_NAME)

  // Priced by the REAL engine, exactly as the till prices it.
  /*
   * Priced the way the till prices: load the live specials, then run the pure
   * engine over the basket. This probe used to call a server-side `priceBasket`
   * that nothing else in the app used — so it proved a path no customer was
   * ever charged through. This is the real one.
   */
  const applied = computeSpecials(
    [{ productId, departmentId, priceIncl: 100, qty: 2 }],
    await liveSpecials(SITE),
    new Date(),
  ).lineSpecials[0]
  ok(
    '*** the engine applied the special to the basket ***',
    applied?.specialId === specialId && applied?.pct === 10,
    `pct ${applied?.pct}, specialId ${applied?.specialId}`,
  )

  const draft = await saveDraft(SITE, ACTOR, {
    docType: 'invoice',
    customerId: null,
    customerName: 'Probe',
    lines: [
      {
        productId,
        productCode: code,
        description: `Probe pudding ${stamp}`,
        productType: 'stock',
        qty: 2,
        unitPriceIncl: 100,
        discountPct: applied?.pct ?? 0,
        specialId: applied?.specialId ?? null,
        vatRatePct: 15,
        unitCostExcl: 10,
      } as never,
    ],
  })
  if (!draft.ok) throw new Error(`draft failed: ${draft.error}`)

  const cash = await getTenderByCode(SITE, 'CASH')
  if (!cash) throw new Error('no CASH tender on this site')
  const posted = await finaliseDocument(SITE, ACTOR, {
    documentId: draft.id,
    tenders: [{ tenderTypeId: cash.id, amount: 180 }],
    customerId: null,
    voucherCodes: [],
  })
  ok('the sale finalised', (posted as { ok?: boolean }).ok !== false)

  console.log('\n── What the slip does with it ──────────────────────────────\n')

  const doc = await getDocument(SITE, draft.id)
  if (!doc) throw new Error('the document did not read back')

  ok(
    '*** the sale line REMEMBERS which special discounted it ***',
    doc.lines[0].specialId === specialId,
    `stored ${doc.lines[0].specialId}`,
  )

  const ids = doc.lines.map((l) => l.specialId).filter((v): v is number => v !== null)
  const names = await specialNames(SITE, ids)
  ok(
    '*** specialNames resolved it against the real table ***',
    names.get(specialId) === SPECIAL_NAME,
    names.get(specialId) ?? '(nothing)',
  )

  const receipt = receiptDataFor(
    doc,
    { name: 'Probe Shop', vatNumber: null },
    [],
    { printedAt: 'now', specialNames: names },
  )
  const line = receipt.lines[0]
  ok('the slip line carries the PERCENTAGE', line.discountPct === 10, `${line.discountPct}%`)
  ok(
    'the slip line carries the VALUE',
    Math.abs(line.discountIncl - 20) < 0.01,
    `R${line.discountIncl}`,
  )
  ok(
    '*** the slip line NAMES the promotion ***',
    line.specialName === SPECIAL_NAME,
    line.specialName ?? '(null)',
  )

  const summed = Math.round(receipt.lines.reduce((s, l) => s + l.discountIncl, 0) * 100) / 100
  ok(
    '*** the per-line discounts add up to the document total ***',
    Math.abs(summed - receipt.discountTotal) < 0.02,
    `lines ${summed} vs document ${receipt.discountTotal}`,
  )

  // And on the roll, through the shipped thermal renderer.
  const roll = new TextDecoder('latin1').decode(renderReceipt(receipt))
  ok(
    'the thermal slip prints the name and the percentage',
    roll.includes(SPECIAL_NAME) && roll.includes('10% off'),
  )
  ok('the thermal slip prints the value', roll.includes('-R20.00'))

  console.log('\nThe roll reads:\n')
  for (const raw of roll.split('\n')) {
    const clean = readable(raw)
    if (clean.trim()) console.log('  ' + clean)
  }

  console.log('\n── Cleaning up ─────────────────────────────────────────────\n')
  /*
   * The SALE stays. A finalised invoice is posted to stock and the ledger, and
   * unpicking that by hand is how a probe leaves a site's books wrong.
   *
   * The special goes — and deleting it also proves the path a REMOVED or
   * renamed promotion puts an old slip on: the FK is ON DELETE SET NULL, so the
   * line loses its id, and a reprint must lose the NAME without losing a cent
   * of the discount.
   */
  await deleteSpecial(SITE, specialId)
  const after = await specialNames(SITE, [specialId])
  const reprint = receiptDataFor(
    (await getDocument(SITE, draft.id))!,
    { name: 'Probe Shop', vatNumber: null },
    [],
    { printedAt: 'now', specialNames: after },
  )
  ok(
    '*** a deleted special costs the line its NAME, never its discount ***',
    reprint.lines[0].specialName === null && reprint.lines[0].discountIncl === 20,
    `name ${reprint.lines[0].specialName}, still -R${reprint.lines[0].discountIncl}`,
  )

  console.log(fails === 0 ? '\nThe special reaches the slip.\n' : `\n${fails} FAILURE(S)\n`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
