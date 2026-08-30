/**
 * Recipe burgers for the demo database, and the ingredients they consume.
 *
 *   npm run seed:recipe-burgers        # create them
 *   npm run seed:recipe-burgers:wipe   # remove them again
 *
 * ── WHAT THIS MAKES ──────────────────────────────────────────────────────
 *
 * Two layers, because a recipe is meaningless without the other half:
 *
 *   RBI-*  the ingredients. Mince, buns, lettuce, tomato, sauces. Bought,
 *          counted and deducted — never rung up, so visibleInPos is false and
 *          they sit in their own department away from the menu tabs.
 *
 *   RB-*   the burgers. product_type 'recipe', so they carry NO stock of their
 *          own: selling one moves its components and nothing else. That is the
 *          whole point of the type, and it is why openingStock is never set on
 *          one here.
 *
 * The existing 3008-3015 burgers on this site are plain 'normal' products and
 * are deliberately left alone — converting a type under live stock is a
 * decision for whoever owns that data, not for a seed script.
 *
 * ── WHY IT GOES THROUGH createProduct / saveRecipe ───────────────────────
 *
 * Not INSERT statements. createProduct writes the product, its prices, its
 * opening pile in product_location_stock AND the `opening` stock movement that
 * accounts for that pile, in one transaction. saveRecipe validates the lines
 * and then re-resolves the tree to catch a cycle. Raw SQL is how you end up
 * with stock no movement explains, which reconcileStock() exists to catch.
 *
 * ── THE SWEEP ────────────────────────────────────────────────────────────
 *
 * --wipe matches an ANCHORED, digit-counted pattern so it can only ever remove
 * rows this file made. An unanchored 'RB%' would take a real product the first
 * time somebody coded one that way.
 */
import { createProduct, setDerivedCost } from '../src/lib/site/products'
import { saveRecipe, compositionCost } from '../src/lib/site/productComposition'
import { siteQuery, siteQueryOne, siteExecute } from '../src/lib/siteDb'

/** The Odyssey Demo Database is site 53. Override with a bare number argument. */
const SITE = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 53)
const WIPE = process.argv.includes('--wipe')

/** Anchored and digit-counted — see the sweep note above. */
const INGREDIENT_PATTERN = '^RBI-[0-9]{3}$'
const BURGER_PATTERN = '^RB-[0-9]{3}$'

/**
 * The ingredients get their OWN department. An ingredient filed under "Burgers"
 * would appear on the till's burger tab beside the burgers, which is the one
 * place it must never be.
 */
const INGREDIENT_DEPARTMENT = { name: 'Burger Ingredients', code: 'RBI', color: '#4d7c0f' }

/** The burgers join the menu department that already exists on this site. */
const BURGER_DEPARTMENT_CODE = '32.2'

const BRAND = 'Kitchen Supply'

type Unit = 'Kg' | 'g' | 'L' | 'ml' | 'Each'

type Ingredient = {
  code: string
  description: string
  /** EXCLUSIVE of VAT, per ONE `unit`. */
  cost: number
  unit: Unit
  packSize?: number
  packDescription?: string
  /** Opening pile, in `unit`. */
  stock: number
  expiresInDays?: number
}

/*
 * Costs are mid-2026 South African wholesale, rounded to something a buyer
 * would recognise rather than looked up — they are meant to be edited.
 * Everything is per single unit: R 118.00 for Kg means per kilogram, not
 * per box.
 */
