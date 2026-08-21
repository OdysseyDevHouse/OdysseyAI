/**
 * Odyssey Cafe — departments, products, suppliers and customers.
 *
 *   npx tsx --conditions=react-server --env-file=.env scripts/seed-odyssey-cafe-data.ts
 *
 * Run after seed-odyssey-cafe.mjs has provisioned the stores.
 *
 * ── EVERYTHING GOES THROUGH THE REAL FUNCTIONS ────────────────────────────
 *
 * createDepartment, createProduct, createSupplier, createCustomer — not INSERT
 * statements. Slower, and the point: a seed that writes rows directly produces
 * data the app has never validated, and the first thing it teaches you is that
 * your test data is wrong rather than that your code is. It also means the
 * master-code allocator, the price history and the audit trail all fire exactly
 * as they would for a person typing.
 *
 * ── WHERE THINGS LAND, AND WHY IT DIFFERS PER FILE ────────────────────────
 *
 * Departments and products are written to EVERY store. They are replicated
 * master data — sharing them means the same product code in each database, an
 * edit fanned out (015) — so each store genuinely holds its own rows.
 *
 * Customers and suppliers are written ONCE, to head office, because the whole
 * point of this group is that those two files are shared. Writing them per
 * store would produce twenty separate debtors books, which is what the sharing
 * work exists to avoid.
 *
 * Product prices differ per store on purpose: a Sea Point flat white costs more
 * than a Bloemfontein one. That is what makes a group price report worth
 * running, and what would expose a cross-store price bug.
 */
import { query } from '../src/lib/db'
import { siteQuery, siteQueryOne } from '../src/lib/siteDb'
import { createDepartment } from '../src/lib/site/departments'
import { createProduct } from '../src/lib/site/products'
import { createSupplier } from '../src/lib/site/suppliers'
import { createCustomer } from '../src/lib/site/customers'
import type { Actor } from '../src/lib/site/activityLog'
import type { RowDataPacket } from 'mysql2/promise'

const actor: Actor = { userId: 1, userName: 'Odyssey Cafe seed' }

/* ── The menu ─────────────────────────────────────────────────────────────
 *
 * Roughly 300 products across a cafe's real shape: what a barista makes, what
 * a kitchen plates, what sits in a fridge, and what is sold as retail.
 */

const DEPARTMENTS = [
  'Espresso Bar',
  'Filter & Brew',
  'Cold Drinks',
  'Smoothies & Juice',
  'Tea',
  'Breakfast',
  'Sandwiches & Toasties',
  'Salads & Bowls',
  'Burgers & Mains',
  'Bakery',
  'Cakes & Desserts',
  'Retail Coffee',
  'Retail Sundries',
  'Kitchen Supplies',
] as const

type Item = { name: string; dept: string; price: number; cost: number }

