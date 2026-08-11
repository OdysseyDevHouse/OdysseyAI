/**
 * The raw ingredients a smash burger kitchen buys, so recipes have something to
 * be built from.
 *
 *   npm run seed:ingredients        # create them
 *   npm run seed:ingredients:wipe   # remove them again
 *
 * ── WHY INGREDIENTS ARE NOT MENU ITEMS ───────────────────────────────────
 *
 * The menu already on this site (SB-, HD-, PZ-, SD-, DR-, DS-) is what a
 * customer orders. These rows are what the kitchen consumes to make it: mince,
 * buns, tomatoes, cheese slices. They differ in three ways that all follow from
 * that one fact, and each is set deliberately below:
 *
 *   1. Their own department. An ingredient in "Smash Burgers" would appear on
 *      the till's burger tab next to the burgers, which is the one place it must
 *      never be. INGR keeps the catalogue readable and the till honest.
 *
 *   2. visibleInPos: false. Nobody sells a cashier 200g of mince. The row exists
 *      to be counted, ordered and deducted — never rung up.
 *
 *   3. Cost is the number that matters. A recipe prices the finished burger off
 *      its ingredients' cost, so last_cost is the real figure here. A nominal
 *      selling price is still set: with none at all every ingredient reads as a
 *      100% margin line in stock valuation and GP reports, which is noise.
 *
 * ── UNITS ────────────────────────────────────────────────────────────────
 *
 * There is no unit-of-measure table; weight_description carries the unit and
 * allow_fractions decides whether a fraction of one is meaningful. Mince is
 * bought and consumed per Kg, so a recipe line of 0.150 has to be allowed. Buns
 * come each, and half a bun on a stock take is a typo rather than a quantity.
 * pack_size / pack_description record how it ARRIVES from the supplier — a 60-
 * unit bun bag — which is what a purchase order is written in.
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
 * rows this file made. An unanchored 'ING%' would take a real product the first
 * time someone coded one that way. Same reasoning as seed-menu.ts.
 */
import { createProduct } from '../src/lib/site/products'
import { siteQuery, siteQueryOne, siteExecute } from '../src/lib/siteDb'

/** The Smash Burger Joint is site 2. Override with a bare number argument. */
const SITE = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 2)
const WIPE = process.argv.includes('--wipe')

/** Anchored and digit-counted — see the sweep note above. */
const CODE_PATTERN = '^ING-[0-9]{3}$'

const DEPARTMENT = { code: 'INGR', name: 'Kitchen Ingredients', color: '#4d7c0f' }

/**
 * "House Made" is for things the kitchen produces. An ingredient is bought in,
 * and grouping them all under one supplier-agnostic brand keeps the brand filter
 * meaningful without inventing suppliers the shop may not use.
 */
const BRAND = 'Kitchen Supply'

type Item = {
  code: string
  description: string
  /** EXCLUSIVE of VAT, matching products.last_cost. Per ONE unit below. */
  cost: number
  /** The unit a recipe line is written in: Kg, g, L, ml, Each. */
  unit: (typeof UNITS)[number]
  /** How it arrives from the supplier. 0 pack size means "as single units". */
  packSize?: number
  packDescription?: string
  /** Opening pile, in `unit`. */
  stock: number
  /** Shelf life in days, where the kitchen would actually track it. */
  expiresInDays?: number
  group: string
}

const UNITS = ['Kg', 'g', 'L', 'ml', 'Each'] as const

/*
 * Costs are mid-2026 South African wholesale, rounded to something a buyer would
 * recognise rather than looked up — they are meant to be edited. Everything is
 * per single unit: R 89.00 for Kg means R 89.00 a kilogram, not per box.
 */