const INGREDIENTS: Ingredient[] = [
  // ── Proteins ─────────────────────────────────────────────────────────
  { code: 'RBI-001', description: 'Beef Mince (80/20 Chuck)',  cost: 118.0, unit: 'Kg',   packSize: 5,  packDescription: 'Bag',  stock: 30,  expiresInDays: 4 },
  { code: 'RBI-002', description: 'Chicken Breast Fillet',     cost: 92.0,  unit: 'Kg',   packSize: 5,  packDescription: 'Bag',  stock: 20,  expiresInDays: 3 },
  { code: 'RBI-003', description: 'Lamb Mince',                cost: 168.0, unit: 'Kg',   packSize: 3,  packDescription: 'Bag',  stock: 8,   expiresInDays: 4 },
  { code: 'RBI-004', description: 'Streaky Bacon Rashers',     cost: 135.0, unit: 'Kg',   packSize: 2,  packDescription: 'Pack', stock: 10,  expiresInDays: 10 },
  { code: 'RBI-005', description: 'Plant-Based Patty 110g',    cost: 18.5,  unit: 'Each', packSize: 24, packDescription: 'Box',  stock: 72,  expiresInDays: 60 },
  { code: 'RBI-006', description: 'Boerewors Patty 120g',      cost: 14.2,  unit: 'Each', packSize: 30, packDescription: 'Box',  stock: 60,  expiresInDays: 7 },

  // ── Bakery ───────────────────────────────────────────────────────────
  { code: 'RBI-010', description: 'Brioche Burger Bun',        cost: 4.8,  unit: 'Each', packSize: 60, packDescription: 'Bag', stock: 300, expiresInDays: 4 },
  { code: 'RBI-011', description: 'Sesame Seed Bun',           cost: 3.6,  unit: 'Each', packSize: 60, packDescription: 'Bag', stock: 240, expiresInDays: 4 },
  { code: 'RBI-012', description: 'Pretzel Bun',               cost: 6.2,  unit: 'Each', packSize: 40, packDescription: 'Bag', stock: 120, expiresInDays: 4 },

  // ── Dairy ────────────────────────────────────────────────────────────
  { code: 'RBI-020', description: 'Cheddar Cheese Slice',      cost: 1.85,  unit: 'Each', packSize: 84, packDescription: 'Box',  stock: 500, expiresInDays: 45 },
  { code: 'RBI-021', description: 'Blue Cheese Crumble',       cost: 189.0, unit: 'Kg',   packSize: 1,  packDescription: 'Pack', stock: 2,   expiresInDays: 30 },
  { code: 'RBI-022', description: 'Feta Cheese',               cost: 132.0, unit: 'Kg',   packSize: 1,  packDescription: 'Pack', stock: 3,   expiresInDays: 30 },
  { code: 'RBI-023', description: 'Butter (Unsalted)',         cost: 145.0, unit: 'Kg',   packSize: 1,  packDescription: 'Pack', stock: 5,   expiresInDays: 60 },
  { code: 'RBI-024', description: 'Free Range Egg',            cost: 2.75,  unit: 'Each', packSize: 30, packDescription: 'Tray', stock: 180, expiresInDays: 21 },

  // ── Produce ──────────────────────────────────────────────────────────
  { code: 'RBI-030', description: 'Tomatoes',                  cost: 24.0, unit: 'Kg',   packSize: 5,  packDescription: 'Crate', stock: 15, expiresInDays: 6 },
  { code: 'RBI-031', description: 'Iceberg Lettuce',           cost: 18.5, unit: 'Kg',   packSize: 5,  packDescription: 'Crate', stock: 12, expiresInDays: 5 },
  { code: 'RBI-032', description: 'Red Onions',                cost: 16.0, unit: 'Kg',   packSize: 10, packDescription: 'Bag',   stock: 25, expiresInDays: 21 },
  { code: 'RBI-033', description: 'Cucumber',                  cost: 21.0, unit: 'Kg',   packSize: 5,  packDescription: 'Crate', stock: 10, expiresInDays: 7 },
  { code: 'RBI-034', description: 'Dill Pickle Slices',        cost: 68.0, unit: 'Kg',   packSize: 2,  packDescription: 'Case',  stock: 6,  expiresInDays: 120 },
  { code: 'RBI-035', description: 'Jalapeno Slices',           cost: 74.0, unit: 'Kg',   packSize: 2,  packDescription: 'Case',  stock: 4,  expiresInDays: 120 },
  { code: 'RBI-036', description: 'Button Mushrooms',          cost: 78.0, unit: 'Kg',   packSize: 2,  packDescription: 'Crate', stock: 6,  expiresInDays: 5 },
  { code: 'RBI-037', description: 'Avocado',                   cost: 11.5, unit: 'Each', packSize: 20, packDescription: 'Tray',  stock: 60, expiresInDays: 5 },
  { code: 'RBI-038', description: 'Fresh Rocket',              cost: 95.0, unit: 'Kg',   packSize: 1,  packDescription: 'Bag',   stock: 3,  expiresInDays: 4 },
  { code: 'RBI-039', description: 'Baby Spinach',              cost: 88.0, unit: 'Kg',   packSize: 1,  packDescription: 'Bag',   stock: 3,  expiresInDays: 4 },

  // ── Sauces & condiments ──────────────────────────────────────────────
  { code: 'RBI-050', description: 'Burger Sauce (House)',      cost: 48.0, unit: 'L', packSize: 5, packDescription: 'Case', stock: 12, expiresInDays: 14 },
  { code: 'RBI-051', description: 'Tomato Sauce',              cost: 32.0, unit: 'L', packSize: 5, packDescription: 'Case', stock: 18, expiresInDays: 180 },
  { code: 'RBI-052', description: 'Mayonnaise',                cost: 41.0, unit: 'L', packSize: 5, packDescription: 'Case', stock: 12, expiresInDays: 90 },
  { code: 'RBI-053', description: 'Mustard (American)',        cost: 38.0, unit: 'L', packSize: 2, packDescription: 'Case', stock: 6,  expiresInDays: 180 },
  { code: 'RBI-054', description: 'BBQ Sauce',                 cost: 44.0, unit: 'L', packSize: 5, packDescription: 'Case', stock: 10, expiresInDays: 180 },
  { code: 'RBI-055', description: 'Peri-Peri Sauce',           cost: 56.0, unit: 'L', packSize: 2, packDescription: 'Case', stock: 6,  expiresInDays: 180 },
  { code: 'RBI-056', description: 'Garlic Aioli',              cost: 62.0, unit: 'L', packSize: 2, packDescription: 'Case', stock: 5,  expiresInDays: 30 },
  { code: 'RBI-057', description: 'Sweet Chilli Sauce',        cost: 39.0, unit: 'L', packSize: 5, packDescription: 'Case', stock: 8,  expiresInDays: 180 },
  { code: 'RBI-058', description: 'Caramelised Onion Relish',  cost: 78.0, unit: 'L', packSize: 2, packDescription: 'Case', stock: 4,  expiresInDays: 60 },

  // ── Dry goods & kitchen ──────────────────────────────────────────────
  { code: 'RBI-060', description: 'Sunflower Frying Oil',      cost: 38.0, unit: 'L',    packSize: 20,  packDescription: 'Box',  stock: 60,  expiresInDays: 365 },
  { code: 'RBI-061', description: 'Crumbing Mix',              cost: 34.0, unit: 'Kg',   packSize: 5,   packDescription: 'Bag',  stock: 12,  expiresInDays: 180 },
  { code: 'RBI-062', description: 'Burger Seasoning Rub',      cost: 96.0, unit: 'Kg',   packSize: 1,   packDescription: 'Case', stock: 3,   expiresInDays: 365 },
  { code: 'RBI-063', description: 'Onion Ring (Battered)',     cost: 1.6,  unit: 'Each', packSize: 100, packDescription: 'Bag',  stock: 300, expiresInDays: 120 },

  // ── Packaging ────────────────────────────────────────────────────────
  //
  // Packaging is consumed per order exactly like food is, so it belongs on the
  // recipe of anything that leaves the counter in one. A recipe that ignores it
  // under-costs the item and never reorders the boxes.
  { code: 'RBI-070', description: 'Burger Clamshell Box',      cost: 2.4,  unit: 'Each', packSize: 250,  packDescription: 'Box', stock: 600 },
  { code: 'RBI-071', description: 'Greaseproof Wrap Sheet',    cost: 0.35, unit: 'Each', packSize: 1000, packDescription: 'Box', stock: 2000 },
]

