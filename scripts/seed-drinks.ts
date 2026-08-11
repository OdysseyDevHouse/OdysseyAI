/**
 * The bar fridge: beers, ciders and ready-to-drinks, grouped under one Drinks
 * department.
 *
 *   npm run seed:drinks        # create them
 *   npm run seed:drinks:wipe   # remove them again
 *
 * ── WHY A SEPARATE DEPARTMENT FROM "Cooldrinks & Shakes" ─────────────────
 *
 * The site already has DRNK for cooldrinks and shakes, and putting a Castle
 * Lager in it would be the easy thing to do. These are kept apart because
 * alcohol differs from a Coke in ways the shop has to act on, and a department
 * is where the app already carries that difference:
 *
 *   1. Trading hours. Liquor cannot be sold at every hour a cooldrink can. A
 *      department is the grain a rule like that gets written against; mixed in
 *      with shakes there is nothing to write it against.
 *   2. Reporting. Liquor turnover is a number a licensed shop reports on its
 *      own. Buried in DRNK it can only be recovered by picking rows out by name.
 *   3. Margin. Beer runs a thinner, more competitive margin than a fountain
 *      drink, so a GP report that averages the two describes neither.
 *
 * ── COSTS AND PRICES ─────────────────────────────────────────────────────
 *
 * cost is EXCLUSIVE of VAT, price is INCLUSIVE — matching how the two columns
 * are stored (products.last_cost excl, product_prices.selling_price_incl incl),
 * so nothing below converts. Figures are mid-2026 South African on-consumption
 * prices, rounded to what a menu would actually print rather than looked up.
 * They are meant to be edited.
 *
 * ── WHY IT GOES THROUGH createProduct ────────────────────────────────────
 *
 * Not INSERT statements. createProduct writes the product, its price, its
 * opening pile in product_location_stock AND the `opening` stock movement that
 * accounts for that pile, in one transaction. Raw SQL is how you end up with
 * stock no movement explains, which the reconciliation exists to catch.
 *
 * ── THE SWEEP ────────────────────────────────────────────────────────────
 *
 * --wipe matches an ANCHORED, digit-counted pattern so it can only ever remove
 * rows this file made. An unanchored 'BEER%' would take a real product the
 * first time someone coded one that way. Same reasoning as seed-menu.ts.
 */
import { createProduct } from '../src/lib/site/products'
import { siteQuery, siteQueryOne, siteExecute } from '../src/lib/siteDb'

/** The Smash Burger Joint is site 2. Override with a bare number argument. */
const SITE = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 2)
const WIPE = process.argv.includes('--wipe')

/** Anchored and digit-counted — see the sweep note above. */
const CODE_PATTERN = '^BEER[0-9]{3}$'

const DEPARTMENT = { code: 'DRIN', name: 'Drinks', color: '#1d4ed8' }

type Item = {
  code: string
  description: string
  brand: string
  /** EXCLUSIVE of VAT, matching products.last_cost. */
  cost: number
  /** INCLUSIVE of VAT, matching product_prices.selling_price_incl. */
  price: number
  group: string
}

