/**
 * A blank document starts on the shop's default price structure.
 *
 *   npm run test:blank-document-pricing
 *
 * `createBlankDocument` used to write `price_structure_id = NULL`, and a null
 * structure prices EVERYTHING at zero: the till's product query left-joins
 * `product_prices` on the structure it is given, so with none there is no row
 * to join and every product resolves at 0.00. A new invoice rang up the whole
 * catalogue for nothing until somebody attached a customer.
 *
 * That was survivable while every price was typeable — a person sees R0.00 next
 * to a loaf of bread and fixes it. It stopped being survivable with percentage
 * charges (006), which are DERIVED: such a line silently computes a percentage
 * of a zero bill, and there is nothing on screen to correct.
 */
import { siteExecute, siteQuery, siteQueryOne } from '../src/lib/siteDb'
import { createBlankDocument } from '../src/lib/site/salesDocuments'

const SITE = Number(process.env.PROBE_SITE ?? 1)
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

async function main() {
  const fallback = await siteQueryOne<{ id: number }>(
    SITE,
    `SELECT id FROM price_structures WHERE is_default = 1 AND is_active = 1 ORDER BY id LIMIT 1`,
  )

  const made = await createBlankDocument(SITE, { userId: 1, userName: 'Test' }, 'invoice', 'till')
  if (!made.ok) {
    console.log('**FAIL**  could not start a document --', made.error)
    process.exit(1)
  }

  const row = await siteQueryOne<{ price_structure_id: number | null }>(
    SITE,
    `SELECT price_structure_id FROM sales_documents WHERE id = ?`,
    [made.id],
  )

  if (fallback) {
    ok(
      'a new document opens on the default price structure',
      row?.price_structure_id === fallback.id,
      `got ${row?.price_structure_id}, default is ${fallback.id}`,
    )
  } else {
    // A shop with no default configured keeps the old behaviour rather than
    // inventing a structure — there is no right answer to invent.
    ok(
      'with no default configured it stays null, as before',
      row?.price_structure_id === null,
      String(row?.price_structure_id),
    )
  }

  // A quote and an order go through the same call, so they cannot drift.
  for (const type of ['quote', 'sales_order'] as const) {
    const other = await createBlankDocument(SITE, { userId: 1, userName: 'Test' }, type, 'till')
    if (!other.ok) { ok(`a blank ${type} is created`, false, other.error); continue }
    const r = await siteQueryOne<{ price_structure_id: number | null }>(
      SITE, `SELECT price_structure_id FROM sales_documents WHERE id = ?`, [other.id])
    ok(
      `a blank ${type} opens on the same structure`,
      r?.price_structure_id === (fallback?.id ?? null),
      String(r?.price_structure_id),
    )
    await siteExecute(SITE, `DELETE FROM sales_documents WHERE id = ?`, [other.id])
  }

  await siteExecute(SITE, `DELETE FROM sales_documents WHERE id = ?`, [made.id])
  const left = await siteQuery<any>(SITE, `SELECT id FROM sales_documents WHERE id = ?`, [made.id])
  ok('the test leaves nothing behind', left.length === 0)
}

main().then(
  () => { console.log(fails === 0 ? '\nAll blank-document checks passed.\n' : `\n${fails} FAILED\n`); process.exit(fails === 0 ? 0 : 1) },
  (e) => { console.error(e); process.exit(1) },
)
