// Seeds the "Smash Burger Joint" demo storefront into a site's own database.
//
//   node --env-file=.env scripts/tmp-seed-demo-store.mjs <siteId>
//
// Idempotent: every write is an upsert keyed on the product code, department
// name or stored image name, so re-running converges rather than duplicating.
// Photos must already be in uploads/ — run scripts/tmp-fetch-photos.mjs first.
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { siteConnection } from './connect.mjs'
import { DEPARTMENTS, BRANDS, PRODUCTS, STOREFRONT_IMAGES } from './catalogue.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const siteId = Number(process.argv[2])
if (!Number.isFinite(siteId) || siteId <= 0) {
  console.error('Usage: node --env-file=.env scripts/tmp-seed-demo-store.mjs <siteId>')
  process.exit(1)
}

const manifest = JSON.parse(await readFile(path.join(root, '.demo-seed', 'photo-manifest.json'), 'utf8'))
const db = await siteConnection(siteId)

const one = async (sql, args = []) => (await db.query(sql, args))[0][0] ?? null
const all = async (sql, args = []) => (await db.query(sql, args))[0]
const run = async (sql, args = []) => (await db.execute(sql, args))[0]

// ── Fixtures ───────────────────────────────────────────────────────────
const salesVat = await one(`SELECT id FROM vat_rates WHERE vat_type='sales' AND is_default=1 LIMIT 1`)
const purchVat = await one(`SELECT id FROM vat_rates WHERE vat_type='purchase' AND is_default=1 LIMIT 1`)
const priceStructure = await one(`SELECT id FROM price_structures WHERE is_default=1 LIMIT 1`)
const location = await one(`SELECT id FROM stock_locations WHERE is_active=1 ORDER BY is_main DESC, id LIMIT 1`)
if (!salesVat || !purchVat || !priceStructure || !location) {
  throw new Error('missing fixtures: need default sales/purchase VAT, a default price structure and an active location')
}
console.log(`fixtures: salesVat=${salesVat.id} purchVat=${purchVat.id} priceStructure=${priceStructure.id} location=${location.id}`)

// ── Departments ────────────────────────────────────────────────────────
// Flat, one level: products hang off these directly and each is shown online.
const deptIds = {}
for (const d of DEPARTMENTS) {
  const existing = await one(`SELECT id FROM departments WHERE name = ? LIMIT 1`, [d.name])
  if (existing) {
    await run(
      `UPDATE departments SET code=?, color=?, sort_order=?, is_active=1, show_online=1 WHERE id=?`,
      [d.code, d.color, d.sort, existing.id],
    )
    deptIds[d.key] = existing.id
  } else {
    const r = await run(
      `INSERT INTO departments (name, code, color, sort_order, is_active, show_online) VALUES (?,?,?,?,1,1)`,
      [d.name, d.code, d.color, d.sort],
    )
    deptIds[d.key] = r.insertId
  }
}
console.log(`departments: ${Object.keys(deptIds).length} shown online`)

// ── Brands ─────────────────────────────────────────────────────────────
const brandIds = {}
for (const name of BRANDS) {
  const r = await run(
    `INSERT INTO brands (name, is_active) VALUES (?,1)
       ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id), is_active = 1`,
    [name],
  )
  brandIds[name] = r.insertId
}
console.log(`brands: ${Object.keys(brandIds).length}`)

// ── Products, prices, stock and photos ─────────────────────────────────
let created = 0, updated = 0, imaged = 0, noPhoto = 0