/** Builds the catalogue. Named variants rather than a loop of "Product 47". */
function catalogue(): Item[] {
  const items: Item[] = []
  const add = (dept: string, name: string, price: number, cost: number) =>
    items.push({ dept, name, price, cost })

  /* Espresso bar — the same drink in three sizes is three products, which is
     how a till actually sells them. */
  const espresso = [
    ['Espresso', 22], ['Double Espresso', 28], ['Macchiato', 26], ['Cortado', 30],
    ['Flat White', 36], ['Cappuccino', 34], ['Latte', 36], ['Mocha', 42],
    ['Americano', 30], ['Red Cappuccino', 36], ['Chai Latte', 38], ['Hot Chocolate', 38],
    ['Dirty Chai', 44], ['Babyccino', 18],
  ] as const
  for (const [name, base] of espresso) {
    add('Espresso Bar', `${name} (Small)`, base, base * 0.32)
    add('Espresso Bar', `${name} (Regular)`, base + 6, (base + 6) * 0.32)
    add('Espresso Bar', `${name} (Large)`, base + 12, (base + 12) * 0.32)
  }

  const filter = [
    ['Filter Coffee', 28], ['Pour Over — Ethiopia', 48], ['Pour Over — Colombia', 46],
    ['Pour Over — Brazil', 44], ['AeroPress', 42], ['French Press (2 cup)', 52],
    ['Cold Brew', 40], ['Nitro Cold Brew', 52], ['Batch Brew', 26],
  ] as const
  for (const [name, price] of filter) add('Filter & Brew', name, price, price * 0.3)

  const cold = [
    ['Coca-Cola 330ml', 22], ['Coke Zero 330ml', 22], ['Fanta Orange 330ml', 22],
    ['Sprite 330ml', 22], ['Still Water 500ml', 18], ['Sparkling Water 500ml', 20],
    ['Appletiser 330ml', 28], ['Grapetiser 330ml', 28], ['Iced Tea Peach', 26],
    ['Iced Tea Lemon', 26], ['Iced Coffee', 38], ['Iced Latte', 40],
    ['Ginger Beer', 26], ['Tonic Water 200ml', 20], ['Soda Water 200ml', 18],
    ['Cranberry Juice 330ml', 30], ['Orange Juice 330ml', 30],
  ] as const
  for (const [name, price] of cold) add('Cold Drinks', name, price, price * 0.45)

  const smoothies = [
    ['Berry Blast Smoothie', 52], ['Mango Sunrise Smoothie', 52], ['Green Machine Smoothie', 56],
    ['Peanut Butter Banana Smoothie', 58], ['Tropical Smoothie', 52], ['Protein Shake', 62],
    ['Fresh Orange Juice', 42], ['Fresh Apple Juice', 42], ['Carrot & Ginger Juice', 46],
    ['Beetroot Detox Juice', 48], ['Watermelon Cooler', 44],
  ] as const
  for (const [name, price] of smoothies) add('Smoothies & Juice', name, price, price * 0.35)

  const tea = [
    ['English Breakfast', 26], ['Earl Grey', 26], ['Rooibos', 26], ['Green Tea', 28],
    ['Peppermint', 28], ['Chamomile', 28], ['Jasmine', 30], ['Lemon & Ginger', 30],
    ['Masala Chai', 34], ['Matcha Latte', 46], ['Turmeric Latte', 44],
  ] as const
  for (const [name, price] of tea) add('Tea', name, price, price * 0.22)

  const breakfast = [
    ['Full English Breakfast', 129], ['Vegetarian Breakfast', 115], ['Eggs Benedict', 108],
    ['Eggs Florentine', 105], ['Shakshuka', 98], ['Avo on Sourdough', 88],
    ['Avo & Feta on Rye', 95], ['Scrambled Eggs on Toast', 72], ['Omelette (3 egg)', 86],
    ['Bacon & Egg Roll', 68], ['Breakfast Wrap', 82], ['French Toast', 92],
    ['Buttermilk Pancakes', 88], ['Granola & Yoghurt', 68], ['Overnight Oats', 62],
    ['Bircher Muesli', 66], ['Croissant & Jam', 48], ['Boerewors & Egg Roll', 78],
  ] as const
  for (const [name, price] of breakfast) add('Breakfast', name, price, price * 0.33)

  const sandwiches = [
    ['Chicken Mayo Sandwich', 78], ['Tuna Mayo Sandwich', 82], ['Ham & Cheese Toastie', 68],
    ['Cheese & Tomato Toastie', 58], ['Chicken Mayo Toastie', 76], ['Bacon Brie & Fig', 96],
    ['Club Sandwich', 108], ['Steak Sandwich', 128], ['Falafel Wrap', 86],
    ['Chicken Caesar Wrap', 92], ['Halloumi Wrap', 88], ['Pulled Pork Roll', 98],
    ['Roast Veg Panini', 82], ['Caprese Panini', 84], ['Reuben', 112],
  ] as const
  for (const [name, price] of sandwiches) add('Sandwiches & Toasties', name, price, price * 0.34)

  const salads = [
    ['Greek Salad', 92], ['Caesar Salad', 96], ['Chicken Caesar Salad', 118],
    ['Quinoa & Roast Veg Bowl', 108], ['Poke Bowl — Salmon', 145], ['Poke Bowl — Chicken', 128],
    ['Buddha Bowl', 112], ['Beetroot & Feta Salad', 94], ['Nicoise Salad', 118],
    ['Superfood Salad', 106], ['Side Salad', 42],
  ] as const
  for (const [name, price] of salads) add('Salads & Bowls', name, price, price * 0.36)

  const mains = [
    ['Cafe Burger', 118], ['Cheese Burger', 128], ['Bacon & Cheese Burger', 142],
    ['Mushroom Swiss Burger', 138], ['Chicken Burger', 124], ['Veggie Burger', 112],
    ['Halloumi Burger', 118], ['Fish & Chips', 148], ['Chicken Schnitzel', 138],
    ['Beef Lasagne', 132], ['Chicken Curry & Rice', 128], ['Bobotie', 124],
    ['Butter Chicken', 136], ['Pasta Alfredo', 118], ['Pasta Arrabbiata', 108],
    ['Steak & Chips 200g', 189], ['Grilled Chicken Salad Plate', 126],
    ['Kids Chicken Strips', 68], ['Kids Burger', 72], ['Kids Pasta', 62],
    ['Side Chips', 42], ['Side Onion Rings', 46], ['Side Veg', 44],
  ] as const
  for (const [name, price] of mains) add('Burgers & Mains', name, price, price * 0.38)

  const bakery = [
    ['Butter Croissant', 34], ['Almond Croissant', 42], ['Pain au Chocolat', 40],
    ['Cinnamon Swirl', 38], ['Danish — Apple', 38], ['Danish — Custard', 38],
    ['Sourdough Loaf', 58], ['Ciabatta', 42], ['Rye Loaf', 62], ['Seed Loaf', 64],
    ['Bagel — Plain', 28], ['Bagel — Sesame', 30], ['Scone (plain)', 26],
    ['Scone (cheese)', 32], ['Muffin — Blueberry', 36], ['Muffin — Chocolate', 36],
    ['Muffin — Bran', 32], ['Rusks (pack)', 48], ['Koeksister', 22],
  ] as const
  for (const [name, price] of bakery) add('Bakery', name, price, price * 0.3)

  const cakes = [
    ['Carrot Cake', 58], ['Red Velvet Slice', 58], ['Chocolate Fudge Cake', 62],
    ['Cheesecake — Baked', 62], ['Cheesecake — Berry', 64], ['Lemon Meringue', 56],
    ['Malva Pudding', 52], ['Milk Tart Slice', 48], ['Brownie', 42],
    ['Blondie', 42], ['Chocolate Chip Cookie', 26], ['Macaron (each)', 22],
    ['Tiramisu', 66], ['Banoffee Pie', 62], ['Ice Cream (2 scoop)', 44],
    ['Affogato', 52], ['Waffle & Ice Cream', 78],
  ] as const
  for (const [name, price] of cakes) add('Cakes & Desserts', name, price, price * 0.31)

  const retail = [
    ['House Blend Beans 250g', 145], ['House Blend Beans 1kg', 480],
    ['Single Origin — Ethiopia 250g', 185], ['Single Origin — Colombia 250g', 175],
    ['Single Origin — Brazil 250g', 165], ['Decaf Beans 250g', 155],
    ['Ground Filter 250g', 138], ['Espresso Ground 250g', 142],
    ['Cold Brew Concentrate 500ml', 128], ['Gift Pack — Taster', 320],
    ['Gift Pack — Barista', 620],
  ] as const
  for (const [name, price] of retail) add('Retail Coffee', name, price, price * 0.55)

  const sundries = [
    ['Keep Cup 8oz', 189], ['Keep Cup 12oz', 219], ['Travel Flask', 289],
    ['Odyssey Cafe Mug', 129], ['Tote Bag', 149], ['Cafetiere 350ml', 349],
    ['AeroPress', 649], ['V60 Dripper', 289], ['V60 Filters (100)', 89],
    ['Milk Frother', 249], ['Coffee Scoop', 59], ['Cleaning Tablets', 119],
  ] as const
  for (const [name, price] of sundries) add('Retail Sundries', name, price, price * 0.6)

  /* Kitchen supplies are bought, never sold — a cafe's consumables. Priced at
     zero so nothing offers them at a till, which is what a real shop does with
     a non-selling stock item. */
  const supplies = [
    'Takeaway Cup 8oz (50)', 'Takeaway Cup 12oz (50)', 'Cup Lid 8oz (50)', 'Cup Lid 12oz (50)',
    'Napkins (500)', 'Paper Straws (250)', 'Takeaway Box — Small (50)', 'Takeaway Box — Large (50)',
    'Cutlery Pack (100)', 'Cling Film', 'Foil Roll', 'Dishwasher Tablets (60)',
    'Hand Soap 5L', 'Sanitiser 5L', 'Bin Liners (100)', 'Blue Roll',
    'Milk Jug 600ml', 'Portafilter Brush', 'Group Head Cleaner', 'Descaler 1L',
  ]
  for (const name of supplies) add('Kitchen Supplies', name, 0, 45)

  /* Extras and modifiers. A cafe sells a great many of these and they are real
     products with real prices — a shot of syrup rings up on the till like
     anything else, and leaving them out is what makes a seeded catalogue feel
     thinner than a working one. */
  const extras = [
    ['Extra Shot', 8], ['Decaf Shot', 8], ['Vanilla Syrup', 6], ['Caramel Syrup', 6],
    ['Hazelnut Syrup', 6], ['Cinnamon Syrup', 6], ['Almond Milk', 8], ['Oat Milk', 8],
    ['Soy Milk', 8], ['Coconut Milk', 8], ['Lactose Free Milk', 8], ['Cream', 6],
    ['Marshmallows', 8], ['Whipped Cream', 10], ['Honey', 6], ['Extra Cheese', 14],
    ['Extra Bacon', 24], ['Extra Avo', 22], ['Extra Egg', 14], ['Extra Halloumi', 26],
    ['Gluten Free Bread', 16], ['Side Sauce — Aioli', 12], ['Side Sauce — Peri Peri', 12],
    ['Side Sauce — BBQ', 12], ['Side Sauce — Mustard', 10],
  ] as const
  for (const [name, price] of extras) add('Espresso Bar', name, price, price * 0.28)

  /* A seasonal range, which is how a cafe menu actually grows — and useful for
     testing an archived / date-bounded product later. */
  const seasonal = [
    ['Pumpkin Spice Latte', 46], ['Peppermint Mocha', 46], ['Gingerbread Latte', 46],
    ['Eggnog Latte', 48], ['Iced Watermelon Latte', 44], ['Summer Berry Cooler', 46],
    ['Hot Cross Bun', 28], ['Mince Pie', 32], ['Easter Egg Brownie', 44],
    ['Festive Gift Box', 385], ['Winter Soup of the Day', 78], ['Winter Bread Bowl', 96],
  ] as const
  for (const [name, price] of seasonal) add('Cakes & Desserts', name, price, price * 0.32)

  const moreRetail = [
    ['Odyssey Cafe T-Shirt', 289], ['Odyssey Cafe Cap', 219], ['Coffee Subscription — 3 month', 1290],
    ['Coffee Subscription — 6 month', 2390], ['Barista Course Voucher', 950],
    ['Gift Card R100', 100], ['Gift Card R250', 250], ['Gift Card R500', 500],
    ['Espresso Cups (set of 4)', 349], ['Latte Glasses (set of 2)', 259],
    ['Coffee Grinder — Hand', 689], ['Digital Scale', 449], ['Milk Thermometer', 129],
    ['Tamper 58mm', 389], ['Knock Box', 329],
  ] as const
  for (const [name, price] of moreRetail) add('Retail Sundries', name, price, price * 0.58)

  return items
}

