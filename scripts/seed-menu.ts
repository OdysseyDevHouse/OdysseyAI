/**
 * Forty products for a test site: the menu of a burger, hotdog and pizza shop.
 *
 *   npm run seed:menu          # create them
 *   npm run seed:menu:wipe     # remove them again
 *
 * ── WHY A MENU RATHER THAN "Test Product 1..40" ──────────────────────────
 *
 * The departments and brands already on ody10000_master say exactly what this
 * shop is — Smash Burgers, Gourmet Hotdogs, Wood-Fired Pizza, Sides & Loaded
 * Fries, Cooldrinks & Shakes, Desserts, with Coca-Cola, Fanta, Sprite,
 * Appletiser, Red Bull and Lipton alongside House Made. Products that fit that
 * shape exercise the screens properly: a department filter has something to
 * separate, a brand filter has something to group, margins differ between a
 * house-made burger and a bought-in can, and the till reads like a till.
 * Forty rows of "Test Product 17" prove only that a list can render.
 *
 * ── WHY IT GOES THROUGH createProduct ────────────────────────────────────
 *
 * Not INSERT statements. createProduct writes the product, its price per
 * structure, its opening pile in product_location_stock AND the `opening`
 * stock movement that accounts for that pile, all in one transaction. Seeding
 * with raw SQL is how you end up with stock that no movement explains, which
 * the reconciliation in seed-stress.mjs exists to catch. Using the same path
 * the product form uses means the seed cannot invent a state the app cannot.
 *
 * ── THE SWEEP ────────────────────────────────────────────────────────────
 *
 * Codes are the shop's own department codes plus three digits (BURG001,
 * PIZZ004). --wipe matches on an ANCHORED, digit-counted pattern so it can
 * only ever remove rows this file made: an unanchored 'BURG%' would take a
 * real product the first time someone coded one that way. Same reasoning as
 * PRODUCT_PATTERN in test-product-setup.ts.
 */
import { createProduct } from '../src/lib/site/products'
import { siteQuery, siteQueryOne, siteExecute } from '../src/lib/siteDb'

const SITE = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 1)
const WIPE = process.argv.includes('--wipe')

/** Anchored and digit-counted — see the sweep note above. */
const CODE_PATTERN = '^(BURG|DOGS|PIZZ|SIDE|DRNK|DSRT)[0-9]{3}$'

// ── The menu ─────────────────────────────────────────────────────────────
//
// cost is EXCLUSIVE of VAT and price is INCLUSIVE, matching how the two are
// stored: products.last_cost excl, product_prices.selling_price_incl incl.
// Both are what the columns mean, so no conversion happens anywhere below.
//
// prep is kitchen minutes; 0 means it comes off a shelf rather than a pass.
type Item = {
  code: string
  description: string
  dept: string
  brand: string
  cost: number
  price: number
  prep?: number
  /** Branded stock lines get a barcode; house-made food has nothing to scan. */
  barcoded?: boolean
  /** The kitchen writes the toppings on the docket. */
  openDescription?: boolean
}

