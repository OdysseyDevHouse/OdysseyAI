/**
 * Six-packs and cases of the singles in seed-drinks.ts, under their own
 * Bulk Drinks department.
 *
 *   npm run seed:bulk-drinks        # create them
 *   npm run seed:bulk-drinks:wipe   # remove them again
 *
 * Requires seed-drinks.ts to have run first — every row here points at a BEER
 * single, and a pack with nothing to refer to cannot be sold.
 *
 * ── WHY THESE ARE 'refer' PRODUCTS, NOT NORMAL ONES ──────────────────────
 *
 * A six-pack is not a separate thing the shop owns. It is six of the singles
 * already on the shelf, counted differently, and 020_recipes_refers.sql was
 * written for exactly this case: "a six-pack is six singles. Selling one
 * six-pack takes six off the singles. Its own stock is never carried, because
 * there is only one pile of stock and it is measured in singles."
 *
 * Making them normal stocked products instead would put the same beer on two
 * piles, and every one of these would then be a lie the moment either moved:
 * sell six singles and the six-pack still claims to have 10; sell a six-pack
 * and the singles never drop. No stock take could reconcile it, because the
 * question "how many Castle Lagers are in the shop?" would have two answers.
 * The refer type exists so there is one pile and one answer.
 *
 * Three consequences follow, and each is set deliberately below:
 *
 *   1. openingStock is 0 — and MUST be. The pile belongs to the single. A
 *      refer product that carried its own stock would be double-counting the
 *      same beer, which is the whole thing this type prevents.
 *   2. lastCost is 0. Cost comes from the target through compositionCost(),
 *      because nothing was ever bought called "Castle Lager 6-Pack". A figure
 *      typed here would be a second, staler cost competing with the real one.
 *   3. The pack price is NOT the single price × the factor. A pack is cheaper
 *      per unit than a single — that is the entire reason a customer buys one.
 *
 * ── WHY ITS OWN DEPARTMENT ───────────────────────────────────────────────
 *
 * Asked for, and independently right: mixed into Drinks, a department total
 * would count the same beer twice — once as singles and once inside the packs
 * — and the till tab would show a Castle Lager entry that is really the same
 * stock as the one above it. Separated, "Drinks" means singles and "Bulk
 * Drinks" means multipacks, and neither total overlaps the other.
 *
 * ── THE SWEEP ────────────────────────────────────────────────────────────
 *
 * --wipe matches an ANCHORED, digit-counted pattern so it can only ever remove
 * rows this file made. An unanchored 'BULK%' would take a real product the
 * first time someone coded one that way. Same reasoning as seed-menu.ts.
 */
import { createProduct } from '../src/lib/site/products'
import { saveRefer } from '../src/lib/site/productComposition'
import { siteQuery, siteQueryOne, siteExecute } from '../src/lib/siteDb'

/** The Smash Burger Joint is site 2. Override with a bare number argument. */
const SITE = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 2)
const WIPE = process.argv.includes('--wipe')

/** Anchored and digit-counted — see the sweep note above. */
const CODE_PATTERN = '^BULK[0-9]{3}$'

const DEPARTMENT = { code: 'BULK', name: 'Bulk Drinks', color: '#7c3aed' }

type Item = {
  code: string
  description: string
  /** The BEER code this is a multipack OF. Must already exist. */
  target: string
  /** How many singles make one of these. Six for a six-pack. */
  factor: number
  /** INCLUSIVE of VAT, matching product_prices.selling_price_incl. */
  price: number
  group: string
}

/*
 * Prices are deliberately below single-price × factor — a six-pack at six times
 * the bar price is one nobody buys. Roughly 12% off for a six-pack and 18% off
 * for a case, which is the shape of real takeaway liquor pricing. The saving is
 * asserted at the end of the run rather than trusted.
 */
