// Imports the ody27995_stockfile catalogue into an OdysseyAI site database.
//
//   node --env-file=.env scripts/tmp-migrate/02-import.mjs <siteId>
//
// The source is an Odyssey v1 stockfile: fixed Major/Sub1/Sub2 department
// columns, one product spread across three tables, and pictures held as blobs.
// The target is the OdysseyAI site schema: an arbitrary-depth department tree,
// one products row, and images as files on disk with a metadata row.
//
// ── WHAT MOVES, AND WHERE IT LANDS ────────────────────────────────────────
//
//   tbldepartments_major/_sub1/_sub2 -> departments, as a three-level tree
//   tblstockrecord + tblstockproperties -> products (one row, merged)
//   tblstockprices (Position 1..3)   -> price_structures + product_prices
//   tblstockproperties.Picture       -> uploads/<uuid>.png + product_images
//   tbldepartments_*.Picture         -> uploads/<uuid>.png + storefront_images,
//                                       pointed at by departments.pos_image_id
//
// ── THE TWO CONVERSIONS THAT ARE NOT OBVIOUS ──────────────────────────────
//
// Colours are VB/OLE integers, which are BGR and not RGB. A straight hex
// conversion produces a plausible-looking wrong colour that nobody would think
// to check, so oleToHex below does the byte swap explicitly.
//
// Sub1No/Sub2No of 0 means "no sub-department", not "sub-department zero". A
// product with MajorNo 42 and Sub1No 0 belongs on the major itself, so it is
// attached to the major's department row rather than dropped or given a
// phantom parent.
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { randomUUID, createDecipheriv, scryptSync } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import mysql from 'mysql2/promise'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const UPLOADS_ROOT = path.resolve(process.env.UPLOADS_DIR || path.join(root, 'uploads'))

const siteId = Number(process.argv[2])
if (!Number.isFinite(siteId) || siteId <= 0) {
  console.error('Usage: node --env-file=.env scripts/tmp-migrate/02-import.mjs <siteId>')
  process.exit(1)
}

const SOURCE_DB = 'ody27995_stockfile'

const DB = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
}

/* ── Where the site's data lives ─────────────────────────────────────────── */

const ENC_PREFIX = 'enc:v1:'
function decryptSecret(stored) {
  if (!stored) return ''
  if (!stored.startsWith(ENC_PREFIX)) return stored
  const [iv, tag, ct] = stored
    .slice(ENC_PREFIX.length)
    .split(':')
    .map((s) => Buffer.from(s, 'base64'))
  const key = scryptSync(process.env.ENCRYPTION_KEY, 'odyssey-secret-v1', 32)
  const d = createDecipheriv('aes-256-gcm', key, iv)
  d.setAuthTag(tag)
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8')
}

const control = await mysql.createConnection({ ...DB, database: process.env.DB_NAME })
const [[reg]] = await control.query(
  `SELECT server_host, server_port, database_name, db_username, db_password_enc
     FROM cp2_site_databases
    WHERE site_id = ? AND status = 'active' AND purpose = 'master' LIMIT 1`,
  [siteId],
)
await control.end()
if (!reg) {
  console.error(`Site ${siteId} has no active master database.`)
  process.exit(1)
}

const site = await mysql.createConnection({
  host: process.env.SITE_DB_HOST_OVERRIDE || reg.server_host,
  port: reg.server_port,
  user: reg.db_username,
  password: decryptSecret(reg.db_password_enc),
  database: reg.database_name,
})
const src = await mysql.createConnection({ ...DB, database: SOURCE_DB })

console.log(`Source: ${SOURCE_DB}   Target: ${reg.database_name} (site ${siteId})\n`)

/* ── Guard: this must run into an empty catalogue ────────────────────────── */

const [[have]] = await site.query('SELECT COUNT(*) n FROM products')
if (have.n > 0) {
  console.error(`Target already holds ${have.n} product(s). Refusing to import on top of them.`)
  process.exit(1)
}

/* ── Colour ──────────────────────────────────────────────────────────────── */

/**
 * A VB/OLE colour integer to #RRGGBB.
 *
 * OLE packs the bytes as 0x00BBGGRR — blue high, red low — which is the reverse
 * of the order hex notation reads in. Converting without the swap yields a
 * colour that looks entirely reasonable and is simply wrong, so the swap is
 * explicit rather than incidental.
 *
 * Values with the high bit set are system colours (0x80000000 upward) and name
 * a theme slot rather than a colour; they have no RGB to extract, so they come
 * back null and the caller falls back to the kit's own default.
 */