type RecipeLine = {
  /** An ingredient code above. */
  code: string
  /** Per ONE burger, in the ingredient's own unit. */
  qty: number
  /**
   * Wastage as a percentage ON TOP of qty. Trimming loses some of the cut, and
   * a kitchen that ignores it drifts short on every stock take. Zero on
   * anything portioned out of a pack — a bun is a bun.
   */
  wastagePct?: number
}

type Burger = {
  code: string
  description: string
  /** Selling price INCLUSIVE of VAT, on the default price structure. */
  price: number
  lines: RecipeLine[]
}

/*
 * Fifteen burgers. Quantities are what a kitchen would actually portion:
 * a 150g patty is 0.150 Kg of mince, a bun is 1 Each, and sauce is stocked by
 * the litre so 20ml is 0.020.
 */
const BURGERS: Burger[] = [
  {
    code: 'RB-001',
    description: 'Classic Beef Burger',
    price: 89.0,
    lines: [
      { code: 'RBI-001', qty: 0.15, wastagePct: 5 },
      { code: 'RBI-011', qty: 1 },
      { code: 'RBI-031', qty: 0.02, wastagePct: 15 },
      { code: 'RBI-030', qty: 0.03, wastagePct: 10 },
      { code: 'RBI-032', qty: 0.015, wastagePct: 12 },
      { code: 'RBI-050', qty: 0.02 },
      { code: 'RBI-062', qty: 0.003 },
      { code: 'RBI-070', qty: 1 },
      { code: 'RBI-071', qty: 1 },
    ],
  },
  {
    code: 'RB-002',
    description: 'Cheese Burger',
    price: 99.0,
    lines: [
      { code: 'RBI-001', qty: 0.15, wastagePct: 5 },
      { code: 'RBI-011', qty: 1 },
      { code: 'RBI-020', qty: 1 },
      { code: 'RBI-031', qty: 0.02, wastagePct: 15 },
      { code: 'RBI-030', qty: 0.03, wastagePct: 10 },
      { code: 'RBI-034', qty: 0.015 },
      { code: 'RBI-050', qty: 0.02 },
      { code: 'RBI-062', qty: 0.003 },
      { code: 'RBI-070', qty: 1 },
      { code: 'RBI-071', qty: 1 },
    ],
  },
  {
    code: 'RB-003',
    description: 'Bacon & Cheese Burger',
    price: 115.0,
    lines: [
      { code: 'RBI-001', qty: 0.15, wastagePct: 5 },
      { code: 'RBI-010', qty: 1 },
      { code: 'RBI-004', qty: 0.04, wastagePct: 8 },
      { code: 'RBI-020', qty: 1 },
      { code: 'RBI-031', qty: 0.02, wastagePct: 15 },
      { code: 'RBI-030', qty: 0.03, wastagePct: 10 },
      { code: 'RBI-050', qty: 0.02 },
      { code: 'RBI-062', qty: 0.003 },
      { code: 'RBI-070', qty: 1 },
      { code: 'RBI-071', qty: 1 },
    ],
  },
  {
    code: 'RB-004',
    description: 'Double Beef Burger',
    price: 135.0,
    lines: [
      // Two patties. qty is per ONE burger, so this is 0.300 Kg of mince and
      // selling three of them deducts 0.900 Kg.
      { code: 'RBI-001', qty: 0.3, wastagePct: 5 },
      { code: 'RBI-010', qty: 1 },
      { code: 'RBI-020', qty: 2 },
      { code: 'RBI-031', qty: 0.02, wastagePct: 15 },
      { code: 'RBI-030', qty: 0.03, wastagePct: 10 },
      { code: 'RBI-032', qty: 0.015, wastagePct: 12 },
      { code: 'RBI-050', qty: 0.03 },
      { code: 'RBI-062', qty: 0.005 },
      { code: 'RBI-070', qty: 1 },
      { code: 'RBI-071', qty: 1 },
    ],
  },
  {
    code: 'RB-005',
    description: 'Bacon & Blue Cheese Burger',
    price: 129.0,
    lines: [
      { code: 'RBI-001', qty: 0.15, wastagePct: 5 },
      { code: 'RBI-012', qty: 1 },
      { code: 'RBI-004', qty: 0.04, wastagePct: 8 },
      { code: 'RBI-021', qty: 0.03 },
      { code: 'RBI-038', qty: 0.015, wastagePct: 20 },
      { code: 'RBI-058', qty: 0.02 },
      { code: 'RBI-062', qty: 0.003 },
      { code: 'RBI-070', qty: 1 },
      { code: 'RBI-071', qty: 1 },
    ],
  },
  {
    code: 'RB-006',
    description: 'Mushroom & Cheese Burger',
    price: 119.0,
    lines: [
      { code: 'RBI-001', qty: 0.15, wastagePct: 5 },
      { code: 'RBI-010', qty: 1 },
      { code: 'RBI-036', qty: 0.05, wastagePct: 10 },
      { code: 'RBI-020', qty: 1 },
      { code: 'RBI-023', qty: 0.01 },
      { code: 'RBI-052', qty: 0.02 },
      { code: 'RBI-062', qty: 0.003 },
      { code: 'RBI-070', qty: 1 },
      { code: 'RBI-071', qty: 1 },
    ],
  },
  {
    code: 'RB-007',
    description: 'Peri-Peri Chicken Burger',
    price: 105.0,
    lines: [
      { code: 'RBI-002', qty: 0.16, wastagePct: 6 },
      { code: 'RBI-011', qty: 1 },
      { code: 'RBI-055', qty: 0.025 },
      { code: 'RBI-031', qty: 0.02, wastagePct: 15 },
      { code: 'RBI-030', qty: 0.03, wastagePct: 10 },
      { code: 'RBI-052', qty: 0.015 },
      { code: 'RBI-070', qty: 1 },
      { code: 'RBI-071', qty: 1 },
    ],
  },
  {
    code: 'RB-008',
    description: 'Crispy Chicken Burger',
    price: 109.0,
    lines: [
      { code: 'RBI-002', qty: 0.16, wastagePct: 6 },
      { code: 'RBI-061', qty: 0.04, wastagePct: 20 },
      { code: 'RBI-024', qty: 1 },
      { code: 'RBI-060', qty: 0.03 },
      { code: 'RBI-011', qty: 1 },
      { code: 'RBI-031', qty: 0.02, wastagePct: 15 },
      { code: 'RBI-052', qty: 0.02 },
      { code: 'RBI-070', qty: 1 },
      { code: 'RBI-071', qty: 1 },
    ],
  },
  {
    code: 'RB-009',
    description: 'Sweet Chilli Chicken Burger',
    price: 112.0,
    lines: [
      { code: 'RBI-002', qty: 0.16, wastagePct: 6 },
      { code: 'RBI-061', qty: 0.04, wastagePct: 20 },
      { code: 'RBI-060', qty: 0.03 },
      { code: 'RBI-010', qty: 1 },
      { code: 'RBI-057', qty: 0.025 },
      { code: 'RBI-039', qty: 0.015, wastagePct: 20 },
      { code: 'RBI-033', qty: 0.02, wastagePct: 10 },
      { code: 'RBI-070', qty: 1 },
      { code: 'RBI-071', qty: 1 },
    ],
  },
  {
    code: 'RB-010',
    description: 'Lamb & Feta Burger',
    price: 139.0,
    lines: [
      { code: 'RBI-003', qty: 0.16, wastagePct: 5 },
      { code: 'RBI-010', qty: 1 },
      { code: 'RBI-022', qty: 0.03 },
      { code: 'RBI-039', qty: 0.015, wastagePct: 20 },
      { code: 'RBI-032', qty: 0.015, wastagePct: 12 },
      { code: 'RBI-056', qty: 0.02 },
      { code: 'RBI-062', qty: 0.003 },
      { code: 'RBI-070', qty: 1 },
      { code: 'RBI-071', qty: 1 },
    ],
  },
  {
    code: 'RB-011',
    description: 'Boerewors Burger',
    price: 99.0,
    lines: [
      { code: 'RBI-006', qty: 1 },
      { code: 'RBI-011', qty: 1 },
      { code: 'RBI-058', qty: 0.025 },
      { code: 'RBI-030', qty: 0.03, wastagePct: 10 },
      { code: 'RBI-051', qty: 0.02 },
      { code: 'RBI-053', qty: 0.01 },
      { code: 'RBI-070', qty: 1 },
      { code: 'RBI-071', qty: 1 },
    ],
  },
  {
    code: 'RB-012',
    description: 'Veggie Burger',
    price: 95.0,
    lines: [
      { code: 'RBI-005', qty: 1 },
      { code: 'RBI-011', qty: 1 },
      { code: 'RBI-031', qty: 0.02, wastagePct: 15 },
      { code: 'RBI-030', qty: 0.03, wastagePct: 10 },
      { code: 'RBI-033', qty: 0.02, wastagePct: 10 },
      { code: 'RBI-032', qty: 0.015, wastagePct: 12 },
      { code: 'RBI-056', qty: 0.02 },
      { code: 'RBI-070', qty: 1 },
      { code: 'RBI-071', qty: 1 },
    ],
  },
  {
    code: 'RB-013',
    description: 'Avo & Bacon Burger',
    price: 125.0,
    lines: [
      { code: 'RBI-001', qty: 0.15, wastagePct: 5 },
      { code: 'RBI-010', qty: 1 },
      { code: 'RBI-004', qty: 0.04, wastagePct: 8 },
      // Half an avocado, and a quarter of it goes in the bin as stone and skin.
      { code: 'RBI-037', qty: 0.5, wastagePct: 25 },
      { code: 'RBI-031', qty: 0.02, wastagePct: 15 },
      { code: 'RBI-052', qty: 0.02 },
      { code: 'RBI-062', qty: 0.003 },
      { code: 'RBI-070', qty: 1 },
      { code: 'RBI-071', qty: 1 },
    ],
  },
  {
    code: 'RB-014',
    description: 'Jalapeno BBQ Burger',
    price: 119.0,
    lines: [
      { code: 'RBI-001', qty: 0.15, wastagePct: 5 },
      { code: 'RBI-012', qty: 1 },
      { code: 'RBI-020', qty: 1 },
      { code: 'RBI-035', qty: 0.02 },
      { code: 'RBI-063', qty: 2 },
      { code: 'RBI-054', qty: 0.03 },
      { code: 'RBI-062', qty: 0.003 },
      { code: 'RBI-070', qty: 1 },
      { code: 'RBI-071', qty: 1 },
    ],
  },
  {
    code: 'RB-015',
    description: 'The Big Stack Burger',
    price: 165.0,
    lines: [
      // Three patties, three slices and bacon. The dearest line on the board,
      // and the one where wastage actually shows up in the GP.
      { code: 'RBI-001', qty: 0.45, wastagePct: 5 },
      { code: 'RBI-012', qty: 1 },
      { code: 'RBI-020', qty: 3 },
      { code: 'RBI-004', qty: 0.05, wastagePct: 8 },
      { code: 'RBI-034', qty: 0.02 },
      { code: 'RBI-032', qty: 0.02, wastagePct: 12 },
      { code: 'RBI-031', qty: 0.02, wastagePct: 15 },
      { code: 'RBI-050', qty: 0.04 },
      { code: 'RBI-062', qty: 0.006 },
      { code: 'RBI-070', qty: 1 },
      { code: 'RBI-071', qty: 1 },
    ],
  },
]