const BULK: Item[] = [
  // ── Six-packs ──────────────────────────────────────────────────────────
  { code: 'BULK001', description: 'Castle Lager 6-Pack',        target: 'BEER001', factor: 6,  price: 169.0,  group: 'Six-packs' },
  { code: 'BULK002', description: 'Castle Lite 6-Pack',         target: 'BEER002', factor: 6,  price: 179.0,  group: 'Six-packs' },
  { code: 'BULK003', description: 'Black Label 6-Pack',         target: 'BEER003', factor: 6,  price: 175.0,  group: 'Six-packs' },
  { code: 'BULK004', description: 'Hansa Pilsener 6-Pack',      target: 'BEER004', factor: 6,  price: 169.0,  group: 'Six-packs' },
  { code: 'BULK005', description: 'Amstel Lager 6-Pack',        target: 'BEER005', factor: 6,  price: 189.0,  group: 'Six-packs' },
  { code: 'BULK006', description: 'Windhoek Draught 6-Pack',    target: 'BEER006', factor: 6,  price: 219.0,  group: 'Six-packs' },
  { code: 'BULK007', description: 'Heineken 6-Pack',            target: 'BEER020', factor: 6,  price: 219.0,  group: 'Six-packs' },
  { code: 'BULK008', description: 'Corona Extra 6-Pack',        target: 'BEER021', factor: 6,  price: 259.0,  group: 'Six-packs' },
  { code: 'BULK009', description: 'Savanna Dry 6-Pack',         target: 'BEER050', factor: 6,  price: 219.0,  group: 'Six-packs' },
  { code: 'BULK010', description: 'Heineken 0.0 6-Pack',        target: 'BEER041', factor: 6,  price: 199.0,  group: 'Six-packs' },

  // ── Cases ──────────────────────────────────────────────────────────────
  { code: 'BULK020', description: 'Castle Lager Case (24)',     target: 'BEER001', factor: 24, price: 629.0,  group: 'Cases' },
  { code: 'BULK021', description: 'Castle Lite Case (24)',      target: 'BEER002', factor: 24, price: 669.0,  group: 'Cases' },
  { code: 'BULK022', description: 'Black Label Case (24)',      target: 'BEER003', factor: 24, price: 649.0,  group: 'Cases' },
  { code: 'BULK023', description: 'Hansa Pilsener Case (24)',   target: 'BEER004', factor: 24, price: 629.0,  group: 'Cases' },
  { code: 'BULK024', description: 'Amstel Lager Case (24)',     target: 'BEER005', factor: 24, price: 709.0,  group: 'Cases' },
  { code: 'BULK025', description: 'Windhoek Draught Case (24)', target: 'BEER006', factor: 24, price: 829.0,  group: 'Cases' },
  { code: 'BULK026', description: 'Heineken Case (24)',         target: 'BEER020', factor: 24, price: 829.0,  group: 'Cases' },
  { code: 'BULK027', description: 'Corona Extra Case (24)',     target: 'BEER021', factor: 24, price: 969.0,  group: 'Cases' },
  { code: 'BULK028', description: 'Savanna Dry Case (24)',      target: 'BEER050', factor: 24, price: 829.0,  group: 'Cases' },
  { code: 'BULK029', description: 'Guinness Case (24)',         target: 'BEER023', factor: 24, price: 1149.0, group: 'Cases' },
]

/**
 * A valid EAN-13, so scanning and check-digit validation both work here.
 *
 * A multipack carries its OWN barcode in real life — the outer wrap is scanned,
 * not the bottles inside — so these are distinct numbers rather than a repeat
 * of the single's. Offset again from seed-drinks.ts's range so the two ranges
 * cannot collide; the run asserts site-wide uniqueness regardless.
 *
 * Deliberately NOT the 2 prefix: settings.barcode_variable_prefix is '2', so a
 * 2xxxxxxxxxxx code reads as a variable-weight barcode and gets parsed for an
 * embedded price.
 */
function ean13(seed: number): string {
  const body = '601' + String(700 + seed).padStart(9, '0')
  let sum = 0
  for (let i = 0; i < 12; i++) sum += Number(body[i]) * (i % 2 === 0 ? 1 : 3)
  return body + String((10 - (sum % 10)) % 10)
}

async function lookupOrCreateDepartment(): Promise<number> {
  const found = await siteQueryOne<{ id: number }>(
    SITE,
    'SELECT id FROM departments WHERE code = ? LIMIT 1',
    [DEPARTMENT.code],
  )
  if (found) return Number(found.id)

  // Sorted after whatever is already there, so the till tabs keep their
  // existing order rather than shuffling when this runs.
  const last = await siteQueryOne<{ n: number }>(
    SITE,
    'SELECT COALESCE(MAX(sort_order), 0) AS n FROM departments',
  )
  console.log(`  department ${DEPARTMENT.code} (${DEPARTMENT.name}) is missing — creating it`)
  const res = await siteExecute(
    SITE,
    'INSERT INTO departments (name, code, color, sort_order) VALUES (?,?,?,?)',
    [DEPARTMENT.name, DEPARTMENT.code, DEPARTMENT.color, Number(last?.n ?? 0) + 1],
  )
  return Number(res.insertId)
}

async function wipe() {
  // product_refers cascades on product_id, but the singles these point AT are
  // protected by ON DELETE RESTRICT — which is the right way round: this sweep
  // can remove packs freely and could never take a single with them.
  const target = `(SELECT id FROM (SELECT id FROM products WHERE code REGEXP '${CODE_PATTERN}') t)`
  for (const table of ['product_refers', 'stock_movements', 'product_location_stock', 'product_prices']) {
    const res = await siteExecute(SITE, `DELETE FROM ${table} WHERE product_id IN ${target}`)
    if (res.affectedRows) console.log(`  ${table}: ${res.affectedRows} row(s) removed`)
  }
  const res = await siteExecute(SITE, `DELETE FROM products WHERE code REGEXP '${CODE_PATTERN}'`)
  console.log(`  products: ${res.affectedRows} row(s) removed`)
}