const INGREDIENTS: Item[] = [
  // ── Proteins ───────────────────────────────────────────────────────────
  { code: 'ING-001', description: 'Beef Mince (80/20 Chuck)', cost: 118.0, unit: 'Kg',   packSize: 5,  packDescription: 'Bag',  stock: 25,  expiresInDays: 4,  group: 'Proteins' },
  { code: 'ING-002', description: 'Beef Brisket (Smoked)',    cost: 165.0, unit: 'Kg',   packSize: 3,  packDescription: 'Bag',  stock: 8,   expiresInDays: 5,  group: 'Proteins' },
  { code: 'ING-003', description: 'Chicken Breast Fillet',    cost: 92.0,  unit: 'Kg',   packSize: 5,  packDescription: 'Bag',  stock: 15,  expiresInDays: 3,  group: 'Proteins' },
  { code: 'ING-004', description: 'Streaky Bacon Rashers',    cost: 135.0, unit: 'Kg',   packSize: 2,  packDescription: 'Pack', stock: 10,  expiresInDays: 10, group: 'Proteins' },
  { code: 'ING-005', description: 'Plant-Based Patty 110g',   cost: 18.5,  unit: 'Each', packSize: 24, packDescription: 'Box',  stock: 48,  expiresInDays: 60, group: 'Proteins' },

  // ── Bakery ─────────────────────────────────────────────────────────────
  { code: 'ING-010', description: 'Brioche Burger Bun',       cost: 4.8,  unit: 'Each', packSize: 60, packDescription: 'Bag', stock: 240, expiresInDays: 4, group: 'Bakery' },
  { code: 'ING-011', description: 'Sesame Seed Bun',          cost: 3.6,  unit: 'Each', packSize: 60, packDescription: 'Bag', stock: 180, expiresInDays: 4, group: 'Bakery' },
  { code: 'ING-012', description: 'Potato Slider Bun',        cost: 2.9,  unit: 'Each', packSize: 72, packDescription: 'Bag', stock: 144, expiresInDays: 4, group: 'Bakery' },
  { code: 'ING-013', description: 'Hotdog Roll',              cost: 3.2,  unit: 'Each', packSize: 48, packDescription: 'Bag', stock: 96,  expiresInDays: 4, group: 'Bakery' },

  // ── Dairy ──────────────────────────────────────────────────────────────
  { code: 'ING-020', description: 'Cheddar Cheese Slice',     cost: 1.85, unit: 'Each', packSize: 84, packDescription: 'Box',  stock: 420, expiresInDays: 45, group: 'Dairy' },
  { code: 'ING-021', description: 'Mozzarella (Grated)',      cost: 108.0, unit: 'Kg',  packSize: 2,  packDescription: 'Bag',  stock: 6,   expiresInDays: 21, group: 'Dairy' },
  { code: 'ING-022', description: 'Blue Cheese Crumble',      cost: 189.0, unit: 'Kg',  packSize: 1,  packDescription: 'Pack', stock: 2,   expiresInDays: 30, group: 'Dairy' },
  { code: 'ING-023', description: 'Butter (Unsalted)',        cost: 145.0, unit: 'Kg',  packSize: 1,  packDescription: 'Pack', stock: 5,   expiresInDays: 60, group: 'Dairy' },
  { code: 'ING-024', description: 'Full Cream Milk',          cost: 19.5, unit: 'L',    packSize: 6,  packDescription: 'Crate', stock: 24, expiresInDays: 7,  group: 'Dairy' },
  { code: 'ING-025', description: 'Vanilla Ice Cream Base',   cost: 62.0, unit: 'L',    packSize: 5,  packDescription: 'Case',  stock: 15,  expiresInDays: 90, group: 'Dairy' },
  { code: 'ING-026', description: 'Free Range Eggs',          cost: 2.75, unit: 'Each', packSize: 30, packDescription: 'Tray', stock: 120, expiresInDays: 21, group: 'Dairy' },

  // ── Produce ────────────────────────────────────────────────────────────
  { code: 'ING-030', description: 'Tomatoes',                 cost: 24.0, unit: 'Kg',   packSize: 5,  packDescription: 'Crate', stock: 12, expiresInDays: 6, group: 'Produce' },
  { code: 'ING-031', description: 'Iceberg Lettuce',          cost: 18.5, unit: 'Kg',   packSize: 5,  packDescription: 'Crate', stock: 10, expiresInDays: 5, group: 'Produce' },
  { code: 'ING-032', description: 'Red Onions',               cost: 16.0, unit: 'Kg',   packSize: 10, packDescription: 'Bag',   stock: 20, expiresInDays: 21, group: 'Produce' },
  { code: 'ING-033', description: 'White Onions',             cost: 13.5, unit: 'Kg',   packSize: 10, packDescription: 'Bag',   stock: 20, expiresInDays: 21, group: 'Produce' },
  { code: 'ING-034', description: 'Potatoes (Chipping)',      cost: 12.0, unit: 'Kg',   packSize: 10, packDescription: 'Bag',   stock: 60, expiresInDays: 21, group: 'Produce' },
  { code: 'ING-035', description: 'Dill Pickle Slices',       cost: 68.0, unit: 'Kg',   packSize: 2,  packDescription: 'Case',   stock: 6,  expiresInDays: 120, group: 'Produce' },
  { code: 'ING-036', description: 'Jalapeño Slices',          cost: 74.0, unit: 'Kg',   packSize: 2,  packDescription: 'Case',   stock: 4,  expiresInDays: 120, group: 'Produce' },
  { code: 'ING-037', description: 'Button Mushrooms',         cost: 78.0, unit: 'Kg',   packSize: 2,  packDescription: 'Crate', stock: 5,  expiresInDays: 5,  group: 'Produce' },
  { code: 'ING-038', description: 'Avocado',                  cost: 11.5, unit: 'Each', packSize: 20, packDescription: 'Tray',  stock: 40, expiresInDays: 5,  group: 'Produce' },
  { code: 'ING-039', description: 'Fresh Rocket',             cost: 95.0, unit: 'Kg',   packSize: 1,  packDescription: 'Bag',   stock: 2,  expiresInDays: 4,  group: 'Produce' },

  // ── Sauces & condiments ────────────────────────────────────────────────
  { code: 'ING-050', description: 'Burger Sauce (House)',     cost: 48.0, unit: 'L',  packSize: 5, packDescription: 'Case',    stock: 10, expiresInDays: 14, group: 'Sauces' },
  { code: 'ING-051', description: 'Tomato Sauce',             cost: 32.0, unit: 'L',  packSize: 5, packDescription: 'Case', stock: 15, expiresInDays: 180, group: 'Sauces' },
  { code: 'ING-052', description: 'Mayonnaise',               cost: 41.0, unit: 'L',  packSize: 5, packDescription: 'Case',    stock: 10, expiresInDays: 90, group: 'Sauces' },
  { code: 'ING-053', description: 'Mustard (American)',       cost: 38.0, unit: 'L',  packSize: 2, packDescription: 'Case', stock: 6,  expiresInDays: 180, group: 'Sauces' },
  { code: 'ING-054', description: 'BBQ Sauce',                cost: 44.0, unit: 'L',  packSize: 5, packDescription: 'Case', stock: 8,  expiresInDays: 180, group: 'Sauces' },
  { code: 'ING-055', description: 'Peri-Peri Sauce',          cost: 56.0, unit: 'L',  packSize: 2, packDescription: 'Case', stock: 5,  expiresInDays: 180, group: 'Sauces' },
  { code: 'ING-056', description: 'Truffle Oil',              cost: 320.0, unit: 'L', packSize: 1, packDescription: 'Case', stock: 1,  expiresInDays: 365, group: 'Sauces' },

  // ── Dry goods & kitchen ────────────────────────────────────────────────
  { code: 'ING-060', description: 'Sunflower Frying Oil',     cost: 38.0, unit: 'L',  packSize: 20, packDescription: 'Box',  stock: 60, expiresInDays: 365, group: 'Dry goods' },
  { code: 'ING-061', description: 'Cake Flour',               cost: 16.0, unit: 'Kg', packSize: 10, packDescription: 'Bag',  stock: 20, expiresInDays: 180, group: 'Dry goods' },
  { code: 'ING-062', description: 'Crumbing Mix',             cost: 34.0, unit: 'Kg', packSize: 5,  packDescription: 'Bag',  stock: 10, expiresInDays: 180, group: 'Dry goods' },
  { code: 'ING-063', description: 'Burger Seasoning Rub',     cost: 96.0, unit: 'Kg', packSize: 1,  packDescription: 'Case',  stock: 3,  expiresInDays: 365, group: 'Dry goods' },
  { code: 'ING-064', description: 'Table Salt',               cost: 9.5,  unit: 'Kg', packSize: 5,  packDescription: 'Bag',  stock: 10, expiresInDays: 365, group: 'Dry goods' },
  { code: 'ING-065', description: 'Black Pepper (Ground)',    cost: 185.0, unit: 'Kg', packSize: 1, packDescription: 'Case',  stock: 1,  expiresInDays: 365, group: 'Dry goods' },

  // ── Packaging ──────────────────────────────────────────────────────────
  //
  // Packaging is consumed per order exactly like food is, so it belongs on the
  // recipe of anything that leaves the counter in one. Kept here rather than in
  // its own department because it is bought, counted and deducted identically.
  { code: 'ING-070', description: 'Burger Clamshell Box',     cost: 2.4, unit: 'Each', packSize: 250, packDescription: 'Box', stock: 500, group: 'Packaging' },
  { code: 'ING-071', description: 'Fries Carton (Regular)',   cost: 1.3, unit: 'Each', packSize: 500, packDescription: 'Box', stock: 1000, group: 'Packaging' },
  { code: 'ING-072', description: 'Paper Takeaway Bag',       cost: 1.7, unit: 'Each', packSize: 250, packDescription: 'Box', stock: 500, group: 'Packaging' },
  { code: 'ING-073', description: 'Greaseproof Wrap Sheet',   cost: 0.35, unit: 'Each', packSize: 1000, packDescription: 'Box', stock: 2000, group: 'Packaging' },
]