const MENU: Item[] = [
  // ── Smash Burgers ──────────────────────────────────────────────────────
  { code: 'BURG001', description: 'Classic Smash',              dept: 'BURG', brand: 'House Made', cost: 26.0, price: 79.0,  prep: 8 },
  { code: 'BURG002', description: 'Double Smash',               dept: 'BURG', brand: 'House Made', cost: 38.0, price: 109.0, prep: 9 },
  { code: 'BURG003', description: 'Triple Smash Stack',         dept: 'BURG', brand: 'House Made', cost: 52.0, price: 139.0, prep: 11 },
  { code: 'BURG004', description: 'Bacon & Cheddar Smash',      dept: 'BURG', brand: 'House Made', cost: 42.0, price: 119.0, prep: 9 },
  { code: 'BURG005', description: 'Mushroom Swiss Smash',       dept: 'BURG', brand: 'House Made', cost: 40.0, price: 115.0, prep: 10 },
  { code: 'BURG006', description: 'Jalapeno Fire Smash',        dept: 'BURG', brand: 'House Made', cost: 39.0, price: 112.0, prep: 9 },
  { code: 'BURG007', description: 'Buttermilk Chicken Burger',  dept: 'BURG', brand: 'House Made', cost: 36.0, price: 105.0, prep: 12 },
  { code: 'BURG008', description: 'Beyond Veggie Smash',        dept: 'BURG', brand: 'House Made', cost: 44.0, price: 99.0,  prep: 9 },

  // ── Gourmet Hotdogs ────────────────────────────────────────────────────
  { code: 'DOGS001', description: 'New York Dog',               dept: 'DOGS', brand: 'House Made', cost: 22.0, price: 69.0, prep: 6 },
  { code: 'DOGS002', description: 'Chilli Cheese Dog',          dept: 'DOGS', brand: 'House Made', cost: 29.0, price: 85.0, prep: 7 },
  { code: 'DOGS003', description: 'Boerewors Dog',              dept: 'DOGS', brand: 'House Made', cost: 31.0, price: 89.0, prep: 8 },
  { code: 'DOGS004', description: 'Bratwurst & Sauerkraut Dog', dept: 'DOGS', brand: 'House Made', cost: 34.0, price: 95.0, prep: 8 },
  { code: 'DOGS005', description: 'Mac & Cheese Dog',           dept: 'DOGS', brand: 'House Made', cost: 32.0, price: 92.0, prep: 8 },
  { code: 'DOGS006', description: 'Corn Dog',                   dept: 'DOGS', brand: 'House Made', cost: 17.0, price: 55.0, prep: 6 },

  // ── Wood-Fired Pizza ───────────────────────────────────────────────────
  { code: 'PIZZ001', description: 'Margherita 30cm',            dept: 'PIZZ', brand: 'House Made', cost: 31.0, price: 99.0,  prep: 12 },
  { code: 'PIZZ002', description: 'Pepperoni 30cm',             dept: 'PIZZ', brand: 'House Made', cost: 40.0, price: 119.0, prep: 12 },
  { code: 'PIZZ003', description: 'Regina 30cm',                dept: 'PIZZ', brand: 'House Made', cost: 43.0, price: 125.0, prep: 13 },
  { code: 'PIZZ004', description: 'Four Cheese 30cm',           dept: 'PIZZ', brand: 'House Made', cost: 49.0, price: 135.0, prep: 13 },
  { code: 'PIZZ005', description: 'BBQ Chicken 30cm',           dept: 'PIZZ', brand: 'House Made', cost: 51.0, price: 139.0, prep: 14 },
  { code: 'PIZZ006', description: 'Meat Lovers 30cm',           dept: 'PIZZ', brand: 'House Made', cost: 62.0, price: 159.0, prep: 15 },
  { code: 'PIZZ007', description: 'Vegetariana 30cm',           dept: 'PIZZ', brand: 'House Made', cost: 38.0, price: 115.0, prep: 12 },
  { code: 'PIZZ008', description: 'Build Your Own 30cm',        dept: 'PIZZ', brand: 'House Made', cost: 22.0, price: 79.0,  prep: 10, openDescription: true },

  // ── Sides & Loaded Fries ───────────────────────────────────────────────
  { code: 'SIDE001', description: 'Skin-On Fries (Regular)',    dept: 'SIDE', brand: 'House Made', cost: 9.0,  price: 35.0, prep: 5 },
  { code: 'SIDE002', description: 'Skin-On Fries (Large)',      dept: 'SIDE', brand: 'House Made', cost: 13.0, price: 49.0, prep: 5 },
  { code: 'SIDE003', description: 'Cheese & Bacon Loaded Fries',dept: 'SIDE', brand: 'House Made', cost: 24.0, price: 69.0, prep: 7 },
  { code: 'SIDE004', description: 'Chilli Beef Loaded Fries',   dept: 'SIDE', brand: 'House Made', cost: 28.0, price: 75.0, prep: 8 },
  { code: 'SIDE005', description: 'Onion Rings (8)',            dept: 'SIDE', brand: 'House Made', cost: 14.0, price: 45.0, prep: 6 },
  { code: 'SIDE006', description: 'Coleslaw Tub',               dept: 'SIDE', brand: 'House Made', cost: 8.0,  price: 28.0 },

  // ── Cooldrinks & Shakes ────────────────────────────────────────────────
  { code: 'DRNK001', description: 'Coca-Cola 330ml Can',        dept: 'DRNK', brand: 'Coca-Cola',  cost: 8.5,  price: 22.0, barcoded: true },
  { code: 'DRNK002', description: 'Coca-Cola Zero 330ml Can',   dept: 'DRNK', brand: 'Coca-Cola',  cost: 8.5,  price: 22.0, barcoded: true },
  { code: 'DRNK003', description: 'Fanta Orange 330ml Can',     dept: 'DRNK', brand: 'Fanta',      cost: 8.3,  price: 22.0, barcoded: true },
  { code: 'DRNK004', description: 'Sprite 330ml Can',           dept: 'DRNK', brand: 'Sprite',     cost: 8.3,  price: 22.0, barcoded: true },
  { code: 'DRNK005', description: 'Appletiser 330ml',           dept: 'DRNK', brand: 'Appletiser', cost: 12.0, price: 28.0, barcoded: true },
  { code: 'DRNK006', description: 'Red Bull 250ml',             dept: 'DRNK', brand: 'Red Bull',   cost: 19.0, price: 38.0, barcoded: true },
  { code: 'DRNK007', description: 'Lipton Ice Tea Peach 300ml', dept: 'DRNK', brand: 'Lipton',     cost: 11.0, price: 26.0, barcoded: true },
  { code: 'DRNK008', description: 'Chocolate Thick Shake',      dept: 'DRNK', brand: 'House Made', cost: 14.0, price: 45.0, prep: 4 },

  // ── Desserts ───────────────────────────────────────────────────────────
  { code: 'DSRT001', description: 'Warm Chocolate Brownie',     dept: 'DSRT', brand: 'House Made', cost: 15.0, price: 49.0, prep: 5 },
  { code: 'DSRT002', description: 'Soft-Serve Cone',            dept: 'DSRT', brand: 'House Made', cost: 6.5,  price: 25.0, prep: 2 },
  { code: 'DSRT003', description: 'Deep-Fried Ice Cream',       dept: 'DSRT', brand: 'House Made', cost: 21.0, price: 59.0, prep: 6 },
  { code: 'DSRT004', description: 'Malva Pudding & Custard',    dept: 'DSRT', brand: 'House Made', cost: 18.0, price: 55.0, prep: 5 },
]