const SUPPLIERS = [
  ['Bean There Coffee Roasters', 'roasting@beanthere.co.za', 30],
  ['Cape Dairy Distributors', 'orders@capedairy.co.za', 30],
  ['Artisan Bakery Supply', 'sales@artisanbakery.co.za', 14],
  ['Fresh Produce Direct', 'orders@freshproduce.co.za', 7],
  ['Butchery Wholesale SA', 'accounts@butcherywholesale.co.za', 30],
  ['Coca-Cola Beverages SA', 'trade@ccbsa.co.za', 30],
  ['Packaging Plus', 'sales@packagingplus.co.za', 45],
  ['CleanCo Hygiene', 'orders@cleanco.co.za', 30],
  ['Tea Merchants of Africa', 'hello@teamerchants.co.za', 30],
  ['Barista Equipment Co', 'sales@baristaequip.co.za', 60],
  ['Nut & Seed Traders', 'orders@nutseed.co.za', 21],
  ['Frozen Foods Wholesale', 'sales@frozenfoods.co.za', 30],
] as const

/** Account customers — a cafe's corporate and standing-order trade. */
const CUSTOMERS = [
  ['Kingsley Attorneys', 30, 15000], ['Meridian Architects', 30, 12000],
  ['Coastal Medical Practice', 30, 8000], ['Blue Sky Media', 14, 20000],
  ['Harbour View Guest House', 30, 25000], ['Summit Accounting', 30, 10000],
  ['Riverside Primary School', 60, 18000], ['TechBridge Solutions', 30, 30000],
  ['Anderson & Wolfe Legal', 30, 14000], ['The Design Loft', 14, 9000],
  ['Cape Property Group', 30, 22000], ['Northgate Dental', 30, 7500],
  ['Pinnacle Insurance Brokers', 30, 16000], ['Greenfield Landscaping', 14, 6000],
  ['Vantage Recruitment', 30, 11000], ['Oceanic Freight', 45, 35000],
  ['Lighthouse Veterinary', 30, 8500], ['Summit Fitness Studio', 14, 5500],
  ['Bright Start Preschool', 30, 9500], ['Metro Courier Services', 30, 13000],
  ['Sterling Financial Advisors', 30, 17000], ['Willow Creek Estate', 60, 28000],
  ['Apex Engineering', 30, 24000], ['Harbourside Hotel', 45, 40000],
  ['Cornerstone Church', 30, 6500],
] as const