/**
 * A nominal shelf price, so an ingredient is not a 100% margin line.
 *
 * These rows are never sold, so no real price exists to look up. A flat 40% over
 * cost, VAT added, is a placeholder that keeps valuation and GP reports sane —
 * and reads obviously as a placeholder if one ever surfaces on a screen.
 */
function nominalPrice(costExcl: number): number {
  return Math.round(costExcl * 1.4 * 1.15 * 100) / 100
}

async function lookupOrCreateDepartment(): Promise<number> {
  const found = await siteQueryOne<{ id: number }>(
    SITE,
    'SELECT id FROM departments WHERE code = ? LIMIT 1',
    [DEPARTMENT.code],
  )
  if (found) return Number(found.id)

  // Sorted after the menu departments — the till tabs stay in menu order and
  // the kitchen's own department sits at the end where it belongs.
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

async function lookupOrCreateBrand(): Promise<number> {
  const found = await siteQueryOne<{ id: number }>(
    SITE,
    'SELECT id FROM brands WHERE name = ? LIMIT 1',
    [BRAND],
  )
  if (found) return Number(found.id)

  console.log(`  brand "${BRAND}" is missing — creating it`)
  const res = await siteExecute(SITE, 'INSERT INTO brands (name) VALUES (?)', [BRAND])
  return Number(res.insertId)
}

async function wipe() {
  // Children first. product_prices and product_location_stock would cascade,
  // but stock_movements has no ON DELETE CASCADE and would block the delete.
  const target = `(SELECT id FROM (SELECT id FROM products WHERE code REGEXP '${CODE_PATTERN}') t)`
  for (const table of ['product_recipes', 'stock_movements', 'product_location_stock', 'product_prices']) {
    // product_recipes references these as COMPONENTS. If a recipe already uses
    // one, removing the row silently empties that recipe — so refuse instead.
    if (table === 'product_recipes') {
      const inUse = await siteQuery<{ n: number }>(
        SITE,
        `SELECT COUNT(*) AS n FROM product_recipes WHERE component_id IN ${target}`,
      )
      if (Number(inUse[0]?.n ?? 0) > 0) {
        console.error(
          `  ${inUse[0].n} recipe line(s) still use these ingredients. Remove those lines first — ` +
            'wiping would empty the recipes without saying so.',
        )
        process.exit(1)
      }
      continue
    }
    const res = await siteExecute(SITE, `DELETE FROM ${table} WHERE product_id IN ${target}`)
    if (res.affectedRows) console.log(`  ${table}: ${res.affectedRows} row(s) removed`)
  }
  const res = await siteExecute(SITE, `DELETE FROM products WHERE code REGEXP '${CODE_PATTERN}'`)
  console.log(`  products: ${res.affectedRows} row(s) removed`)
}

async function main() {
  console.log(`site ${SITE}`)

  if (WIPE) {
    console.log('Removing the seeded ingredients…')
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
  const brandId = await lookupOrCreateBrand()

  let created = 0
  let skipped = 0
  const failures: string[] = []

  for (const item of INGREDIENTS) {
    const result = await createProduct(SITE, {
      code: item.code,
      description: item.description,
      departmentId,
      brandId,
      lastCost: item.cost,
      openingStock: item.stock,
      prices: { [structureId]: nominalPrice(item.cost) },

      // Never rung up — see the header. An ingredient on the till is a mistake
      // waiting to be made, not a feature.
      visibleInPos: false,

      // A weighed or poured ingredient is used in fractions of its unit: a patty
      // is 0.150 Kg. A bun is not. Getting this wrong makes a correct recipe
      // line unsaveable, or lets a stock take record half a bun.
      allowFractions: item.unit !== 'Each',
      weightDescription: item.unit,
      packSize: item.packSize ?? 0,
      packDescription: item.packDescription ?? 'None',
      expiresInDays: item.expiresInDays ?? 0,

      // No discretion to give away: these are not sold, so a discount ceiling
      // above zero would only ever describe a mistake.
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

  const summary = await siteQuery<{ n: number; value: string }>(
    SITE,
    `SELECT COUNT(*) AS n, FORMAT(SUM(p.stock_on_hand * p.average_cost), 2) AS value
       FROM products p
      WHERE p.code REGEXP '${CODE_PATTERN}'`,
  )
  console.log(
    `\n  ${summary[0]?.n ?? 0} ingredients on file, stock at cost R ${summary[0]?.value ?? '0.00'}`,
  )

  // Explicit, like every script here: siteDb hands out pooled connections and
  // never closes them, so without this the process sits idle forever.
  process.exit(failures.length ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