async function main() {
  console.log(`site ${SITE}`)

  if (WIPE) {
    console.log('Removing the seeded bulk drinks…')
    await wipe()
    console.log('Done.')
    process.exit(0)
  }

  const structure = await siteQueryOne<{ id: number }>(
    SITE,
    'SELECT id FROM price_structures WHERE is_default = 1 ORDER BY position LIMIT 1',
  )
  if (!structure) throw new Error('No default price structure — cannot price anything.')
  const structureId = Number(structure.id)

  // The singles have to exist before anything can refer to them. Failing here
  // with the missing codes named beats creating 20 packs that cannot be sold.
  const singles = new Map<string, { id: number; price: number; brandId: number | null }>()
  for (const code of new Set(BULK.map((b) => b.target))) {
    const row = await siteQueryOne<{ id: number; brand_id: number | null; price: string | null }>(
      SITE,
      `SELECT p.id, p.brand_id, pr.selling_price_incl AS price
         FROM products p
         LEFT JOIN product_prices pr ON pr.product_id = p.id AND pr.price_structure_id = ?
        WHERE p.code = ? LIMIT 1`,
      [structureId, code],
    )
    if (!row) {
      console.error(
        `\n  ${code} is not on this site. Run "npm run seed:drinks" first — a pack ` +
          'needs the single it is a pack of.',
      )
      process.exit(1)
    }
    singles.set(code, {
      id: Number(row.id),
      price: Number(row.price ?? 0),
      brandId: row.brand_id === null ? null : Number(row.brand_id),
    })
  }

  const departmentId = await lookupOrCreateDepartment()

  let created = 0
  let skipped = 0
  let linked = 0
  const failures: string[] = []

  for (const [i, item] of BULK.entries()) {
    const single = singles.get(item.target)!

    const result = await createProduct(SITE, {
      code: item.code,
      description: item.description,
      barcode: ean13(i + 1),
      departmentId,
      // The same brand as the beer inside it — a Castle case is still Castle,
      // and the brand filter should find it alongside the single.
      brandId: single.brandId ?? undefined,
      productType: 'refer',
      prices: { [structureId]: item.price },
      visibleInPos: true,

      // Both zero, and both deliberate — see the header. The pile and the cost
      // belong to the single this refers to.
      openingStock: 0,
      lastCost: 0,

      // A case is sold whole; half a case is a typo rather than a quantity.
      allowFractions: false,
      weightDescription: 'Each',
      packSize: item.factor,
      packDescription: item.factor === 6 ? 'Six-pack' : 'Case',

      prepTimeMinutes: 0,
      maxDiscountPct: 0,
    })

    if (result.ok) {
      created++
    } else if (result.error.includes('already in use')) {
      skipped++
    } else {
      failures.push(`${item.code}: ${result.error}`)
      continue
    }

    // The product row alone is inert: without the refer link it resolves to
    // "no linked product set up yet" and the till refuses to sell it. Done on
    // every pass, not just creation, so a half-finished earlier run repairs.
    const id = await siteQueryOne<{ id: number }>(
      SITE,
      'SELECT id FROM products WHERE code = ? LIMIT 1',
      [item.code],
    )
    if (!id) {
      failures.push(`${item.code}: created but could not be read back`)
      continue
    }
    const link = await saveRefer(SITE, Number(id.id), single.id, item.factor)
    if (link.ok) linked++
    else failures.push(`${item.code}: refer link failed — ${link.error}`)
  }

  console.log(
    `\n${created} created, ${skipped} already present, ${linked} refer link(s) set, ${failures.length} failed`,
  )
  for (const f of failures) console.log('  ' + f)

  /*
   * A pack that costs more per beer than buying them singly is a pricing bug
   * that reads as a plausible number, so it is checked rather than eyeballed.
   */
  // `each` and `single` are reserved words in MariaDB — hence per_unit/one_off.
  const overpriced = await siteQuery<{ code: string; description: string; per_unit: string; one_off: string }>(
    SITE,
    `SELECT p.code, p.description,
            ROUND(pr.selling_price_incl / r.factor, 2) AS per_unit,
            ROUND(spr.selling_price_incl, 2) AS one_off
       FROM products p
       JOIN product_refers r  ON r.product_id = p.id
       JOIN product_prices pr ON pr.product_id = p.id AND pr.price_structure_id = ?
       JOIN product_prices spr ON spr.product_id = r.target_id AND spr.price_structure_id = ?
      WHERE p.code REGEXP '${CODE_PATTERN}'
        AND pr.selling_price_incl / r.factor >= spr.selling_price_incl`,
    [structureId, structureId],
  )
  if (overpriced.length) {
    console.log('\n  ** these cost as much or more per unit than the single: **')
    for (const r of overpriced) console.log(`     ${r.code} ${r.description}: R ${r.per_unit} vs R ${r.one_off}`)
  }

  const summary = await siteQuery<{ pack: string; n: number }>(
    SITE,
    `SELECT p.pack_description AS pack, COUNT(*) AS n
       FROM products p
      WHERE p.code REGEXP '${CODE_PATTERN}'
      GROUP BY p.pack_description
      ORDER BY p.pack_description`,
  )
  console.log('')
  for (const row of summary) console.log(`  ${String(row.n).padStart(2)}  ${row.pack}`)

  // Explicit, like every script here: siteDb hands out pooled connections and
  // never closes them, so without this the process sits idle forever.
  process.exit(failures.length || overpriced.length ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