type Row = RowDataPacket & Record<string, unknown>

async function main() {
  const sites = await query<RowDataPacket & { id: number; site_code: string; trading_name: string }>(
    "SELECT id, site_code, trading_name FROM cp2_sites WHERE site_code LIKE 'ODY-CAFE-%' ORDER BY id",
  )
  if (!sites.length) {
    console.log('No Odyssey Cafe sites. Run seed-odyssey-cafe.mjs first.')
    process.exit(1)
  }

  const headOffice = Number(sites[0].id)
  const items = catalogue()
  console.log(`\n${sites.length} stores, ${items.length} products, ${SUPPLIERS.length} suppliers, ${CUSTOMERS.length} customers.\n`)

  /* ── Suppliers and customers: head office only ──────────────────────────
   *
   * They are the shared files. One debtors book and one creditors book for the
   * group is the whole point — writing them per store would produce twenty
   * separate ones and make every sharing test meaningless.
   */

  console.log('Head office — suppliers and customers…')

  // Both files are unique on code, so a re-run must skip rather than fail.
  const haveSuppliers = new Set(
    (await siteQuery<Row>(headOffice, 'SELECT code FROM suppliers')).map((r) => String(r.code)),
  )
  const haveCustomers = new Set(
    (await siteQuery<Row>(headOffice, 'SELECT code FROM customers')).map((r) => String(r.code)),
  )

  for (const [i, [name, email, terms]] of SUPPLIERS.entries()) {
    if (haveSuppliers.has(`SUP${String(i + 1).padStart(3, '0')}`)) continue
    const res = await createSupplier(headOffice, actor, {
      code: `SUP${String(i + 1).padStart(3, '0')}`,
      name,
      email,
      phone: '021' + String(5500000 + i),
      paymentTermsDays: terms,
      category: 'Trade',
      status: 'active',
    })
    if (!res.ok) console.log(`  ! ${name}: ${res.error}`)
  }
  console.log(`  ${SUPPLIERS.length} suppliers`)

  for (const [i, [name, terms, limit]] of CUSTOMERS.entries()) {
    if (haveCustomers.has(`ACC${String(i + 1).padStart(3, '0')}`)) continue
    const res = await createCustomer(headOffice, actor, {
      code: `ACC${String(i + 1).padStart(3, '0')}`,
      name,
      email: `accounts@${name.toLowerCase().replace(/[^a-z]+/g, '')}.co.za`,
      phone: '021' + String(6600000 + i),
      paymentTermsDays: terms,
      creditLimit: limit,
      status: 'active',
    })
    if (!res.ok) console.log(`  ! ${name}: ${res.error}`)
  }
  console.log(`  ${CUSTOMERS.length} customers`)

  /* ── Departments and products: every store ──────────────────────────────
   *
   * Replicated master data — the same code in each database. Prices vary by
   * store so a group price report has something to compare.
   */

  for (const [n, site] of sites.entries()) {
    const siteId = Number(site.id)
    const label = String(site.trading_name ?? site.site_code)

    // Metro stores charge more. Crude on purpose: a flat percentage per store
    // is enough to make a variance visible without inventing a pricing model.
    const uplift = 1 + (n % 5) * 0.04

    /*
     * ── IDS MUST DIVERGE BETWEEN STORES, OR THE FIXTURE PROVES NOTHING ────
     *
     * Seeded identically, every store ends up with "Bakery" as department 10
     * and CAF0001 as product 1 — measured, on the first run of this script.
     * That makes the whole cross-store id-collision class INVISIBLE: a bug
     * that reads store 7's department id against store 3's table gets the
     * right answer by accident, which is exactly what
     * docs/cross-store-id-conflicts.md warns about when it says "two stores
     * can agree by accident where ten cannot".
     *
     * So each store's auto-increments are pushed apart before anything is
     * written. Store n starts its departments at n*7 and its products at
     * n*13+100 — coprime strides, so no two stores line up on either table.
     * Now a cross-store id bug produces a wrong row rather than a right one.
     *
     * Only on a store with nothing in it yet: raising AUTO_INCREMENT on a
     * populated table would be a change to real data rather than to a fixture.
     */
    const empty = await siteQueryOne<Row>(
      siteId,
      'SELECT (SELECT COUNT(*) FROM departments) AS d, (SELECT COUNT(*) FROM products) AS p',
    )
    if (Number(empty?.d) === 0 && Number(empty?.p) === 0) {
      await siteQuery(siteId, `ALTER TABLE departments AUTO_INCREMENT = ${(n + 1) * 7}`)
      await siteQuery(siteId, `ALTER TABLE products AUTO_INCREMENT = ${(n + 1) * 13 + 100}`)
    }

    /*
     * Re-runnable, because a catalogue grows. createDepartment and
     * createProduct both refuse a duplicate — a name and a code are unique —
     * so a second run would otherwise report a screen of failures and add
     * nothing. Existing rows are read first and only the gap is written.
     */
    const deptIds = new Map<string, number>()
    for (const d of await siteQuery<Row>(siteId, 'SELECT id, name FROM departments')) {
      deptIds.set(String(d.name), Number(d.id))
    }
    for (const [i, name] of DEPARTMENTS.entries()) {
      if (deptIds.has(name)) continue
      const res = await createDepartment(siteId, { name, sortOrder: i * 10 })
      if (res.ok) deptIds.set(name, res.id)
    }

    const haveCodes = new Set(
      (await siteQuery<Row>(siteId, 'SELECT code FROM products')).map((p) => String(p.code)),
    )

    const structure = await siteQueryOne<Row>(
      siteId,
      'SELECT id FROM price_structures WHERE is_default = 1 ORDER BY position LIMIT 1',
    )
    const structureId = structure ? Number(structure.id) : null

    let made = 0
    let failed = 0
    let skipped = 0
    for (const [i, item] of items.entries()) {
      const code = `CAF${String(i + 1).padStart(4, '0')}`
      if (haveCodes.has(code)) {
        skipped++
        continue
      }
      const price = item.price === 0 ? 0 : Math.round(item.price * uplift)
      const res = await createProduct(siteId, {
        code,
        description: item.name,
        departmentId: deptIds.get(item.dept) ?? null,
        lastCost: Number(item.cost.toFixed(2)),
        averageCost: Number(item.cost.toFixed(2)),
        // Kitchen supplies are bought, not sold.
        visibleInPos: item.price > 0,
        ...(structureId && price > 0 ? { prices: { [structureId]: price } } : {}),
      })
      if (res.ok) made++
      else {
        failed++
        if (failed <= 2) console.log(`  ! ${item.name}: ${res.error}`)
      }
    }

    console.log(
      `  ${String(n + 1).padStart(2)}. ${label.padEnd(30)} ${DEPARTMENTS.length} depts, ` +
        `+${made} products` +
        (skipped ? `, ${skipped} already there` : '') +
        (failed ? `, ${failed} FAILED` : ''),
    )
  }

  /* ── What was built ─────────────────────────────────────────────────────── */

  console.log('\n— Totals —')
  for (const site of [sites[0], sites[sites.length - 1]]) {
    const id = Number(site.id)
    const counts = await siteQueryOne<Row>(
      id,
      `SELECT (SELECT COUNT(*) FROM products)    AS products,
              (SELECT COUNT(*) FROM departments) AS departments,
              (SELECT COUNT(*) FROM suppliers)   AS suppliers,
              (SELECT COUNT(*) FROM customers)   AS customers`,
    )
    console.log(
      `  ${String(site.trading_name ?? site.site_code).padEnd(30)} ` +
        `${counts?.products} products, ${counts?.departments} departments, ` +
        `${counts?.suppliers} suppliers, ${counts?.customers} customers`,
    )
  }

  console.log(
    '\nSuppliers and customers are at head office only — switch sharing on in\n' +
      'Setup → Linked stores so the other nineteen can see them.\n',
  )
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