function oleToHex(raw) {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0 || n > 0xffffff) return null
  const r = n & 0xff
  const g = (n >> 8) & 0xff
  const b = (n >> 16) & 0xff
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')
}

/* ── Images ──────────────────────────────────────────────────────────────── */

await mkdir(UPLOADS_ROOT, { recursive: true })

/**
 * What the blob actually is, read from the bytes.
 *
 * Not assumed from the column: the serving routes send the type derived from
 * the content, so a row claiming PNG over JPEG bytes would render as a broken
 * image on the storefront. Anything unrecognised is skipped and counted, so a
 * hole in the catalogue shows up in the summary rather than silently.
 */
function sniffImage(buf) {
  if (!buf || buf.length < 12) return null
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { ext: '.png', mime: 'image/png' }
  }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { ext: '.jpg', mime: 'image/jpeg' }
  }
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { ext: '.gif', mime: 'image/gif' }
  }
  if (
    buf.slice(0, 4).toString('ascii') === 'RIFF' &&
    buf.slice(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { ext: '.webp', mime: 'image/webp' }
  }
  return null
}

let filesWritten = 0
let bytesWritten = 0
const skippedImages = []

/** Writes one blob to uploads/ under a generated name, as lib/uploads.ts does. */
async function storeBlob(buf, label) {
  const kind = sniffImage(buf)
  if (!kind) {
    skippedImages.push(label)
    return null
  }
  const storedName = `${randomUUID()}${kind.ext}`
  await writeFile(path.join(UPLOADS_ROOT, storedName), buf)
  filesWritten++
  bytesWritten += buf.length
  return { storedName, mime: kind.mime, size: buf.length }
}

/* ── Price structures ────────────────────────────────────────────────────── */
//
// The source carries three price positions. Position 1 already exists as
// 'Retail' from 001_products.sql; 2 and 3 are added rather than renaming what
// is there, so the default price structure stays the one the till reads.

const [srcPositions] = await src.query(
  'SELECT DISTINCT Position FROM tblstockprices ORDER BY Position',
)
const POSITION_NAMES = { 1: 'Retail', 2: 'Wholesale', 3: 'Online' }
const structureByPosition = new Map()
for (const { Position } of srcPositions) {
  const pos = Number(Position)
  const name = POSITION_NAMES[pos] || `Price ${pos}`
  const [[existing]] = await site.query(
    'SELECT id FROM price_structures WHERE position = ? LIMIT 1',
    [pos],
  )
  if (existing) {
    structureByPosition.set(pos, existing.id)
  } else {
    const [r] = await site.query(
      'INSERT INTO price_structures (position, name, is_default) VALUES (?, ?, 0)',
      [pos, name],
    )
    structureByPosition.set(pos, r.insertId)
  }
}
console.log(
  `Price structures: ${[...structureByPosition.entries()].map(([p, id]) => `${p}->${id}`).join(', ')}`,
)

/* ── Departments ─────────────────────────────────────────────────────────── */
//
// Three source tables become one tree. The map is keyed by the source's
// composite numbers so a product's (MajorNo, Sub1No, Sub2No) resolves without
// re-querying.

const deptId = new Map()
const deptImage = []

const [majors] = await src.query(
  `SELECT MajorNo, MajorDescription, Color, ButtonPosition, Picture
     FROM tbldepartments_major ORDER BY ButtonPosition, MajorNo`,
)
for (const m of majors) {
  const [r] = await site.query(
    `INSERT INTO departments (parent_id, name, code, color, sort_order, is_active)
     VALUES (NULL, ?, ?, ?, ?, 1)`,
    [m.MajorDescription, String(m.MajorNo), oleToHex(m.Color), Number(m.ButtonPosition) || 0],
  )
  deptId.set(`${m.MajorNo}`, r.insertId)
  if (m.Picture?.length) {
    deptImage.push({ id: r.insertId, blob: m.Picture, label: m.MajorDescription })
  }
}