for (const [code, description, deptKey, brand, priceIncl, costExcl, photoId, alt] of PRODUCTS) {
  const departmentId = deptIds[deptKey]
  const brandId = brandIds[brand] ?? null
  // Enough on hand to read as in stock; one line is deliberately low so the
  // "Only n left" badge has something to show.
  const stock = code === 'SB-110' ? 3 : 40

  const existing = await one(`SELECT id FROM products WHERE code = ? LIMIT 1`, [code])
  let productId
  if (existing) {
    productId = existing.id
    await run(
      `UPDATE products
          SET description=?, department_id=?, brand_id=?, product_type='normal',
              purchase_vat_rate_id=?, selling_vat_rate_id=?,
              last_cost=?, average_cost=?, stock_on_hand=?,
              is_archived=0, visible_in_pos=1, show_online=1
        WHERE id=?`,
      [description, departmentId, brandId, purchVat.id, salesVat.id, costExcl, costExcl, stock, productId],
    )
    updated++
  } else {
    const r = await run(
      `INSERT INTO products
         (code, description, department_id, brand_id, product_type,
          purchase_vat_rate_id, selling_vat_rate_id,
          last_cost, average_cost, stock_on_hand,
          is_archived, visible_in_pos, show_online)
       VALUES (?,?,?,?, 'normal', ?,?, ?,?,?, 0,1,1)`,
      [code, description, departmentId, brandId, purchVat.id, salesVat.id, costExcl, costExcl, stock],
    )
    productId = r.insertId
    created++
  }

  // Price INCLUSIVE of VAT, against the default structure the shop publishes.
  await run(
    `INSERT INTO product_prices (product_id, price_structure_id, selling_price_incl)
     VALUES (?,?,?)
       ON DUPLICATE KEY UPDATE selling_price_incl = VALUES(selling_price_incl)`,
    [productId, priceStructure.id, priceIncl.toFixed(4)],
  )

  // The per-location row the stock model expects to exist.
  await run(
    `INSERT INTO product_location_stock (product_id, location_id, stock_on_hand)
     VALUES (?,?,?)
       ON DUPLICATE KEY UPDATE stock_on_hand = VALUES(stock_on_hand)`,
    [productId, location.id, stock],
  )

  // Photo: one primary image per product, mirrored onto products.image_path
  // so the till button shows the same picture as the storefront.
  const entry = manifest[`${code}@900`]
  if (!entry) { noPhoto++; continue }

  // Scoped to THIS product: stored_name is globally unique, so a global check
  // would skip the insert whenever another product already used this photo and
  // leave this one with nothing.
  const already = await one(
    `SELECT id FROM product_images WHERE product_id = ? AND stored_name = ? LIMIT 1`,
    [productId, entry.storedName],
  )
  if (!already) {
    await run(
      `INSERT INTO product_images
         (product_id, stored_name, filename, mime_type, size_bytes, alt_text, sort_order, is_primary)
       VALUES (?,?,?,?,?,?,0,1)`,
      [productId, entry.storedName, `${code}.jpg`, entry.mimeType, entry.sizeBytes, alt.slice(0, 190)],
    )
    imaged++
  }
  // Drop any photo this product used to carry. Without this, re-pointing a
  // product at a different picture leaves the old row behind and the
  // is_primary update below finds nothing to promote — a product with images
  // but no primary, which renders as a lettermark.
  await run(`DELETE FROM product_images WHERE product_id = ? AND stored_name <> ?`, [productId, entry.storedName])
  // Exactly one primary, whatever re-runs did.
  await run(`UPDATE product_images SET is_primary = (stored_name = ?) WHERE product_id = ?`, [entry.storedName, productId])
  await run(`UPDATE products SET image_path = ? WHERE id = ?`, [entry.storedName, productId])
}
console.log(`products: ${created} created, ${updated} updated, ${imaged} photos linked${noPhoto ? `, ${noPhoto} without a photo` : ''}`)

// ── Retire products no longer in the catalogue ─────────────────────────
// Earlier runs seeded items whose stock photo turned out to show the wrong
// food. Archiving rather than deleting keeps any history that referenced them.
const keep = PRODUCTS.map((p) => p[0])
const [stale] = await db.query(
  `SELECT id, code FROM products
    WHERE code REGEXP '^(SB|HD|PZ|SD|DR|DS)-[0-9]+$' AND code NOT IN (?) AND is_archived = 0`,
  [keep],
)
for (const s of stale) {
  await run(`UPDATE products SET is_archived = 1, show_online = 0 WHERE id = ?`, [s.id])
}
if (stale.length) console.log(`retired: ${stale.map((s) => s.code).join(', ')}`)

// ── Storefront banner images ───────────────────────────────────────────
const shopImages = {}
for (const s of STOREFRONT_IMAGES) {
  const entry = manifest[`${s.photo}@1600`]
  if (!entry) continue
  const existing = await one(`SELECT id FROM storefront_images WHERE stored_name = ? LIMIT 1`, [entry.storedName])
  if (existing) {
    shopImages[s.key] = existing.id
  } else {
    const r = await run(
      `INSERT INTO storefront_images (stored_name, filename, mime_type, size_bytes, alt_text)
       VALUES (?,?,?,?,?)`,
      [entry.storedName, `${s.key}.jpg`, entry.mimeType, entry.sizeBytes, s.alt.slice(0, 190)],
    )
    shopImages[s.key] = r.insertId
  }
}
console.log(`storefront images: ${Object.keys(shopImages).length}`)