const DRINKS: Item[] = [
  // ── Local beer ─────────────────────────────────────────────────────────
  { code: 'BEER001', description: 'Castle Lager 340ml NRB',        brand: 'Castle',       cost: 12.5, price: 32.0, group: 'Local beer' },
  { code: 'BEER002', description: 'Castle Lite 340ml NRB',         brand: 'Castle',       cost: 13.2, price: 34.0, group: 'Local beer' },
  { code: 'BEER003', description: 'Black Label 340ml NRB',         brand: 'Carling',      cost: 12.8, price: 33.0, group: 'Local beer' },
  { code: 'BEER004', description: 'Hansa Pilsener 340ml NRB',      brand: 'Hansa',        cost: 12.2, price: 32.0, group: 'Local beer' },
  { code: 'BEER005', description: 'Amstel Lager 330ml NRB',        brand: 'Amstel',       cost: 14.0, price: 36.0, group: 'Local beer' },
  { code: 'BEER006', description: 'Windhoek Draught 440ml Can',    brand: 'Windhoek',     cost: 16.5, price: 42.0, group: 'Local beer' },
  { code: 'BEER007', description: 'Windhoek Lager 330ml NRB',      brand: 'Windhoek',     cost: 14.5, price: 37.0, group: 'Local beer' },

  // ── Imported & premium ─────────────────────────────────────────────────
  { code: 'BEER020', description: 'Heineken 330ml NRB',            brand: 'Heineken',     cost: 16.0, price: 42.0, group: 'Imported' },
  { code: 'BEER021', description: 'Corona Extra 330ml NRB',        brand: 'Corona',       cost: 19.5, price: 49.0, group: 'Imported' },
  { code: 'BEER022', description: 'Stella Artois 330ml NRB',       brand: 'Stella Artois', cost: 18.0, price: 46.0, group: 'Imported' },
  { code: 'BEER023', description: 'Guinness Draught 440ml Can',    brand: 'Guinness',     cost: 24.0, price: 58.0, group: 'Imported' },

  // ── Craft ──────────────────────────────────────────────────────────────
  { code: 'BEER030', description: 'Devils Peak Lager 340ml NRB',   brand: 'Devil’s Peak', cost: 18.5, price: 48.0, group: 'Craft' },
  { code: 'BEER031', description: 'Jack Black Pilsner 340ml NRB',  brand: 'Jack Black',   cost: 19.0, price: 49.0, group: 'Craft' },
  { code: 'BEER032', description: 'Darling Slow Beer 340ml NRB',   brand: 'Darling Brew', cost: 20.0, price: 52.0, group: 'Craft' },

  // ── Alcohol-free ───────────────────────────────────────────────────────
  //
  // Stays in Drinks rather than with the cooldrinks: it is bought from the
  // liquor supplier, sits in the same fridge and is ordered off the same list.
  { code: 'BEER040', description: 'Castle Free 340ml NRB (0%)',    brand: 'Castle',       cost: 11.5, price: 30.0, group: 'Alcohol-free' },
  { code: 'BEER041', description: 'Heineken 0.0 330ml NRB',        brand: 'Heineken',     cost: 15.0, price: 38.0, group: 'Alcohol-free' },

  // ── Cider & RTD ────────────────────────────────────────────────────────
  { code: 'BEER050', description: 'Savanna Dry 330ml NRB',         brand: 'Savanna',      cost: 16.5, price: 42.0, group: 'Cider & RTD' },
  { code: 'BEER051', description: 'Hunters Gold 330ml NRB',        brand: 'Hunter’s', cost: 16.0, price: 41.0, group: 'Cider & RTD' },
  { code: 'BEER052', description: 'Brutal Fruit Ruby 275ml NRB',   brand: 'Brutal Fruit', cost: 15.5, price: 40.0, group: 'Cider & RTD' },
  { code: 'BEER053', description: 'Bernini Blush 275ml NRB',       brand: 'Bernini',      cost: 15.5, price: 40.0, group: 'Cider & RTD' },
]

/**
 * A valid EAN-13, so scanning and check-digit validation both work here.
 *
 * The 600-601 prefix is South Africa, which is what a shop here would see on
 * the shelf — made up rather than looked up, so do not expect the real bottle
 * to carry this number.
 *
 * Deliberately NOT the 2 prefix: settings.barcode_variable_prefix is '2', so a
 * 2xxxxxxxxxxx code reads as a variable-weight barcode and gets parsed for an
 * embedded price. Offset from seed-menu.ts's range so the two never collide.
 */
function ean13(seed: number): string {
  const body = '601' + String(500 + seed).padStart(9, '0')
  let sum = 0
  for (let i = 0; i < 12; i++) sum += Number(body[i]) * (i % 2 === 0 ? 1 : 3)
  return body + String((10 - (sum % 10)) % 10)
}

/**
 * Opening stock, in single units.
 *
 * Derived from the code rather than randomised, so a wipe-and-reseed produces
 * the same database twice and a bug found on Tuesday still reproduces Friday.
 * Roughly a case or two of each, which is what a fridge actually holds.
 */
function openingStock(item: Item): number {
  return 24 + (Number(item.code.slice(4)) % 12) * 6
}