const DEPARTMENTS: Record<string, { name: string; color: string }> = {
  BURG: { name: 'Smash Burgers',        color: '#c2410c' },
  DOGS: { name: 'Gourmet Hotdogs',      color: '#b45309' },
  PIZZ: { name: 'Wood-Fired Pizza',     color: '#b91c1c' },
  SIDE: { name: 'Sides & Loaded Fries', color: '#a16207' },
  DRNK: { name: 'Cooldrinks & Shakes',  color: '#0369a1' },
  DSRT: { name: 'Desserts',             color: '#9d174d' },
}

/**
 * A valid EAN-13 for a barcoded line, so scanning and check-digit validation
 * both work against this data.
 *
 * The 600-601 prefix is South Africa, which is what a shop here would see on
 * the shelf. These are made up rather than looked up — do not expect the real
 * article to carry the same number.
 *
 * Deliberately NOT the 2 prefix: settings.barcode_variable_prefix is '2' on
 * this site, so a 2xxxxxxxxxxx code would be read as a variable-weight barcode
 * and parsed for an embedded price.
 */
function ean13(seed: number): string {
  const body = '601' + String(seed).padStart(9, '0')
  let sum = 0
  for (let i = 0; i < 12; i++) sum += Number(body[i]) * (i % 2 === 0 ? 1 : 3)
  return body + String((10 - (sum % 10)) % 10)
}

/**
 * Opening stock. A takeaway does not really hold "37 Margheritas", but a test
 * database with every product on zero cannot show a stock take, a reorder
 * suggestion or a movement history — so prepared lines get a notional portion
 * count and bought-in drinks get a believable case quantity.
 *
 * Derived from the code rather than randomised, so a wipe-and-reseed produces
 * the same database twice and a bug found on Tuesday still reproduces Friday.
 */
function openingStock(item: Item): number {
  const n = Number(item.code.slice(4))
  return item.barcoded ? 48 + n * 12 : 24 + n * 6
}

async function lookupOrCreateDepartment(code: string): Promise<number> {
  const found = await siteQueryOne<{ id: number }>(
    SITE,
    'SELECT id FROM departments WHERE code = ? LIMIT 1',
    [code],
  )
  if (found) return Number(found.id)

  const spec = DEPARTMENTS[code]
  console.log(`  department ${code} (${spec.name}) is missing — creating it`)
  const res = await siteExecute(
    SITE,
    'INSERT INTO departments (name, code, color, sort_order) VALUES (?,?,?,?)',
    [spec.name, code, spec.color, Object.keys(DEPARTMENTS).indexOf(code)],
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
    console.log('Removing the seeded menu…')
    await wipe()
    console.log('Done.')
    process.exit(0)
  }

  // The structure the shelf price belongs to. A site always has a default one
  // (001_products.sql seeds Retail), so this is a lookup rather than a create.
  const structure = await siteQueryOne<{ id: number }>(
    SITE,
    'SELECT id FROM price_structures WHERE is_default = 1 ORDER BY position LIMIT 1',
  )
  if (!structure) throw new Error('No default price structure — cannot price anything.')
  const structureId = Number(structure.id)

  const deptIds = new Map<string, number>()
  const brandIds = new Map<string, number>()
  for (const code of Object.keys(DEPARTMENTS)) deptIds.set(code, await lookupOrCreateDepartment(code))
  for (const name of new Set(MENU.map((m) => m.brand))) brandIds.set(name, await lookupOrCreateBrand(name))

  let created = 0
  let skipped = 0
  const failures: string[] = []

  for (const [i, item] of MENU.entries()) {
    const result = await createProduct(SITE, {
      code: item.code,
      description: item.description,
      barcode: item.barcoded ? ean13(i + 1) : null,
      departmentId: deptIds.get(item.dept),
      brandId: brandIds.get(item.brand),
      lastCost: item.cost,
      openingStock: openingStock(item),
      prices: { [structureId]: item.price },
      prepTimeMinutes: item.prep ?? 0,
      changeDescription: item.openDescription ?? false,
      // House-made food can be discounted at the manager's discretion; a
      // bought-in can has too little margin to give away, and 0 means the till
      // refuses a discount outright rather than leaving it to judgement.
      maxDiscountPct: item.barcoded ? 0 : 10,
      visibleInPos: true,
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
      GROUP BY d.id, d.name
      ORDER BY d.sort_order, d.name`,
  )
  console.log('')
  for (const row of summary) {
    console.log(`  ${String(row.n).padStart(2)}  ${row.name.padEnd(24)} stock at cost R ${row.value}`)
  }

  // Explicit, like every test script here: siteDb hands out pooled connections
  // and never closes them, so without this the process sits idle forever after
  // the work is done.
  process.exit(failures.length ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