// ── Shop settings and theme ────────────────────────────────────────────
await run(
  `UPDATE online_store_settings
      SET is_enabled=1, collect_enabled=1, deliver_enabled=1,
          payment_mode='on_collection', publish_mode='departments',
          price_structure_id=?, lead_time_minutes=25, min_order_incl=0.0000,
          blurb=?, reviews_enabled=1, show_stock=1, show_photos=1, show_brands=1,
          brand_colour=?, product_layout='grid',
          hero_headline=?, hero_subtext=?,
          footer_about=?, footer_hours=?,
          social_facebook=?, social_instagram=?, social_whatsapp=?,
          updated_by='demo-seed'
    WHERE id = 1`,
  [
    priceStructure.id,
    'Smashed to order on a screaming hot flat-top. Order online, collect in 25 minutes.',
    '#c2410c',
    'Smash Burger Joint',
    'Smashed patties, gourmet dogs and wood-fired pizza — ready when you are.',
    'Smash Burger Joint has been smashing patties on a screaming hot flat-top since 2019. Everything is made to order: the beef is ground fresh daily, the buns are baked down the road, and the pizza comes out of a real wood-fired oven.',
    'Monday – Thursday: 11:00 – 21:00\nFriday – Saturday: 11:00 – 22:30\nSunday: 12:00 – 20:00',
    'https://facebook.com/smashburgerjoint',
    'https://instagram.com/smashburgerjoint',
    '+27821234567',
  ],
)

// ── Home page layout ───────────────────────────────────────────────────
// The eight products the shop leads with, in the order they should appear.
const FEATURED = ['SB-101', 'SB-102', 'PZ-302', 'SB-109', 'HD-202', 'PZ-305', 'SD-402', 'DR-509']
const [featuredRows] = await db.query(`SELECT id, code FROM products WHERE code IN (?)`, [FEATURED])
const byCode = new Map(featuredRows.map((r) => [r.code, r.id]))
const featuredIds = FEATURED.map((c) => byCode.get(c)).filter(Boolean)
if (featuredIds.length !== FEATURED.length) {
  console.warn(`warning: only ${featuredIds.length}/${FEATURED.length} featured products resolved`)
}

// Key order matches normaliseSections so the builder's dirty check sees a
// clean page rather than an immediate unsaved-changes state.
const section = (extra) => ({ title: '', enabled: true, tone: 'plain', showFrom: '', showUntil: '', ...extra })
const layout = [
  section({ id: 'hero', kind: 'hero' }),
  section({
    id: 'banner-signature', kind: 'banner', title: 'The signature smash',
    imageId: shopImages.hero ?? null,
    imageAlt: 'Smash burger and fries on a board',
    linkUrl: '/store', bodyText: 'Two smashed patties, house sauce, pickles. The one everyone comes back for.',
    buttonLabel: 'Order now',
  }),
  section({ id: 'departments', kind: 'categories', title: 'Shop the menu', maxItems: 0 }),
  section({
    // Curated, not 'newest': newest orders by id, so it surfaced whatever was
    // seeded last (desserts and milkshakes) on a page selling burgers.
    id: 'popular', kind: 'products', title: 'Most popular',
    source: 'manual', departmentId: null, productIds: featuredIds, maxItems: 8, layout: 'grid',
  }),
  section({
    id: 'cards', kind: 'cards', tone: 'tinted',
    cards: [
      { icon: '🔥', heading: 'Smashed to order', text: 'Never pre-cooked. Every patty hits the flat-top when you order it.' },
      { icon: '⏱️', heading: 'Ready in 25 minutes', text: 'Order online and collect — we start cooking when you check out.' },
      { icon: '🚚', heading: 'We deliver', text: 'Delivery across the neighbourhood, free on orders over R350.' },
    ],
  }),
  section({
    id: 'banner-pizza', kind: 'banner', title: 'Wood-fired, properly',
    imageId: shopImages.pizza ?? null,
    imageAlt: 'Wood-fired pizza fresh from the oven',
    linkUrl: '/store', bodyText: '90 seconds at 400°C. Leopard-spotted crust, San Marzano base.',
    buttonLabel: 'See the pizzas',
  }),
  section({
    id: 'about', kind: 'text', title: 'Why we smash',
    text: 'Smashing a loose ball of beef onto a screaming hot flat-top does one thing nothing else can: it forces the whole surface of the patty into contact with the steel, and that is where the crust comes from. More crust, more flavour. It is a 30-second technique that we have spent years getting right.',
    align: 'center',
  }),
]

await run(`UPDATE online_store_settings SET home_layout = ?, home_layout_draft = NULL WHERE id = 1`, [JSON.stringify(layout)])
console.log(`home layout: ${layout.length} sections published`)

await db.end()
console.log('\nseed complete.')