async function lookupOrCreateDepartment(): Promise<number> {
  const found = await siteQueryOne<{ id: number }>(
    SITE,
    'SELECT id FROM departments WHERE code = ? LIMIT 1',
    [DEPARTMENT.code],
  )
  if (found) return Number(found.id)

  // Sorted after whatever is already there, so the till tabs keep their
  // existing order and Drinks lands at the end rather than shuffling the menu.
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

async function lookupOrCreateBrand(name: string): Promise<number> {
  const found = await siteQueryOne<{ id: number }>(
    SITE,
    'SELECT id FROM brands WHERE name = ? LIMIT 1',
    [name],
  )
  if (found) return Number(found.id)

  console.log(`  brand "${name}" is missing — creating it`)
  const res = await siteExecute(SITE, 'INSERT INTO brands (name) VALUES (?)', [name])
  return Number(res.insertId)
}

async function wipe() {
  // Children first. product_prices and product_location_stock would cascade,
  // but stock_movements has no ON DELETE CASCADE and would block the delete.
  const target = `(SELECT id FROM (SELECT id FROM products WHERE code REGEXP '${CODE_PATTERN}') t)`
  for (const table of ['stock_movements', 'product_location_stock', 'product_prices']) {
    const res = await siteExecute(SITE, `DELETE FROM ${table} WHERE product_id IN ${target}`)
    if (res.affectedRows) console.log(`  ${table}: ${res.affectedRows} row(s) removed`)
  }
  const res = await siteExecute(SITE, `DELETE FROM products WHERE code REGEXP '${CODE_PATTERN}'`)
  console.log(`  products: ${res.affectedRows} row(s) removed`)
}

async function main() {
  console.log(`site ${SITE}`)

  if (WIPE) {
    console.log('Removing the seeded drinks…')
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

  const departmentId = await lookupOrCreateDepartment()
  const brandIds = new Map<string, number>()
  for (const name of new Set(DRINKS.map((d) => d.brand))) {
    brandIds.set(name, await lookupOrCreateBrand(name))
  }

  let created = 0
  let skipped = 0
  const failures: string[] = []

  for (const [i, item] of DRINKS.entries()) {
    const result = await createProduct(SITE, {
      code: item.code,
      description: item.description,
      barcode: ean13(i + 1),
      departmentId,
      brandId: brandIds.get(item.brand),
      lastCost: item.cost,
      openingStock: openingStock(item),
      prices: { [structureId]: item.price },
      visibleInPos: true,

      // Comes out of a fridge, not off a pass — there is nothing to prepare.
      prepTimeMinutes: 0,

      // A sealed bottle is sold whole. Allowing fractions here would let a
      // stock take record half a beer, which is a typo rather than a quantity.
      allowFractions: false,
      weightDescription: 'Each',

      // How it ARRIVES from the supplier, which is what a purchase order is
      // written in: beer by the case of 24, ciders and RTDs the same.
      packSize: 24,
      packDescription: 'Case',

      // Bought-in stock at a thin margin: 0 means the till refuses a discount
      // outright rather than leaving it to a cashier's judgement. Same call as
      // the barcoded cans in seed-menu.ts.
      maxDiscountPct: 0,
    })

    if (result.ok) {
      created++
    } else if (result.error.includes('already in use')) {
      skipped++
    } else {
      failures.push(`${item.code}: ${result.error}`)
    }
  }

  console.log(`\n${created} created, ${skipped} already present, ${failures.length} failed`)
  for (const f of failures) console.log('  ' + f)

  const summary = await siteQuery<{ name: string; n: number; value: string }>(
    SITE,
    `SELECT d.name,
            COUNT(*) AS n,
            FORMAT(SUM(p.stock_on_hand * p.average_cost), 2) AS value
       FROM products p
       JOIN departments d ON d.id = p.department_id
      WHERE p.code REGEXP '${CODE_PATTERN}'
      GROUP BY d.id, d.name`,
  )
  console.log('')
  for (const row of summary) {
    console.log(`  ${String(row.n).padStart(2)}  ${row.name.padEnd(24)} stock at cost R ${row.value}`)
  }

  // Explicit, like every script here: siteDb hands out pooled connections and
  // never closes them, so without this the process sits idle forever.
  process.exit(failures.length ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