const [subs1] = await src.query(
  `SELECT MajorNo, Sub1No, Sub1Description, Color, ButtonPosition, Picture
     FROM tbldepartments_sub1 ORDER BY MajorNo, ButtonPosition, Sub1No`,
)
for (const s of subs1) {
  const parent = deptId.get(`${s.MajorNo}`)
  if (!parent) {
    console.warn(`  sub1 ${s.MajorNo}.${s.Sub1No} "${s.Sub1Description}" has no major — skipped`)
    continue
  }
  const [r] = await site.query(
    `INSERT INTO departments (parent_id, name, code, color, sort_order, is_active)
     VALUES (?, ?, ?, ?, ?, 1)`,
    [
      parent,
      s.Sub1Description,
      `${s.MajorNo}.${s.Sub1No}`,
      oleToHex(s.Color),
      Number(s.ButtonPosition) || 0,
    ],
  )
  deptId.set(`${s.MajorNo}.${s.Sub1No}`, r.insertId)
  if (s.Picture?.length) {
    deptImage.push({ id: r.insertId, blob: s.Picture, label: s.Sub1Description })
  }
}

const [subs2] = await src.query(
  `SELECT MajorNo, Sub1No, Sub2No, Sub2Description, Color, ButtonPosition, Picture
     FROM tbldepartments_sub2 ORDER BY MajorNo, Sub1No, ButtonPosition, Sub2No`,
)
for (const s of subs2) {
  const parent = deptId.get(`${s.MajorNo}.${s.Sub1No}`)
  if (!parent) {
    console.warn(
      `  sub2 ${s.MajorNo}.${s.Sub1No}.${s.Sub2No} "${s.Sub2Description}" has no sub1 — skipped`,
    )
    continue
  }
  const [r] = await site.query(
    `INSERT INTO departments (parent_id, name, code, color, sort_order, is_active)
     VALUES (?, ?, ?, ?, ?, 1)`,
    [
      parent,
      s.Sub2Description,
      `${s.MajorNo}.${s.Sub1No}.${s.Sub2No}`,
      oleToHex(s.Color),
      Number(s.ButtonPosition) || 0,
    ],
  )
  deptId.set(`${s.MajorNo}.${s.Sub1No}.${s.Sub2No}`, r.insertId)
  if (s.Picture?.length) {
    deptImage.push({ id: r.insertId, blob: s.Picture, label: s.Sub2Description })
  }
}

console.log(
  `Departments: ${majors.length} major, ${subs1.length} sub, ${subs2.length} sub-sub -> ${deptId.size} rows`,
)