/**
 * A nominal shelf price for an ingredient, so it is not a 100% margin line.
 *
 * These rows are never sold, so no real price exists to look up. A flat 40%
 * over cost, VAT added, is a placeholder that keeps stock valuation and GP
 * reports sane — and reads obviously as a placeholder if one ever surfaces.
 */
function nominalPrice(costExcl: number): number {
  return Math.round(costExcl * 1.4 * 1.15 * 100) / 100
}

async function lookupOrCreateIngredientDepartment(): Promise<number> {
  const found = await siteQueryOne<{ id: number }>(
    SITE,
    'SELECT id FROM departments WHERE code = ? LIMIT 1',
    [INGREDIENT_DEPARTMENT.code],
  )
  if (found) return Number(found.id)

  // Top level and sorted last: the kitchen's raw goods are not a menu tab, and
  // slotting them in among the menu departments would reorder the till.
  const last = await siteQueryOne<{ n: number }>(
    SITE,
    'SELECT COALESCE(MAX(sort_order), 0) AS n FROM departments WHERE parent_id IS NULL',
  )
  console.log(`  department ${INGREDIENT_DEPARTMENT.code} is missing — creating it`)
  const res = await siteExecute(
    SITE,
    'INSERT INTO departments (name, code, color, sort_order, parent_id) VALUES (?,?,?,?,NULL)',
    [
      INGREDIENT_DEPARTMENT.name,
      INGREDIENT_DEPARTMENT.code,
      INGREDIENT_DEPARTMENT.color,
      Number(last?.n ?? 0) + 1,
    ],
  )
  return Number(res.insertId)
}

