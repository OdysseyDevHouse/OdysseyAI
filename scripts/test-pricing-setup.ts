/**
 * Price types and VAT rates — the setup writes.
 *
 * The point of this file is the GUARDS, not the happy path. Both tables are
 * pointed at by foreign keys that SET NULL or CASCADE, so the database will
 * accept deletes that silently destroy product prices or blank a product's VAT.
 * Every refusal below is the only thing standing between a mistyped click and
 * a catalogue with no prices.
 *
 *   npx tsx scripts/test-pricing-setup.ts
 */
import { siteExecute, siteQueryOne } from '../src/lib/siteDb'
import {
  listVatRatesForSetup,
  createVatRate,
  updateVatRate,
  deleteVatRate,
  listPriceStructuresForSetup,
  createPriceStructure,
  updatePriceStructure,
  deletePriceStructure,
  reorderPriceStructures,
} from '../src/lib/site/pricingSetup'

const SITE = 1

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

async function main() {
  const stamp = Date.now().toString().slice(-6)

  /* ── Price structures ─────────────────────────────────────────────────── */

  const before = await listPriceStructuresForSetup(SITE)
  const retail = before.find((s) => s.isDefault)
  ok('a default price type exists to start from', !!retail, retail?.name)

  // The live site has tens of thousands of prices under Retail. Deleting it
  // would CASCADE every one of them away.
  if (retail && retail.priceCount > 0) {
    const refused = await deletePriceStructure(SITE, retail.id)
    ok(
      'delete refused for a price type with prices under it',
      !refused.ok,
      refused.ok ? 'ALLOWED — would have cascaded' : refused.error,
    )
  }

  const created = await createPriceStructure(SITE, { name: `Wholesale ${stamp}` })
  ok('price type created', created.ok, created.ok ? `id ${created.id}` : created.error)
  if (!created.ok) return

  const newId = created.id

  const dupe = await createPriceStructure(SITE, { name: `Wholesale ${stamp}` })
  ok('duplicate name refused', !dupe.ok, dupe.ok ? 'ALLOWED' : dupe.error)

  // position is UNIQUE, so a fresh row must land past the existing maximum.
  const listed = await listPriceStructuresForSetup(SITE)
  const mine = listed.find((s) => s.id === newId)!
  ok('new price type is last in the order', mine.position === Math.max(...listed.map((s) => s.position)))
  ok('new price type carries no prices', mine.priceCount === 0)

  // An empty structure has nothing to cascade, so this one is allowed through.
  const renamed = await updatePriceStructure(SITE, newId, { name: `Trade ${stamp}` })
  ok('rename allowed', renamed.ok, renamed.ok ? '' : renamed.error)

  // Reorder round-trip: the offset pass must not trip the UNIQUE constraint.
  const ids = listed.map((s) => s.id)
  const reversed = [...ids].reverse()
  let reorderThrew: string | null = null
  try {
    await reorderPriceStructures(SITE, reversed)
  } catch (e) {
    reorderThrew = String(e)
  }
  ok('reorder does not trip the UNIQUE position constraint', reorderThrew === null, reorderThrew ?? '')

  const afterReorder = await listPriceStructuresForSetup(SITE)
  ok(
    'reorder actually reversed the list',
    afterReorder.map((s) => s.id).join(',') === reversed.join(','),
    afterReorder.map((s) => `${s.name}:${s.position}`).join(' '),
  )
  ok(
    'positions are a clean 1..n after reorder',
    afterReorder.every((s, i) => s.position === i + 1),
  )

  await reorderPriceStructures(SITE, ids) // put it back

  // The default must always be selectable.
  const offDefault = await updatePriceStructure(SITE, retail!.id, {
    name: retail!.name,
    isDefault: true,
    isActive: false,
  })
  ok('cannot turn off the default price type', !offDefault.ok, offDefault.ok ? 'ALLOWED' : offDefault.error)

  // A structure with a price under it must survive a delete attempt.
  const product = await siteQueryOne<any>(SITE, 'SELECT id FROM products LIMIT 1')
  if (product) {
    await siteExecute(
      SITE,
      'INSERT INTO product_prices (product_id, price_structure_id, selling_price_incl) VALUES (?,?,?)',
      [product.id, newId, '99.9900'],
    )
    const guarded = await deletePriceStructure(SITE, newId)
    ok(
      'delete refused once a single price exists',
      !guarded.ok,
      guarded.ok ? 'ALLOWED — cascade would have fired' : guarded.error,
    )

    const stillThere = await siteQueryOne<any>(
      SITE,
      'SELECT COUNT(*) AS n FROM product_prices WHERE price_structure_id = ?',
      [newId],
    )
    ok('the price survived the refused delete', Number(stillThere.n) === 1)

    await siteExecute(SITE, 'DELETE FROM product_prices WHERE price_structure_id = ?', [newId])
  }

  const removed = await deletePriceStructure(SITE, newId)
  ok('empty price type deletes cleanly', removed.ok, removed.ok ? '' : removed.error)

  /* ── VAT rates ────────────────────────────────────────────────────────── */

  const rates = await listVatRatesForSetup(SITE)
  const std = rates.find((r) => r.vatType === 'sales' && r.isDefault)
  ok('a default sales rate exists', !!std, std ? `${std.name} ${std.rate}%` : '')

  if (std && std.productCount > 0) {
    const refused = await deleteVatRate(SITE, std.id)
    ok(
      'delete refused for a rate products use',
      !refused.ok,
      refused.ok ? 'ALLOWED — products would have been blanked' : refused.error,
    )
  }

  const badPct = await createVatRate(SITE, {
    vatType: 'sales',
    code: `T${stamp}`.slice(0, 16),
    name: 'Typo rate',
    rate: 1500,
  })
  ok('a rate above 100% is refused', !badPct.ok, badPct.ok ? 'ALLOWED' : badPct.error)

  const negative = await createVatRate(SITE, {
    vatType: 'sales',
    code: `N${stamp}`.slice(0, 16),
    name: 'Negative',
    rate: -1,
  })
  ok('a negative rate is refused', !negative.ok, negative.ok ? 'ALLOWED' : negative.error)

  const madeVat = await createVatRate(SITE, {
    vatType: 'sales',
    code: `R${stamp}`.slice(0, 16),
    name: `Reduced ${stamp}`,
    rate: 7.5,
  })
  ok('VAT rate created', madeVat.ok, madeVat.ok ? `id ${madeVat.id}` : madeVat.error)
  if (!madeVat.ok) return

  const vatId = madeVat.id

  const dupeCode = await createVatRate(SITE, {
    vatType: 'sales',
    code: `R${stamp}`.slice(0, 16),
    name: 'Clash',
    rate: 5,
  })
  ok('duplicate code within a type is refused', !dupeCode.ok, dupeCode.ok ? 'ALLOWED' : dupeCode.error)

  // The same code under the OTHER type is legitimate — the unique key is
  // (vat_type, code), and most sites do run STD on both sides.
  const sameCodeOtherType = await createVatRate(SITE, {
    vatType: 'purchase',
    code: `R${stamp}`.slice(0, 16),
    name: `Reduced ${stamp}`,
    rate: 7.5,
  })
  ok(
    'the same code is allowed under the other vat type',
    sameCodeOtherType.ok,
    sameCodeOtherType.ok ? '' : sameCodeOtherType.error,
  )

  // Promoting a new default must demote the old one — exactly one per type.
  const promoted = await updateVatRate(SITE, vatId, {
    vatType: 'sales',
    code: `R${stamp}`.slice(0, 16),
    name: `Reduced ${stamp}`,
    rate: 7.5,
    isDefault: true,
  })
  ok('new default saved', promoted.ok, promoted.ok ? '' : promoted.error)

  const afterPromote = await listVatRatesForSetup(SITE)
  const salesDefaults = afterPromote.filter((r) => r.vatType === 'sales' && r.isDefault)
  ok(
    'exactly one sales default after promoting',
    salesDefaults.length === 1,
    salesDefaults.map((r) => r.name).join(', '),
  )
  ok('the promoted rate is the one holding it', salesDefaults[0]?.id === vatId)

  // vat_type is fixed after creation.
  const flipped = await updateVatRate(SITE, vatId, {
    vatType: 'purchase',
    code: `R${stamp}`.slice(0, 16),
    name: `Reduced ${stamp}`,
    rate: 7.5,
    isDefault: true,
  })
  const reread = await listVatRatesForSetup(SITE)
  ok(
    'vat_type cannot be flipped by an update',
    flipped.ok && reread.find((r) => r.id === vatId)?.vatType === 'sales',
  )

  // Hand the default back before cleaning up, or the site is left without one.
  if (std) {
    await updateVatRate(SITE, std.id, {
      vatType: std.vatType,
      code: std.code,
      name: std.name,
      rate: std.rate,
      isDefault: true,
      isActive: true,
    })
  }

  const goneVat = await deleteVatRate(SITE, vatId)
  ok('unused VAT rate deletes cleanly', goneVat.ok, goneVat.ok ? '' : goneVat.error)
  if (sameCodeOtherType.ok) await deleteVatRate(SITE, sameCodeOtherType.id)

  // The site must end as it started.
  const finalRates = await listVatRatesForSetup(SITE)
  const finalSalesDefault = finalRates.filter((r) => r.vatType === 'sales' && r.isDefault)
  ok('site still has exactly one sales default at the end', finalSalesDefault.length === 1)
  ok('the original default is restored', finalSalesDefault[0]?.id === std?.id)

  const finalStructures = await listPriceStructuresForSetup(SITE)
  ok('price type count back to where it started', finalStructures.length === before.length)
  ok(
    'original order restored',
    finalStructures.map((s) => s.id).join(',') === before.map((s) => s.id).join(','),
  )

  console.log(fails === 0 ? '\nAll passed.' : `\n${fails} FAILED.`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