// Department pictures land in storefront_images, which is where 064 says a
// department picture is resolved from, and the id goes on pos_image_id.
for (const d of deptImage) {
  const stored = await storeBlob(d.blob, `department "${d.label}"`)
  if (!stored) continue
  const filename = `${d.label}${path.extname(stored.storedName)}`.replace(/[\\/:*?"<>|]/g, '-')
  const [r] = await site.query(
    `INSERT INTO storefront_images (stored_name, filename, mime_type, size_bytes, alt_text)
     VALUES (?, ?, ?, ?, ?)`,
    [stored.storedName, filename, stored.mime, stored.size, String(d.label).slice(0, 190)],
  )
  await site.query('UPDATE departments SET pos_image_id = ?, online_image_id = ? WHERE id = ?', [
    r.insertId,
    r.insertId,
    d.id,
  ])
}
console.log(`Department pictures: ${deptImage.length}`)

/* ── Brands ──────────────────────────────────────────────────────────────── */

const brandId = new Map()
const [brands] = await src.query('SELECT BrandID, Brand_Description FROM tblbrands ORDER BY BrandID')
for (const b of brands) {
  const name = String(b.Brand_Description || '').trim()
  if (!name) continue
  const [r] = await site.query('INSERT INTO brands (name, is_active) VALUES (?, 1)', [
    name.slice(0, 120),
  ])
  brandId.set(Number(b.BrandID), r.insertId)
}
console.log(`Brands: ${brandId.size}`)

/* ── Products ────────────────────────────────────────────────────────────── */

/**
 * v1 product type -> OdysseyAI product_type.
 *
 * The names differ and the sets are not the same size, so this is a lookup
 * rather than a lowercase-and-hope. Anything unrecognised falls back to
 * 'normal' — the type that behaves the way a plain stocked item does, which is
 * the safe wrong answer rather than one whose till behaviour would surprise.
 */
const PRODUCT_TYPE = {
  'normal product': 'normal',
  'service product': 'service',
  'refer product': 'refer',
  combined: 'recipe',
  'recipe product': 'recipe',
  'serial product': 'serial',
  'buy-out product': 'buyout',
  'buyout product': 'buyout',
  'returnable product': 'returnable',
  'calculate qty product': 'calcqty',
  'gift card': 'gift_card',
}

/**
 * The source's VAT ids and this schema's happen to line up 1:1 — both number
 * sales standard/zero as 1/2 and purchase standard/zero as 3/4. That is a
 * coincidence of seeding rather than a guarantee, so the ids are matched on
 * rate and type instead of copied across.
 */
const [srcVat] = await src.query('SELECT VatID, VatRate, Vat_Type FROM tblstock_vatrate')
const [tgtVat] = await site.query('SELECT id, vat_type, rate FROM vat_rates')
const vatMap = new Map()
for (const v of srcVat) {
  const type = String(v.Vat_Type || '').toLowerCase() === 'purchase' ? 'purchase' : 'sales'
  const match = tgtVat.find((t) => t.vat_type === type && Number(t.rate) === Number(v.VatRate))
  if (match) vatMap.set(Number(v.VatID), match.id)
}
const defaultSalesVat = tgtVat.find((t) => t.vat_type === 'sales' && Number(t.rate) === 15)?.id ?? null
const defaultPurchVat =
  tgtVat.find((t) => t.vat_type === 'purchase' && Number(t.rate) === 15)?.id ?? null

const [rows] = await src.query(`
  SELECT r.StockCode, r.StockBarCode, r.Description1, r.Description2, r.ItemComment,
         r.MajorNo, r.Sub1No, r.Sub2No, r.StockonHand, r.MinStock, r.Maxstock,
         r.MaximumDiscount, r.AvarageCostPrice, r.LastCostPrice, r.VatID, r.Vat_Purchase_ID,
         p.ProductType, p.ReferCode, p.ReferMethod, p.PackSize, p.PackDescription,
         p.PackWeight, p.PackWeightDescription, p.PriceCalculation,
         p.FixedScaleItem, p.POSScaleItem, p.FixedPriceOnScaleItem, p.ScaleExpireDays,
         p.FractionsAllowed, p.EnterNewDescription, p.MenuItem, p.SubTotalCharge,
         p.LabelItem, p.NonGPItem, p.PrepTime, p.ButtonColor, p.ButtonPosition,
         p.Discontinued, p.BrandID, p.eStore_Item, p.PriceEmbedded,
         p.LastSoldDate, p.LastPurchaseDate, p.LastAdjustedDate, p.LastStockTakeDate,
         p.LastEditDate, p.Created_Date
    FROM tblstockrecord r
    LEFT JOIN tblstockproperties p ON p.StockCode = r.StockCode
   ORDER BY r.StockCode
`)

const seenBarcodes = new Set()
const droppedBarcodes = []
const productId = new Map()
const referLinks = []
let noDept = 0

const [[mainLoc]] = await site.query('SELECT id FROM stock_locations WHERE is_main = 1 LIMIT 1')

for (const p of rows) {
  const code = String(p.StockCode).trim()

  // Sub1No/Sub2No of 0 means "no sub-department" — the product sits on the
  // level above rather than on a department that does not exist.
  const key =
    Number(p.Sub2No) > 0
      ? `${p.MajorNo}.${p.Sub1No}.${p.Sub2No}`
      : Number(p.Sub1No) > 0
        ? `${p.MajorNo}.${p.Sub1No}`
        : `${p.MajorNo}`
  const dept = deptId.get(key) ?? deptId.get(`${p.MajorNo}`) ?? null
  if (dept === null) noDept++

  // The barcode is UNIQUE-indexed here and was not in v1. A collision is a
  // data fault in the source, so the second one loses its barcode and is
  // named in the summary — rather than failing the whole import, or silently
  // giving two products the same scan.
  let barcode = String(p.StockBarCode || '').trim() || null
  if (barcode && seenBarcodes.has(barcode)) {
    droppedBarcodes.push(`${code} (${barcode})`)
    barcode = null
  }
  if (barcode) seenBarcodes.add(barcode)

  const type = PRODUCT_TYPE[String(p.ProductType || '').trim().toLowerCase()] || 'normal'

  // Two questions in v1 and two here, but not the same two: FixedScaleItem is
  // the counter scale and POSScaleItem the till's own, and either makes it a
  // scale item. LabelItem is the separate "prints a label" question.
  const scaleItem = Number(p.FixedScaleItem) || Number(p.POSScaleItem) ? 1 : 0

  const [r] = await site.query(
    `INSERT INTO products
       (code, barcode, description, extra_description, product_type,
        department_id, brand_id, image_color,
        purchase_vat_rate_id, selling_vat_rate_id,
        last_cost, average_cost, stock_on_hand, is_archived,
        visible_in_pos, pos_sort_order, change_description, allow_fractions,
        charge_pct_subtotal, non_gp_product, max_discount_pct, price_calc,
        variable_type, pack_weight, weight_description, pack_size, pack_description,
        prep_time_minutes, scale_item, label_scale_item, fixed_price_scale, expires_in_days,
        show_online,
        last_sold_date, last_purchase_date, last_adjust_date, last_stock_take_date,
        last_edit_date, created_at)
     VALUES (?,?,?,?,?, ?,?,?, ?,?, ?,?,?,?, ?,?,?,?, ?,?,?,?, ?,?,?,?,?, ?,?,?,?,?, ?, ?,?,?,?, ?,?)`,
    [
      code,
      barcode,
      String(p.Description1 || code).slice(0, 190),
      String(p.Description2 || '').trim() || String(p.ItemComment || '').trim() || null,
      type,
      dept,
      brandId.get(Number(p.BrandID)) ?? null,
      oleToHex(p.ButtonColor),
      vatMap.get(Number(p.Vat_Purchase_ID)) ?? defaultPurchVat,
      vatMap.get(Number(p.VatID)) ?? defaultSalesVat,
      Number(p.LastCostPrice) || 0,
      Number(p.AvarageCostPrice) || 0,
      Number(p.StockonHand) || 0,
      Number(p.Discontinued) ? 1 : 0,
      // MenuItem is v1's "show this on the till" flag.
      Number(p.MenuItem) ? 1 : 0,
      Number(p.ButtonPosition) || 0,
      Number(p.EnterNewDescription) ? 1 : 0,
      Number(p.FractionsAllowed) ? 1 : 0,
      Number(p.SubTotalCharge) ? 1 : 0,
      Number(p.NonGPItem) ? 1 : 0,
      Number(p.MaximumDiscount) || 0,
      // v1 stores only "Selling Price Fixed" or blank, and both mean the shelf
      // price is what survives a cost change. 'markup' has no source value.
      'selling',
      Number(p.PriceEmbedded) ? 'price' : 'none',
      Number(p.PackWeight) || 0,
      String(p.PackWeightDescription || '').trim().slice(0, 24) || 'Kg',
      Number(p.PackSize) || 0,
      String(p.PackDescription || '').trim().slice(0, 24) || 'None',
      Number(p.PrepTime) || 0,
      scaleItem,
      Number(p.LabelItem) ? 1 : 0,
      Number(p.FixedPriceOnScaleItem) ? 1 : 0,
      Number(p.ScaleExpireDays) || 0,
      Number(p.eStore_Item) ? 1 : 0,
      p.LastSoldDate || null,
      p.LastPurchaseDate || null,
      p.LastAdjustedDate || null,
      p.LastStockTakeDate || null,
      p.LastEditDate || null,
      p.Created_Date || new Date(),
    ],
  )
  productId.set(code, r.insertId)

  // Reorder levels are per LOCATION here, not on the product. Main only: the
  // source holds one shop's worth of levels, and inventing a figure for
  // transit would be a number nobody entered.
  if (mainLoc) {
    await site.query(
      `INSERT INTO product_location_stock (product_id, location_id, stock_on_hand, min_stock, max_stock)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE stock_on_hand = VALUES(stock_on_hand),
                               min_stock = VALUES(min_stock), max_stock = VALUES(max_stock)`,
      [
        r.insertId,
        mainLoc.id,
        Number(p.StockonHand) || 0,
        Number(p.MinStock) || 0,
        Number(p.Maxstock) || 0,
      ],
    )
  }

  if (type === 'refer' && String(p.ReferCode || '').trim()) {
    referLinks.push({
      code,
      target: String(p.ReferCode).trim(),
      factor: Number(p.PackSize) || 1,
      // 'Subtract Pack' is the method where the pack carries no pile of its
      // own — 103_refer_methods.sql calls that 'subtract'.
      method: String(p.ReferMethod || '').toLowerCase().includes('subtract')
        ? 'subtract'
        : 'normal',
    })
  }
}

console.log(`Products: ${productId.size}`)
if (noDept) console.log(`  ${noDept} could not be placed in a department`)
if (droppedBarcodes.length) {
  console.log(
    `  ${droppedBarcodes.length} duplicate barcode(s) cleared: ${droppedBarcodes.join(', ')}`,
  )
}

/* ── Prices ──────────────────────────────────────────────────────────────── */

const [prices] = await src.query('SELECT StockCode, Position, SellingPrice FROM tblstockprices')
let priceRows = 0
let orphanPrices = 0
for (const row of prices) {
  const pid = productId.get(String(row.StockCode).trim())
  const sid = structureByPosition.get(Number(row.Position))
  if (!pid || !sid) {
    orphanPrices++
    continue
  }
  await site.query(
    `INSERT INTO product_prices (product_id, price_structure_id, selling_price_incl)
     VALUES (?,?,?) ON DUPLICATE KEY UPDATE selling_price_incl = VALUES(selling_price_incl)`,
    [pid, sid, Number(row.SellingPrice) || 0],
  )
  priceRows++
}
console.log(
  `Prices: ${priceRows}${orphanPrices ? ` (${orphanPrices} for products not on file)` : ''}`,
)

/* ── Refer links ─────────────────────────────────────────────────────────── */

let refers = 0
const orphanRefers = []
for (const link of referLinks) {
  const pid = productId.get(link.code)
  const tid = productId.get(link.target)
  if (!pid || !tid || pid === tid) {
    if (pid !== tid) orphanRefers.push(`${link.code} -> ${link.target}`)
    continue
  }
  await site.query(
    `INSERT INTO product_refers (product_id, target_id, factor, method) VALUES (?,?,?,?)`,
    [pid, tid, link.factor, link.method],
  )
  refers++
}
console.log(
  `Refer links: ${refers}${orphanRefers.length ? ` (${orphanRefers.length} unresolved: ${orphanRefers.join(', ')})` : ''}`,
)

/* ── Product pictures ────────────────────────────────────────────────────── */
//
// Streamed a page at a time rather than in one query: 1,910 blobs averaging
// 7.5KB is manageable, but the largest is 250KB and holding every row of the
// full table in one result set is memory nobody needs to spend.

let pictures = 0
const PAGE = 200
for (let offset = 0; ; offset += PAGE) {
  const [page] = await src.query(
    `SELECT StockCode, Picture FROM tblstockproperties
      WHERE Picture IS NOT NULL AND LENGTH(Picture) > 0
      ORDER BY StockCode LIMIT ? OFFSET ?`,
    [PAGE, offset],
  )
  if (!page.length) break
  for (const row of page) {
    const code = String(row.StockCode).trim()
    const pid = productId.get(code)
    if (!pid) continue
    const stored = await storeBlob(row.Picture, `product ${code}`)
    if (!stored) continue
    await site.query(
      `INSERT INTO product_images
         (product_id, stored_name, filename, mime_type, size_bytes, alt_text, sort_order, is_primary)
       VALUES (?,?,?,?,?,?,0,1)`,
      [
        pid,
        stored.storedName,
        `${code}${path.extname(stored.storedName)}`,
        stored.mime,
        stored.size,
        '',
      ],
    )
    // image_path is the ONE picture the till shows on a button (044's header).
    // It holds the stored name, which is what the serving route resolves.
    await site.query('UPDATE products SET image_path = ? WHERE id = ?', [stored.storedName, pid])
    pictures++
  }
  process.stdout.write(`\r  pictures: ${pictures}   `)
}
console.log(`\nProduct pictures: ${pictures}`)

if (skippedImages.length) {
  console.log(`  ${skippedImages.length} blob(s) were not a recognised image and were skipped:`)
  console.log(
    `    ${skippedImages.slice(0, 10).join(', ')}${skippedImages.length > 10 ? ', …' : ''}`,
  )
}
console.log(
  `Files written: ${filesWritten} (${(bytesWritten / 1024 / 1024).toFixed(1)} MB) into ${UPLOADS_ROOT}`,
)

await src.end()
await site.end()
console.log('\nDone.')