async function lookupBurgerDepartment(): Promise<number> {
  const found = await siteQueryOne<{ id: number }>(
    SITE,
    'SELECT id FROM departments WHERE code = ? LIMIT 1',
    [BURGER_DEPARTMENT_CODE],
  )
  if (!found) {
    throw new Error(
      `No department with code ${BURGER_DEPARTMENT_CODE} on site ${SITE}. The burgers need a ` +
        'menu department to live in — create one, or point this at a site that has it.',
    )
  }
  return Number(found.id)
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
  const mine = `(SELECT id FROM (SELECT id FROM products
                   WHERE code REGEXP '${BURGER_PATTERN}' OR code REGEXP '${INGREDIENT_PATTERN}') t)`

  // Recipe lines first, and BOTH ends of them: a burger is a parent, an
  // ingredient is a component, and fk_recipe_component is RESTRICT so the
  // product delete below fails while any line still points at one.
  const lines = await siteExecute(
    SITE,
    `DELETE FROM product_recipes WHERE parent_id IN ${mine} OR component_id IN ${mine}`,
  )
  if (lines.affectedRows) console.log(`  product_recipes: ${lines.affectedRows} row(s) removed`)

  // Anything left pointing at these ingredients is a recipe somebody built
  // outside this seed. Removing the ingredient would empty it without saying
  // so, so refuse instead.
  const foreign = await siteQueryOne<{ n: number }>(
    SITE,
    `SELECT COUNT(*) AS n FROM product_recipes WHERE component_id IN ${mine}`,
  )
  if (Number(foreign?.n ?? 0) > 0) {
    console.error(
      `  ${foreign?.n} recipe line(s) outside this seed still use these ingredients. ` +
        'Remove those lines first — wiping would empty those recipes without saying so.',
    )
    process.exit(1)
  }

  // stock_movements has no ON DELETE CASCADE and would block the product
  // delete. product_prices and product_location_stock would cascade, but
  // clearing them explicitly keeps the counts in the log honest.
  for (const table of ['stock_movements', 'product_location_stock', 'product_prices']) {
    const res = await siteExecute(SITE, `DELETE FROM ${table} WHERE product_id IN ${mine}`)
    if (res.affectedRows) console.log(`  ${table}: ${res.affectedRows} row(s) removed`)
  }

  const res = await siteExecute(
    SITE,
    `DELETE FROM products WHERE code REGEXP '${BURGER_PATTERN}' OR code REGEXP '${INGREDIENT_PATTERN}'`,
  )
  console.log(`  products: ${res.affectedRows} row(s) removed`)
}

async function main() {
  console.log(`site ${SITE}`)

  if (WIPE) {
    console.log('Removing the seeded burgers and ingredients…')
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

  const ingredientDept = await lookupOrCreateIngredientDepartment()
  const burgerDept = await lookupBurgerDepartment()
  const brandId = await lookupOrCreateBrand()

  const failures: string[] = []

  /* ── The ingredients ──────────────────────────────────────────────── */
  let madeIngredients = 0
  let keptIngredients = 0

  for (const item of INGREDIENTS) {
    const result = await createProduct(SITE, {
      code: item.code,
      description: item.description,
      departmentId: ingredientDept,
      brandId,
      lastCost: item.cost,
      openingStock: item.stock,
      prices: { [structureId]: nominalPrice(item.cost) },

      // Never rung up — an ingredient on the till is a mistake waiting to be
      // made, not a feature.
      visibleInPos: false,

      // A weighed or poured ingredient is consumed in fractions of its unit: a
      // patty is 0.150 Kg. A bun is not. Getting this wrong makes a correct
      // recipe line unsaveable, or lets a stock take record half a bun.
      allowFractions: item.unit !== 'Each',
      weightDescription: item.unit,
      packSize: item.packSize ?? 0,
      packDescription: item.packDescription ?? 'None',
      expiresInDays: item.expiresInDays ?? 0,

      // Not sold, so a discount ceiling above zero would only ever describe a
      // mistake.
      maxDiscountPct: 0,
    })

    if (result.ok) madeIngredients++
    else if (result.error.includes('already in use')) keptIngredients++
    else failures.push(`${item.code}: ${result.error}`)
  }

  console.log(`\ningredients: ${madeIngredients} created, ${keptIngredients} already present`)

  /* ── The burgers ──────────────────────────────────────────────────── */
  //
  // Ingredient ids are read back by code AFTER the loop above, so a recipe line
  // can never point at an id this run failed to create.
  const idByCode = new Map<string, number>()
  const rows = await siteQuery<{ id: number; code: string }>(
    SITE,
    `SELECT id, code FROM products WHERE code REGEXP '${INGREDIENT_PATTERN}'`,
  )
  for (const r of rows) idByCode.set(String(r.code), Number(r.id))

  let madeBurgers = 0
  let keptBurgers = 0
  let recipesWritten = 0
  let recosted = 0

  for (const burger of BURGERS) {
    // No cost is passed: a recipe product's cost is DERIVED from its components
    // by compositionCost(). A typed figure would be a second, competing answer
    // that goes stale the first time an ingredient's cost moves.
    const result = await createProduct(SITE, {
      code: burger.code,
      description: burger.description,
      departmentId: burgerDept,
      productType: 'recipe',
      prices: { [structureId]: burger.price },
      visibleInPos: true,

      // A recipe product carries NO stock of its own — selling one moves its
      // components. An opening pile here would be a phantom the reconciliation
      // could never explain.
      openingStock: 0,

      // The heading this prints under on a kitchen docket.
      kitchenGroup: 'Burgers',
      prepTimeMinutes: 8,
    })

    let parentId: number
    if (result.ok) {
      parentId = result.id
      madeBurgers++
    } else if (result.error.includes('already in use')) {
      const existing = await siteQueryOne<{ id: number }>(
        SITE,
        'SELECT id FROM products WHERE code = ? LIMIT 1',
        [burger.code],
      )
      if (!existing) {
        failures.push(`${burger.code}: reported as taken but not found`)
        continue
      }
      parentId = Number(existing.id)
      keptBurgers++
    } else {
      failures.push(`${burger.code}: ${result.error}`)
      continue
    }

    const missing = burger.lines.filter((l) => !idByCode.has(l.code))
    if (missing.length) {
      failures.push(`${burger.code}: unknown ingredient(s) ${missing.map((m) => m.code).join(', ')}`)
      continue
    }

    // saveRecipe replaces the whole list, so a re-run is idempotent rather than
    // additive.
    const saved = await saveRecipe(
      SITE,
      parentId,
      burger.lines.map((l) => ({
        componentId: idByCode.get(l.code)!,
        qty: l.qty,
        wastagePct: l.wastagePct ?? 0,
      })),
    )
    if (!saved.ok) {
      failures.push(`${burger.code} recipe: ${saved.error}`)
      continue
    }
    recipesWritten++

    /*
     * The derived cost, written the moment the lines exist.
     *
     * createProduct above deliberately passed no cost — a recipe's cost is the
     * sum of its ingredients and there were no ingredients yet. Without this
     * the burger keeps the 0.00 it was inserted with and reports a 100% margin
     * on every sale and every GP report, which is exactly the bug the
     * cost cascade exists to prevent.
     *
     * The same two functions the products form uses on save, in the same
     * order, so a seeded burger and a hand-made one hold the same figure.
     */
    const cost = await compositionCost(SITE, parentId, 'recipe').catch(() => null)
    if (cost !== null && cost > 0) {
      await setDerivedCost(SITE, parentId, cost)
      recosted++
    }
  }

  console.log(
    `burgers:     ${madeBurgers} created, ${keptBurgers} already present, ` +
      `${recipesWritten} recipe(s) written, ${recosted} costed from ingredients`,
  )

  if (failures.length) {
    console.log(`\n${failures.length} failure(s):`)
    for (const f of failures) console.log('  ' + f)
  }

  // Explicit, like every script here: siteDb hands out pooled connections and
  // never closes them, so without this the process sits idle forever.
  process.exit(failures.length ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
