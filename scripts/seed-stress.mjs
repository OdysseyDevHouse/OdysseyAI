/**
 * Stress data generator — fills a site database with a realistic-shaped load.
 *
 *   node --env-file=.env scripts/seed-stress.mjs 1 --docs=100000
 *   node --env-file=.env scripts/seed-stress.mjs 1 --docs=4000000
 *   node --env-file=.env scripts/seed-stress.mjs 1 --wipe
 *
 * WHY THIS DOES NOT CALL postSale() / receiveGoods()
 * -------------------------------------------------
 * Those are the correct paths for real work: each opens a transaction, takes the
 * atomic sequence lock, reconciles a ledger and re-reads the product row. That
 * is perhaps 300 documents a second. Four million would take three days.
 *
 * So this writes rows directly, in large multi-row INSERTs, and then RESTORES
 * every derived figure in one pass at the end — see reconcile() below. The
 * result satisfies the same invariants the app's own reconcilers check:
 *
 *   Σ stock_movements.qty_change            = product_location_stock.stock_on_hand
 *   Σ product_location_stock.stock_on_hand  = products.stock_on_hand
 *   Σ customer_transactions.amount_signed   = customers.balance
 *   Σ supplier_transactions.amount_signed   = suppliers.balance
 *   document_sequences.next_number          > every number issued
 *
 * If those hold, the generated data is indistinguishable from data the app
 * posted itself, and the reconcile screens stay green.
 *
 * EVERY generated row is marked so it can be found and removed again: sales and
 * purchase documents carry internal_note = SEED_TAG, and the master files use
 * the code prefixes below. --wipe deletes exactly those and nothing else, so
 * hand-made test data in the same database survives.
 */
import { createDecipheriv, scryptSync } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import mysql from 'mysql2/promise'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ── Marks ──────────────────────────────────────────────────────────────
// The only handles --wipe uses. Changing one strands the data it created.
const SEED_TAG = '[stress-seed]'
const P_PREFIX = 'SD'   // products
const C_PREFIX = 'SDC'  // customers
const S_PREFIX = 'SDS'  // suppliers

// ── Arguments ──────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const siteId = Number(argv.find((a) => /^\d+$/.test(a)))
const flag = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? Number(hit.split('=')[1]) : dflt
}
const has = (name) => argv.includes(`--${name}`)

const CFG = {
  docs:       flag('docs', 100_000),
  products:   flag('products', 40_000),
  customers:  flag('customers', 10_000),
  suppliers:  flag('suppliers', 500),
  grvs:       flag('grvs', 20_000),
  orders:     flag('orders', 20_000),
  years:      flag('years', 3),      // sales spread back this many years
  batch:      flag('batch', 2_000),  // documents per INSERT round-trip
}

if (!Number.isFinite(siteId) || siteId <= 0) {
  console.error('Usage: node --env-file=.env scripts/seed-stress.mjs <siteId> [--docs=N] [--wipe]')
  process.exit(1)
}

// ── Deterministic RNG ──────────────────────────────────────────────────
// Seeded, so a failed run reproduces exactly rather than generating a fresh
// pile of different data to debug.
let _s = 0x2f6e2b1 >>> 0
const rnd = () => {
  _s ^= _s << 13; _s >>>= 0
  _s ^= _s >> 17
  _s ^= _s << 5;  _s >>>= 0
  return _s / 0x100000000
}
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1))
const pick = (arr) => arr[int(0, arr.length - 1)]
const money = (lo, hi) => Math.round((lo + rnd() * (hi - lo)) * 100) / 100

// ── Connection, exactly as site-migrate.mjs resolves it ────────────────
const PREFIX = 'enc:v1:'
function decryptSecret(stored) {
  if (!stored) return ''
  if (!stored.startsWith(PREFIX)) return stored
  const [iv, tag, ct] = stored.slice(PREFIX.length).split(':').map((s) => Buffer.from(s, 'base64'))
  const key = scryptSync(process.env.ENCRYPTION_KEY, 'odyssey-secret-v1', 32)
  const d = createDecipheriv('aes-256-gcm', key, iv)
  d.setAuthTag(tag)
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8')
}

async function connect() {
  const control = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  })
  const [rows] = await control.query(
    `SELECT server_host, server_port, database_name, db_username, db_password_enc
       FROM cp2_site_databases
      WHERE site_id = ? AND status = 'active' ORDER BY purpose LIMIT 1`,
    [siteId],
  )
  await control.end()
  if (!rows.length) { console.error(`No active database for site ${siteId}.`); process.exit(1) }
  const cfg = rows[0]
  return mysql.createConnection({
    host: process.env.SITE_DB_HOST_OVERRIDE?.trim() || cfg.server_host,
    port: cfg.server_port || 3306,
    user: cfg.db_username || '',
    password: decryptSecret(cfg.db_password_enc),
    database: cfg.database_name,
    dateStrings: true,
  })
}

// ── Progress ───────────────────────────────────────────────────────────
const t0 = Date.now()
const hhmmss = (ms) => new Date(ms).toISOString().slice(11, 19)
let lastLine = 0
function progress(label, done, total) {
  const now = Date.now()
  if (now - lastLine < 500 && done < total) return
  lastLine = now
  const pct = total ? (done / total * 100).toFixed(1) : '0.0'
  const rate = done / Math.max(1, (now - t0) / 1000)
  const eta = rate > 0 && done < total ? hhmmss((total - done) / rate * 1000) : '--:--:--'
  process.stdout.write(`\r  ${label}: ${done.toLocaleString()}/${total.toLocaleString()} (${pct}%)  ${Math.round(rate).toLocaleString()}/s  eta ${eta}   `)
  if (done >= total) process.stdout.write('\n')
}

/** Multi-row INSERT. mysql2 expands a nested array into (…),(…),(…). */
async function insertRows(db, table, columns, rows) {
  if (!rows.length) return
  await db.query(`INSERT INTO \`${table}\` (${columns.map((c) => `\`${c}\``).join(',')}) VALUES ?`, [rows])
}

// ── Vocabulary ─────────────────────────────────────────────────────────
const DEPARTMENTS = [
  ['Groceries', ['Dry goods', 'Canned', 'Baking', 'Cereals', 'Condiments']],
  ['Beverages', ['Soft drinks', 'Juice', 'Water', 'Energy', 'Hot drinks']],
  ['Butchery', ['Beef', 'Chicken', 'Pork', 'Boerewors', 'Lamb']],
  ['Bakery', ['Bread', 'Rolls', 'Cakes', 'Pies']],
  ['Fresh produce', ['Fruit', 'Vegetables', 'Salads', 'Herbs']],
  ['Dairy', ['Milk', 'Cheese', 'Yoghurt', 'Butter']],
  ['Frozen', ['Chips', 'Ice cream', 'Ready meals', 'Frozen veg']],
  ['Household', ['Cleaning', 'Laundry', 'Paper goods', 'Kitchenware']],
  ['Toiletries', ['Haircare', 'Oral care', 'Skincare', 'Sanitary']],
  ['Hardware', ['Tools', 'Paint', 'Plumbing', 'Electrical', 'Fasteners']],
  ['Stationery', ['Paper', 'Writing', 'Filing', 'School']],
  ['Liquor', ['Beer', 'Wine', 'Spirits', 'Ciders']],
]
const ADJ = ['Premium', 'Value', 'Classic', 'Fresh', 'Golden', 'Royal', 'Farm', 'Pure', 'Super', 'Daily', 'Select', 'Home', 'Country', 'Mega', 'Lite']
const NOUN = ['Pack', 'Box', 'Bottle', 'Tin', 'Bag', 'Tub', 'Roll', 'Carton', 'Jar', 'Sachet', 'Case', 'Bar', 'Tray', 'Punnet', 'Bundle']
const SIZE = ['500g', '1kg', '2kg', '5kg', '250ml', '750ml', '1L', '2L', '6-pack', '12-pack', '100g', '400g', '24s', '10s']
const BRANDS = ['Alpen', 'Bokomo', 'Clover', 'Dairymaid', 'Eskort', 'Freshmark', 'Golden Cloud', 'Huletts', 'Illovo', 'Jungle', 'Koo', 'Lancewood', 'Mageu', 'Nestle', 'Ouma', 'Parmalat', 'Rhodes', 'Sasko', 'Tastic', 'Willards']
const FIRST = ['Thabo', 'Sarah', 'Johan', 'Nomsa', 'Pieter', 'Lerato', 'Ahmed', 'Michelle', 'Sipho', 'Anita', 'David', 'Zanele', 'Riaan', 'Fatima', 'Bongani', 'Elsa', 'Kobus', 'Naledi', 'Yusuf', 'Chantal', 'Mandla', 'Ingrid', 'Tebogo', 'Werner', 'Precious']
const LAST = ['Nkosi', 'van der Merwe', 'Botha', 'Dlamini', 'Naidoo', 'Pillay', 'Mokoena', 'Smit', 'Khumalo', 'Fourie', 'Patel', 'Zulu', 'Coetzee', 'Mabaso', 'Jacobs', 'Ndlovu', 'Steyn', 'Molefe', 'Adams', 'Sithole']
const CO = ['Trading', 'Wholesalers', 'Distributors', 'Supplies', 'Cash & Carry', 'Foods', 'Group', 'Holdings', 'Enterprises', 'Traders']
const CITY = ['Johannesburg', 'Pretoria', 'Cape Town', 'Durban', 'Gqeberha', 'Bloemfontein', 'Polokwane', 'Nelspruit', 'Kimberley', 'East London', 'Rustenburg', 'George']

const pad = (n, w) => String(n).padStart(w, '0')
const dateStr = (d) => d.toISOString().slice(0, 10)

// ── Wipe ───────────────────────────────────────────────────────────────
// Ordered so a child is always gone before its parent. FK checks stay ON: if
// something outside this list still points at a seeded row, the delete must
// fail loudly rather than leave the database inconsistent.
async function wipe(db) {
  console.log('Removing previously seeded data…')
  const steps = [
    ['sales tenders',      `DELETE t FROM sales_tenders t JOIN sales_documents d ON d.id=t.document_id WHERE d.internal_note=?`],
    ['sales lines',        `DELETE l FROM sales_document_lines l JOIN sales_documents d ON d.id=l.document_id WHERE d.internal_note=?`],
    ['order details',      `DELETE o FROM sales_order_details o JOIN sales_documents d ON d.id=o.document_id WHERE d.internal_note=?`],
    ['document audit',     `DELETE a FROM document_audit a JOIN sales_documents d ON d.id=a.document_id WHERE d.internal_note=?`],
    ['stock movements',    `DELETE FROM stock_movements WHERE note=?`],
    ['customer txns',      `DELETE FROM customer_transactions WHERE description LIKE CONCAT('%',?,'%')`],
    ['supplier txns',      `DELETE FROM supplier_transactions WHERE description LIKE CONCAT('%',?,'%')`],
    ['sales documents',    `DELETE FROM sales_documents WHERE internal_note=?`],
    ['purchase lines',     `DELETE l FROM purchase_document_lines l JOIN purchase_documents d ON d.id=l.document_id WHERE d.internal_note=?`],
    ['purchase details',   `DELETE o FROM purchase_order_details o JOIN purchase_documents d ON d.id=o.document_id WHERE d.internal_note=?`],
    ['purchase documents', `DELETE FROM purchase_documents WHERE internal_note=?`],
  ]
  for (const [label, sql] of steps) {
    const [r] = await db.query(sql, [SEED_TAG])
    console.log(`  ${label}: ${r.affectedRows.toLocaleString()} removed`)
  }
  // Master files last, and only rows carrying the seed prefixes.
  for (const [label, sql, arg] of [
    ['product location stock', `DELETE pls FROM product_location_stock pls JOIN products p ON p.id=pls.product_id WHERE p.code LIKE ?`, `${P_PREFIX}%`],
    ['product suppliers',      `DELETE ps FROM product_suppliers ps JOIN products p ON p.id=ps.product_id WHERE p.code LIKE ?`, `${P_PREFIX}%`],
    ['product prices',         `DELETE pp FROM product_prices pp JOIN products p ON p.id=pp.product_id WHERE p.code LIKE ?`, `${P_PREFIX}%`],
    ['products',               `DELETE FROM products WHERE code LIKE ?`, `${P_PREFIX}%`],
    ['customers',              `DELETE FROM customers WHERE code LIKE ?`, `${C_PREFIX}%`],
    ['suppliers',              `DELETE FROM suppliers WHERE code LIKE ?`, `${S_PREFIX}%`],
  ]) {
    const [r] = await db.query(sql, [arg])
    console.log(`  ${label}: ${r.affectedRows.toLocaleString()} removed`)
  }
  console.log('Wipe complete.\n')
}

// ── Master files ───────────────────────────────────────────────────────
async function seedDepartments(db) {
  const [existing] = await db.query('SELECT id FROM departments LIMIT 1')
  const ids = []
  if (existing.length) {
    const [all] = await db.query('SELECT id FROM departments')
    for (const r of all) ids.push(r.id)
    if (ids.length) { console.log(`Departments: ${ids.length} already present, reusing`); return ids }
  }
  for (const [parent, children] of DEPARTMENTS) {
    const [p] = await db.query('INSERT INTO departments (name, code, sort_order) VALUES (?,?,?)',
      [parent, parent.slice(0, 4).toUpperCase(), ids.length])
    for (const child of children) {
      const [c] = await db.query('INSERT INTO departments (parent_id, name, code, sort_order) VALUES (?,?,?,?)',
        [p.insertId, child, child.slice(0, 4).toUpperCase(), ids.length])
      ids.push(c.insertId)   // products hang off leaves, as they do in real data
    }
  }
  console.log(`Departments: ${DEPARTMENTS.length} parents, ${ids.length} leaves`)
  return ids
}

async function seedBrands(db) {
  const ids = []
  for (const name of BRANDS) {
    const [r] = await db.query('INSERT INTO brands (name) VALUES (?) ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)', [name])
    ids.push(r.insertId)
  }
  return ids
}

async function seedProducts(db, deptIds, brandIds, vatSalesId, vatPurchaseId, structureId, locationIds) {
  const total = CFG.products
  console.log(`Products: generating ${total.toLocaleString()}…`)
  // No min_stock/max_stock here: 028 moved reorder levels onto
  // product_location_stock, because a level is only meaningful per pile.
  const cols = ['code', 'barcode', 'description', 'product_type', 'department_id', 'brand_id',
    'purchase_vat_rate_id', 'selling_vat_rate_id', 'last_cost', 'average_cost',
    'stock_on_hand', 'visible_in_pos', 'created_at']
  const meta = []   // kept in memory: sales generation needs price and cost
  let buf = []
  for (let i = 1; i <= total; i++) {
    const cost = money(3, 900)
    const markup = 1.15 + rnd() * 0.85          // 15%–100% over cost
    const priceIncl = Math.round(cost * markup * 1.15 * 100) / 100
    const code = `${P_PREFIX}${pad(i, 6)}`
    const desc = `${pick(ADJ)} ${pick(BRANDS)} ${pick(NOUN)} ${pick(SIZE)}`
    const deptId = pick(deptIds)
    buf.push([code, `600${pad(i, 10)}`, desc, 'normal', deptId, pick(brandIds),
      vatPurchaseId, vatSalesId, cost, cost, 0, 1,
      dateStr(new Date(Date.now() - int(30, 1200) * 86400000))])
    meta.push({ code, desc, deptId, cost, priceIncl, minStock: int(0, 20), maxStock: int(40, 400) })
    if (buf.length >= 5000) { await insertRows(db, 'products', cols, buf); buf = []; progress('products', i, total) }
  }
  if (buf.length) await insertRows(db, 'products', cols, buf)
  progress('products', total, total)

  // Ids are assigned by AUTO_INCREMENT, so read them back and pair by code
  // order — inserted in one ascending run, so id order matches meta order.
  const [rows] = await db.query(`SELECT id, code FROM products WHERE code LIKE ? ORDER BY id`, [`${P_PREFIX}%`])
  const byCode = new Map(meta.map((m) => [m.code, m]))
  const products = rows.map((r) => ({ id: r.id, ...byCode.get(r.code) })).filter((p) => p.desc)

  // Prices, one per structure.
  console.log('Products: prices…')
  buf = []
  for (const p of products) {
    buf.push([p.id, structureId, p.priceIncl])
    if (buf.length >= 10000) { await insertRows(db, 'product_prices', ['product_id', 'price_structure_id', 'selling_price_incl'], buf); buf = [] }
  }
  if (buf.length) await insertRows(db, 'product_prices', ['product_id', 'price_structure_id', 'selling_price_incl'], buf)

  // A pile row per location per product — the schema expects one to exist
  // before any movement lands on it.
  // Levels sit on the MAIN pile only — a back room with its own reorder point
  // is a deliberate setup choice, not something a generator should invent.
  console.log('Products: location stock rows…')
  const plsCols = ['product_id', 'location_id', 'stock_on_hand', 'min_stock', 'max_stock']
  buf = []
  for (const p of products) {
    for (const locId of locationIds) {
      const isMain = locId === locationIds[0]
      buf.push([p.id, locId, 0, isMain ? p.minStock : 0, isMain ? p.maxStock : 0])
      if (buf.length >= 10000) { await insertRows(db, 'product_location_stock', plsCols, buf); buf = [] }
    }
  }
  if (buf.length) await insertRows(db, 'product_location_stock', plsCols, buf)
  return products
}

async function seedCustomers(db, structureId) {
  const total = CFG.customers
  console.log(`Customers: generating ${total.toLocaleString()}…`)
  const cols = ['code', 'name', 'status', 'account_type', 'contact_name', 'email', 'phone',
    'address_line1', 'city', 'postal_code', 'vat_number', 'payment_terms_days',
    'credit_limit', 'balance', 'created_at']
  let buf = []
  const out = []
  for (let i = 1; i <= total; i++) {
    const person = `${pick(FIRST)} ${pick(LAST)}`
    // A fifth are businesses — they get the bigger limits and longer terms,
    // which is what makes an age analysis look like a real one.
    const isCo = rnd() < 0.2
    const name = isCo ? `${pick(LAST)} ${pick(CO)}` : person
    const code = `${C_PREFIX}${pad(i, 6)}`
    const status = rnd() < 0.88 ? 'active' : pick(['on_hold', 'inactive', 'closed'])
    const terms = isCo ? pick([30, 30, 60, 90]) : pick([0, 30])
    const limit = isCo ? money(20000, 400000) : (rnd() < 0.5 ? 0 : money(1000, 25000))
    // No credit granted means a cash account. The rest split between open-item
    // (the default, and what statements assume) and balance-forward.
    const accountType = limit === 0 ? 'cash' : (rnd() < 0.8 ? 'open_item' : 'balance_fwd')
    buf.push([code, name, status, accountType, person,
      `${person.split(' ')[0].toLowerCase()}${i}@example.co.za`,
      `0${int(60, 84)}${int(1000000, 9999999)}`,
      `${int(1, 400)} ${pick(LAST)} Street`, pick(CITY), pad(int(1, 9999), 4),
      isCo ? `4${int(100000000, 999999999)}` : null, terms, limit, 0,
      dateStr(new Date(Date.now() - int(30, 1500) * 86400000))])
    out.push({ code, terms, name, onAccount: limit > 0 && status === 'active' })
    if (buf.length >= 5000) { await insertRows(db, 'customers', cols, buf); buf = []; progress('customers', i, total) }
  }
  if (buf.length) await insertRows(db, 'customers', cols, buf)
  progress('customers', total, total)
  const [rows] = await db.query('SELECT id, code, name, payment_terms_days FROM customers WHERE code LIKE ? ORDER BY id', [`${C_PREFIX}%`])
  const byCode = new Map(out.map((c) => [c.code, c]))
  return rows.map((r) => ({ id: r.id, code: r.code, name: r.name, terms: r.payment_terms_days, onAccount: byCode.get(r.code)?.onAccount ?? false }))
}

async function seedSuppliers(db) {
  const total = CFG.suppliers
  console.log(`Suppliers: generating ${total.toLocaleString()}…`)
  const cols = ['code', 'name', 'status', 'contact_name', 'email', 'phone', 'address_line1',
    'city', 'postal_code', 'vat_number', 'account_number', 'payment_terms_days',
    'lead_time_days', 'minimum_order', 'bank_name', 'bank_account', 'balance', 'created_at']
  const buf = []
  for (let i = 1; i <= total; i++) {
    const name = `${pick(LAST)} ${pick(CO)}`
    const person = `${pick(FIRST)} ${pick(LAST)}`
    buf.push([`${S_PREFIX}${pad(i, 5)}`, name, rnd() < 0.93 ? 'active' : pick(['on_hold', 'inactive']),
      person, `orders${i}@${name.split(' ')[0].toLowerCase()}.co.za`,
      `0${int(10, 21)}${int(1000000, 9999999)}`, `${int(1, 200)} Industrial Road`,
      pick(CITY), pad(int(1, 9999), 4), `4${int(100000000, 999999999)}`,
      `ACC${pad(i, 6)}`, pick([7, 14, 30, 30, 60]), int(1, 21), money(0, 5000),
      pick(['ABSA', 'FNB', 'Nedbank', 'Standard Bank', 'Capitec']),
      String(int(10000000, 99999999)), 0,
      dateStr(new Date(Date.now() - int(60, 1500) * 86400000))])
  }
  await insertRows(db, 'suppliers', cols, buf)
  const [rows] = await db.query('SELECT id, code, name, payment_terms_days FROM suppliers WHERE code LIKE ? ORDER BY id', [`${S_PREFIX}%`])
  console.log(`  ${rows.length.toLocaleString()} suppliers`)
  return rows.map((r) => ({ id: r.id, code: r.code, name: r.name, terms: r.payment_terms_days }))
}

/** Which products each supplier carries. Purchasing needs a plausible mapping. */
async function linkProductSuppliers(db, products, suppliers) {
  console.log('Linking products to suppliers…')
  let buf = []
  const cols = ['product_id', 'supplier_id', 'supplier_code', 'last_cost', 'pack_size', 'is_preferred']
  for (const p of products) {
    const n = rnd() < 0.3 ? 2 : 1          // some products have a second source
    const used = new Set()
    for (let k = 0; k < n; k++) {
      const s = pick(suppliers)
      if (used.has(s.id)) continue
      used.add(s.id)
      buf.push([p.id, s.id, `${s.code}-${p.code.slice(-5)}`, p.cost, pick([1, 1, 6, 12, 24]), k === 0 ? 1 : 0])
    }
    if (buf.length >= 10000) { await insertRows(db, 'product_suppliers', cols, buf); buf = [] }
  }
  if (buf.length) await insertRows(db, 'product_suppliers', cols, buf)
}

// ── Purchasing: orders and GRVs ────────────────────────────────────────
// GRVs run BEFORE sales so stock exists to sell. Each GRV writes a receipt
// movement; the reconcile pass then makes stock_on_hand agree with them.
async function seedPurchasing(db, products, suppliers, vatRate, mainLocation, startNo) {
  const totalGrv = CFG.grvs, totalPo = CFG.orders
  console.log(`Purchasing: ${totalPo.toLocaleString()} orders + ${totalGrv.toLocaleString()} GRVs…`)

  const docCols = ['doc_type', 'status', 'document_number', 'document_date', 'due_date',
    'supplier_id', 'supplier_code', 'supplier_name', 'supplier_invoice_no',
    'user_id', 'user_name', 'subtotal_excl', 'vat_total', 'total_incl', 'charges_excl',
    'internal_note', 'finalised_at', 'created_at']
  const lineCols = ['document_id', 'line_number', 'product_id', 'location_id', 'product_code',
    'supplier_code', 'description', 'product_type', 'department_id',
    'qty_ordered', 'qty_received', 'unit_cost_excl', 'discount_pct', 'vat_rate_pct',
    'line_total_excl', 'line_vat', 'line_total_incl', 'charge_excl', 'landed_cost_excl']
  const moveCols = ['product_id', 'location_id', 'movement_type', 'qty_change', 'qty_after',
    'unit_cost_excl', 'source', 'source_doc_id', 'user_id', 'user_name', 'note', 'created_at']
  // amount_outstanding drives the payables age analysis; leaving it zero would
  // make every seeded invoice look already settled.
  const txnCols = ['supplier_id', 'doc_type', 'doc_number', 'doc_date', 'due_date', 'reference',
    'description', 'amount_gross', 'amount_vat', 'amount_net', 'amount_signed',
    'amount_outstanding', 'source', 'created_at']

  const now = Date.now()
  const spanDays = CFG.years * 365
  let grvNo = startNo.grv ?? 1, poNo = startNo.purchase_order ?? 1
  let doneGrv = 0, donePo = 0
  const receipts = new Map()   // productId -> qty received, seeds the sales phase

  // Orders first: they carry no stock or ledger effect, so they are pure rows.
  for (let done = 0; done < totalPo;) {
    const n = Math.min(CFG.batch, totalPo - done)
    const docs = [], pending = []
    for (let i = 0; i < n; i++) {
      const s = pick(suppliers)
      const d = new Date(now - int(1, spanDays) * 86400000)
      const lines = []
      let excl = 0
      for (let k = 0, c = int(2, 12); k < c; k++) {
        const p = pick(products)
        const qty = int(1, 60)
        const lineExcl = Math.round(p.cost * qty * 100) / 100
        excl += lineExcl
        lines.push({ p, qty, lineExcl })
      }
      excl = Math.round(excl * 100) / 100
      const vat = Math.round(excl * vatRate) / 100
      // Most orders are still open; the rest were received or abandoned.
      const status = rnd() < 0.55 ? 'issued' : (rnd() < 0.7 ? 'finalised' : 'cancelled')
      const num = status === 'cancelled' ? null : `PO${pad(poNo++, 6)}`
      docs.push(['purchase_order', status, num, dateStr(d),
        dateStr(new Date(d.getTime() + s.terms * 86400000)), s.id, s.code, s.name, null,
        1, 'Seed', excl, vat, Math.round((excl + vat) * 100) / 100, 0, SEED_TAG,
        status === 'finalised' ? dateStr(d) : null, dateStr(d)])
      pending.push({ lines, status })
    }
    const [res] = await db.query(
      `INSERT INTO purchase_documents (${docCols.join(',')}) VALUES ?`, [docs])
    const firstId = res.insertId
    const lineRows = [], detailRows = []
    pending.forEach((doc, idx) => {
      const id = firstId + idx
      detailRows.push([id, dateStr(new Date(now - int(0, 60) * 86400000)),
        doc.status === 'finalised' ? 'received' : (doc.status === 'cancelled' ? 'cancelled' : 'open'), null])
      doc.lines.forEach((l, li) => {
        const vat = Math.round(l.lineExcl * vatRate) / 100
        lineRows.push([id, li + 1, l.p.id, mainLocation, l.p.code, null, l.p.desc, 'normal', l.p.deptId,
          l.qty, doc.status === 'finalised' ? l.qty : 0, l.p.cost, 0, vatRate,
          l.lineExcl, vat, Math.round((l.lineExcl + vat) * 100) / 100, 0, l.p.cost])
      })
    })
    await insertRows(db, 'purchase_document_lines', lineCols, lineRows)
    await insertRows(db, 'purchase_order_details', ['document_id', 'expected_date', 'fulfilment_status', 'supplier_order_no'], detailRows)
    done += n; donePo = done
    progress('orders', donePo, totalPo)
  }

  // GRVs: these move stock and post to the creditors ledger.
  for (let done = 0; done < totalGrv;) {
    const n = Math.min(CFG.batch, totalGrv - done)
    const docs = [], pending = []
    for (let i = 0; i < n; i++) {
      const s = pick(suppliers)
      const d = new Date(now - int(1, spanDays) * 86400000)
      const lines = []
      let excl = 0
      for (let k = 0, c = int(3, 20); k < c; k++) {
        const p = pick(products)
        const qty = int(5, 200)
        const lineExcl = Math.round(p.cost * qty * 100) / 100
        excl += lineExcl
        lines.push({ p, qty, lineExcl })
      }
      excl = Math.round(excl * 100) / 100
      const vat = Math.round(excl * vatRate) / 100
      const charges = rnd() < 0.3 ? money(50, 900) : 0
      docs.push(['grv', 'finalised', `GRV${pad(grvNo++, 6)}`, dateStr(d),
        dateStr(new Date(d.getTime() + s.terms * 86400000)), s.id, s.code, s.name,
        `SI-${int(10000, 999999)}`, 1, 'Seed', excl, vat,
        Math.round((excl + vat) * 100) / 100, charges, SEED_TAG, dateStr(d), dateStr(d)])
      pending.push({ lines, date: d, supplier: s, excl, vat, charges, number: `GRV${pad(grvNo - 1, 6)}` })
    }
    const [res] = await db.query(
      `INSERT INTO purchase_documents (${docCols.join(',')}) VALUES ?`, [docs])
    const firstId = res.insertId
    const lineRows = [], moveRows = [], txnRows = []
    pending.forEach((doc, idx) => {
      const id = firstId + idx
      // Freight spread across the lines by value — the landed-cost rule.
      const chargePer = doc.charges / Math.max(1, doc.lines.length)
      doc.lines.forEach((l, li) => {
        const vat = Math.round(l.lineExcl * vatRate) / 100
        const landed = Math.round((l.p.cost + chargePer / l.qty) * 10000) / 10000
        lineRows.push([id, li + 1, l.p.id, mainLocation, l.p.code, null, l.p.desc, 'normal', l.p.deptId,
          l.qty, l.qty, l.p.cost, 0, vatRate, l.lineExcl, vat,
          Math.round((l.lineExcl + vat) * 100) / 100,
          Math.round(chargePer * 10000) / 10000, landed])
        // qty_after is filled by the reconcile pass; a running total per
        // product cannot be known while batches are generated out of order.
        moveRows.push([l.p.id, mainLocation, 'receipt', l.qty, 0, landed, 'grv', id, 1, 'Seed', SEED_TAG,
          `${dateStr(doc.date)} ${pad(int(6, 18), 2)}:${pad(int(0, 59), 2)}:00`])
        receipts.set(l.p.id, (receipts.get(l.p.id) || 0) + l.qty)
      })
      const gross = Math.round((doc.excl + doc.vat) * 100) / 100
      // Roughly half the creditors book is already paid, so the age analysis
      // has both settled and outstanding invoices in it.
      const outstanding = rnd() < 0.5 ? 0 : gross
      txnRows.push([doc.supplier.id, 'invoice', doc.number, dateStr(doc.date),
        dateStr(new Date(doc.date.getTime() + doc.supplier.terms * 86400000)),
        `SI-${int(10000, 999999)}`, `${SEED_TAG} Goods received`, gross, doc.vat,
        doc.excl, gross, outstanding, 'grv', dateStr(doc.date)])
    })
    await insertRows(db, 'purchase_document_lines', lineCols, lineRows)
    await insertRows(db, 'stock_movements', moveCols, moveRows)
    await insertRows(db, 'supplier_transactions', txnCols, txnRows)
    done += n; doneGrv = done
    progress('GRVs', doneGrv, totalGrv)
  }
  return { receipts, nextGrv: grvNo, nextPo: poNo }
}

// ── Sales ──────────────────────────────────────────────────────────────
async function seedSales(db, products, customers, tenders, vatRate, mainLocation, terminals, startNo) {
  const total = CFG.docs
  console.log(`Sales: ${total.toLocaleString()} documents…`)

  const docCols = ['doc_type', 'status', 'document_number', 'document_date', 'due_date',
    'customer_id', 'customer_code', 'customer_name', 'user_id', 'user_name',
    'terminal_id', 'terminal_code', 'subtotal_excl', 'vat_total', 'discount_total',
    'total_incl', 'rounding_adj', 'tendered_total', 'change_given',
    'internal_note', 'finalised_at', 'created_at']
  const lineCols = ['document_id', 'line_number', 'product_id', 'product_code', 'description',
    'product_type', 'department_id', 'qty', 'unit_price_incl', 'discount_pct',
    'discount_incl', 'vat_rate_pct', 'line_total_incl', 'line_total_excl',
    'line_vat', 'unit_cost_excl']
  const tenderCols = ['document_id', 'tender_type_id', 'tender_code', 'tender_name',
    'amount', 'change_given', 'surcharge', 'created_at']
  const moveCols = ['product_id', 'location_id', 'movement_type', 'qty_change', 'qty_after',
    'unit_cost_excl', 'source', 'source_doc_id', 'terminal_id', 'user_id',
    'user_name', 'note', 'created_at']
  const txnCols = ['customer_id', 'doc_type', 'doc_number', 'doc_date', 'due_date',
    'description', 'amount_gross', 'amount_vat', 'amount_net', 'amount_signed',
    'amount_outstanding', 'source', 'source_doc_id', 'created_at']

  const cash = tenders.find((t) => t.code === 'CASH')
  const card = tenders.find((t) => t.code === 'CARD')
  const account = tenders.find((t) => t.code === 'ACCOUNT')
  const accountCustomers = customers.filter((c) => c.onAccount)
  const now = Date.now()
  const spanDays = CFG.years * 365
  // Sales-side key, per 022. The ledger rows below still say 'credit_note'.
  let invNo = startNo.invoice, crnNo = startNo.credit_sale ?? 1
  const vatDiv = 1 + vatRate / 100

  for (let done = 0; done < total;) {
    const n = Math.min(CFG.batch, total - done)
    const docs = [], pending = []
    for (let i = 0; i < n; i++) {
      // Weekly seasonality: Saturdays busy, Sundays quiet — reports have
      // something to show other than a flat line.
      const d = new Date(now - int(0, spanDays) * 86400000)
      const dow = d.getDay()
      if (dow === 0 && rnd() < 0.6) d.setDate(d.getDate() - 1)

      // 3% are credit sales, carrying negative quantities and money.
      //
      // NAMING, per 022: the SALES document is a 'credit_sale' — reversing a
      // sale. The LEDGER row it posts is a 'credit_note' — an adjustment to an
      // account. Two tables, two meanings, two words; do not unify them.
      const isCredit = rnd() < 0.03
      const sign = isCredit ? -1 : 1
      // Account sales need a customer; most walk-ins do not get one.
      const onAccount = !isCredit && accountCustomers.length > 0 && rnd() < 0.18
      const cust = onAccount ? pick(accountCustomers) : (rnd() < 0.12 ? pick(customers) : null)

      const lines = []
      let incl = 0, cost = 0, disc = 0
      for (let k = 0, c = isCredit ? int(1, 3) : int(1, 8); k < c; k++) {
        const p = pick(products)
        const qty = rnd() < 0.75 ? 1 : int(2, 6)
        const discPct = rnd() < 0.12 ? pick([5, 10, 15]) : 0
        const gross = Math.round(p.priceIncl * qty * 100) / 100
        const discInc = Math.round(gross * discPct) / 100
        const lineIncl = Math.round((gross - discInc) * 100) / 100
        incl += lineIncl; disc += discInc
        cost += p.cost * qty
        lines.push({ p, qty: qty * sign, discPct, discInc: discInc * sign, lineIncl: lineIncl * sign })
      }
      incl = Math.round(incl * sign * 100) / 100
      const excl = Math.round(incl / vatDiv * 100) / 100
      const vat = Math.round((incl - excl) * 100) / 100

      const terminal = pick(terminals)
      const docNo = isCredit ? `CRN${pad(crnNo++, 6)}` : `INV${pad(invNo++, 6)}`
      const stamp = `${dateStr(d)} ${pad(int(7, 19), 2)}:${pad(int(0, 59), 2)}:${pad(int(0, 59), 2)}`

      // Cash rounds to 5c at the TENDER, never on the invoice.
      let rounding = 0, tendered = incl, change = 0, tenderType = card
      if (onAccount) tenderType = account
      else if (rnd() < 0.55) {
        tenderType = cash
        const rounded = Math.round(incl * 20) / 20
        rounding = Math.round((rounded - incl) * 100) / 100
        const handed = isCredit ? rounded : Math.ceil(rounded / 20) * 20
        change = Math.round((handed - rounded) * 100) / 100
        tendered = handed
      }

      docs.push([isCredit ? 'credit_sale' : 'invoice', 'finalised', docNo, dateStr(d),
        onAccount && cust ? dateStr(new Date(d.getTime() + cust.terms * 86400000)) : null,
        cust?.id ?? null, cust?.code ?? null, cust?.name ?? null, 1, 'Seed',
        terminal.id, terminal.code, excl, vat, Math.round(disc * sign * 100) / 100,
        incl, rounding, tendered, change, SEED_TAG, stamp, stamp])
      pending.push({ lines, stamp, terminal, incl, excl, vat, cust, onAccount, isCredit, docNo, d, tenderType, tendered, change })
    }

    const [res] = await db.query(`INSERT INTO sales_documents (${docCols.join(',')}) VALUES ?`, [docs])
    const firstId = res.insertId
    const lineRows = [], tenderRows = [], moveRows = [], txnRows = []
    pending.forEach((doc, idx) => {
      const id = firstId + idx
      doc.lines.forEach((l, li) => {
        const lineExcl = Math.round(l.lineIncl / vatDiv * 100) / 100
        lineRows.push([id, li + 1, l.p.id, l.p.code, l.p.desc, 'normal', l.p.deptId,
          l.qty, l.p.priceIncl, l.discPct, l.discInc, vatRate, l.lineIncl, lineExcl,
          Math.round((l.lineIncl - lineExcl) * 100) / 100, l.p.cost])
        // A credit note RETURNS stock, so the sign flips with the quantity.
        moveRows.push([l.p.id, mainLocation, doc.isCredit ? 'sale_return' : 'sale',
          -l.qty, 0, l.p.cost, doc.isCredit ? 'credit_sale' : 'sale', id,
          doc.terminal.id, 1, 'Seed', SEED_TAG, doc.stamp])
      })
      tenderRows.push([id, doc.tenderType.id, doc.tenderType.code, doc.tenderType.name,
        doc.tendered, doc.change, 0, doc.stamp])
      // Only an account sale hits the debtors ledger. A cash sale is settled.
      if (doc.onAccount && doc.cust) {
        txnRows.push([doc.cust.id, doc.isCredit ? 'credit_note' : 'invoice', doc.docNo,
          dateStr(doc.d), dateStr(new Date(doc.d.getTime() + doc.cust.terms * 86400000)),
          `${SEED_TAG} Sale`, doc.incl, doc.vat, doc.excl, doc.incl, doc.incl,
          'sale', id, doc.stamp])
      }
    })
    await insertRows(db, 'sales_document_lines', lineCols, lineRows)
    await insertRows(db, 'sales_tenders', tenderCols, tenderRows)
    await insertRows(db, 'stock_movements', moveCols, moveRows)
    if (txnRows.length) await insertRows(db, 'customer_transactions', txnCols, txnRows)
    done += n
    progress('sales', done, total)
  }
  return { nextInv: invNo, nextCrn: crnNo }
}

/** Payments against some account balances, so the age analysis is not all current. */
async function seedCustomerPayments(db, customers) {
  const accts = customers.filter((c) => c.onAccount)
  if (!accts.length) return
  console.log('Customer payments…')
  const cols = ['customer_id', 'doc_type', 'doc_number', 'doc_date', 'description',
    'amount_gross', 'amount_vat', 'amount_net', 'amount_signed', 'amount_outstanding',
    'source', 'created_at']
  const [owing] = await db.query(
    `SELECT customer_id, SUM(amount_signed) AS bal FROM customer_transactions
      WHERE description LIKE CONCAT('%',?,'%') GROUP BY customer_id HAVING bal > 0`, [SEED_TAG])
  let buf = []
  const paidCustomers = []
  for (const row of owing) {
    if (rnd() < 0.35) continue                    // a third stay fully outstanding
    const bal = Number(row.bal)
    const full = rnd() < 0.5
    const paid = Math.round(bal * (full ? 1 : 0.3 + rnd() * 0.5) * 100) / 100
    if (paid <= 0) continue
    const d = new Date(Date.now() - int(1, 200) * 86400000)
    // A payment is a credit and carries no VAT; it is not itself "due", so it
    // holds no outstanding amount of its own.
    buf.push([row.customer_id, 'payment', `RCT${int(100000, 999999)}`, dateStr(d),
      `${SEED_TAG} Payment received`, paid, 0, paid, -paid, 0, 'payment', dateStr(d)])
    if (full) paidCustomers.push(row.customer_id)
    if (buf.length >= 5000) { await insertRows(db, 'customer_transactions', cols, buf); buf = [] }
  }
  if (buf.length) await insertRows(db, 'customer_transactions', cols, buf)

  // Fully-paid accounts have nothing open against them. Without this the age
  // analysis shows a zero balance while still listing unsettled invoices.
  for (let i = 0; i < paidCustomers.length; i += 5000) {
    const chunk = paidCustomers.slice(i, i + 5000)
    await db.query(
      `UPDATE customer_transactions SET amount_outstanding = 0
        WHERE customer_id IN (?) AND doc_type IN ('invoice','credit_note')
          AND description LIKE CONCAT('%',?,'%')`, [chunk, SEED_TAG])
  }
  console.log(`  ${owing.length.toLocaleString()} accounts reviewed, ${paidCustomers.length.toLocaleString()} settled in full`)
}

// ── Reconcile ──────────────────────────────────────────────────────────
// Restores every derived figure from the rows just written, in set-based SQL.
// This is what makes the generated data pass the app's own reconcilers.
async function reconcile(db) {
  console.log('\nReconciling derived state…')

  // ── BOTH HALVES MUST COVER THE SAME PRODUCTS ─────────────────────────────
  //
  // They did not. The piles were rewritten for EVERY product while the totals
  // were only fixed for seeded ones, so a pre-existing product that the seeder
  // sold against had its pile driven to the movement sum and its total left
  // where it was — drifting the two apart by exactly the opening stock the
  // seeder never wrote a movement for.
  //
  // That is invariant (C) broken by the tool whose job is to satisfy it, and
  // it fails the app's own reconciler on a product nobody touched by hand.
  // Filtering both halves the same way is the fix; the filter itself stays so
  // a seed run cannot rewrite stock the seeder does not own.
  console.log('  product_location_stock from movements…')
  await db.query(`
    UPDATE product_location_stock pls
      JOIN products p ON p.id = pls.product_id
      JOIN (SELECT product_id, location_id, SUM(qty_change) AS total
              FROM stock_movements GROUP BY product_id, location_id) m
        ON m.product_id = pls.product_id AND m.location_id = pls.location_id
       SET pls.stock_on_hand = m.total
     WHERE p.code LIKE ?`, [`${P_PREFIX}%`])

  console.log('  products.stock_on_hand from locations…')
  await db.query(`
    UPDATE products p
      LEFT JOIN (SELECT product_id, SUM(stock_on_hand) AS total
                   FROM product_location_stock GROUP BY product_id) l
        ON l.product_id = p.id
       SET p.stock_on_hand = COALESCE(l.total, 0)
     WHERE p.code LIKE ?`, [`${P_PREFIX}%`])

  // qty_after: the running balance per product in movement order. Cheap with a
  // window function; MySQL 8 is required for it, so fall back if absent.
  console.log('  stock_movements.qty_after running balance…')
  try {
    await db.query(`
      UPDATE stock_movements m
        JOIN (SELECT id, SUM(qty_change) OVER (
                       PARTITION BY product_id, location_id
                       ORDER BY created_at, id
                       ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running
                FROM stock_movements) r ON r.id = m.id
         SET m.qty_after = r.running`)
  } catch (e) {
    console.log(`    skipped (${e.message.slice(0, 60)}) — qty_after left at 0`)
  }

  console.log('  products.last_sold_date / last_purchase_date…')
  await db.query(`
    UPDATE products p
      JOIN (SELECT product_id, MAX(created_at) AS d FROM stock_movements
             WHERE movement_type='sale' GROUP BY product_id) s ON s.product_id = p.id
       SET p.last_sold_date = s.d`)
  await db.query(`
    UPDATE products p
      JOIN (SELECT product_id, MAX(created_at) AS d FROM stock_movements
             WHERE movement_type='receipt' GROUP BY product_id) r ON r.product_id = p.id
       SET p.last_purchase_date = r.d, p.average_cost = p.last_cost`)

  console.log('  customer balances from the ledger…')
  await db.query(`
    UPDATE customers c
      LEFT JOIN (SELECT customer_id, SUM(amount_signed) AS bal
                   FROM customer_transactions GROUP BY customer_id) t
        ON t.customer_id = c.id
       SET c.balance = COALESCE(t.bal, 0)
     WHERE c.code LIKE ?`, [`${C_PREFIX}%`])

  console.log('  supplier balances from the ledger…')
  await db.query(`
    UPDATE suppliers s
      LEFT JOIN (SELECT supplier_id, SUM(amount_signed) AS bal
                   FROM supplier_transactions GROUP BY supplier_id) t
        ON t.supplier_id = s.id
       SET s.balance = COALESCE(t.bal, 0)
     WHERE s.code LIKE ?`, [`${S_PREFIX}%`])

  // Sequences must sit ABOVE every number issued, or the next real document
  // collides with a seeded one on uq_doc_number.
  console.log('  document sequences…')
  // 'credit_sale' per 022 — the sequence row was renamed with the doc type,
  // though its prefix stays CRN because a document number is a promise.
  for (const [docType, prefix, table] of [
    ['invoice', 'INV', 'sales_documents'],
    ['credit_sale', 'CRN', 'sales_documents'],
    ['grv', 'GRV', 'purchase_documents'],
    ['purchase_order', 'PO', 'purchase_documents'],
  ]) {
    const [[row]] = await db.query(
      `SELECT MAX(CAST(SUBSTRING(document_number, ?) AS UNSIGNED)) AS n
         FROM ${table} WHERE doc_type = ? AND document_number LIKE ?`,
      [prefix.length + 1, docType, `${prefix}%`])
    const maxNo = Number(row?.n || 0)
    if (maxNo > 0) {
      await db.query(
        `UPDATE document_sequences SET next_number = GREATEST(next_number, ?), last_issued_number = GREATEST(COALESCE(last_issued_number,0), ?)
          WHERE doc_type = ?`, [maxNo + 1, maxNo, docType])
    }
  }
  console.log('Reconcile complete.')
}

async function verify(db) {
  console.log('\nVerifying invariants…')
  const checks = [
    ['stock: Σ movements = location stock', `
      SELECT COUNT(*) AS n FROM product_location_stock pls
        LEFT JOIN (SELECT product_id, location_id, SUM(qty_change) AS total
                     FROM stock_movements GROUP BY product_id, location_id) m
          ON m.product_id=pls.product_id AND m.location_id=pls.location_id
       WHERE ABS(pls.stock_on_hand - COALESCE(m.total,0)) > 0.0005`],
    ['stock: Σ locations = product total', `
      SELECT COUNT(*) AS n FROM products p
        LEFT JOIN (SELECT product_id, SUM(stock_on_hand) AS total
                     FROM product_location_stock GROUP BY product_id) l ON l.product_id=p.id
       WHERE ABS(p.stock_on_hand - COALESCE(l.total,0)) > 0.0005`],
    ['debtors: Σ ledger = customer balance', `
      SELECT COUNT(*) AS n FROM customers c
        LEFT JOIN (SELECT customer_id, SUM(amount_signed) AS bal
                     FROM customer_transactions GROUP BY customer_id) t ON t.customer_id=c.id
       WHERE ABS(c.balance - COALESCE(t.bal,0)) > 0.0005`],
    ['creditors: Σ ledger = supplier balance', `
      SELECT COUNT(*) AS n FROM suppliers s
        LEFT JOIN (SELECT supplier_id, SUM(amount_signed) AS bal
                     FROM supplier_transactions GROUP BY supplier_id) t ON t.supplier_id=s.id
       WHERE ABS(s.balance - COALESCE(t.bal,0)) > 0.0005`],
    ['documents: totals = Σ lines', `
      SELECT COUNT(*) AS n FROM (
        SELECT d.id, d.total_incl, SUM(l.line_total_incl) AS lines_incl
          FROM sales_documents d JOIN sales_document_lines l ON l.document_id=d.id
         WHERE d.internal_note = '${SEED_TAG}'
         GROUP BY d.id, d.total_incl
        HAVING ABS(d.total_incl - lines_incl) > 0.005) x`],
  ]
  let bad = 0
  for (const [label, sql] of checks) {
    const [[row]] = await db.query(sql)
    const n = Number(row.n)
    if (n) bad++
    console.log(`  ${n === 0 ? 'PASS' : '**FAIL**'}  ${label}${n ? `  — ${n.toLocaleString()} drifting` : ''}`)
  }
  return bad
}

async function summarise(db) {
  const tables = ['products', 'customers', 'suppliers', 'sales_documents',
    'sales_document_lines', 'sales_tenders', 'stock_movements',
    'purchase_documents', 'purchase_document_lines',
    'customer_transactions', 'supplier_transactions']
  console.log('\nRow counts:')
  let total = 0
  for (const t of tables) {
    const [[row]] = await db.query(`SELECT COUNT(*) AS n FROM \`${t}\``)
    total += Number(row.n)
    console.log(`  ${t.padEnd(26)} ${Number(row.n).toLocaleString().padStart(14)}`)
  }
  console.log(`  ${'TOTAL'.padEnd(26)} ${total.toLocaleString().padStart(14)}`)
  const [[size]] = await db.query(`
    SELECT ROUND(SUM(data_length + index_length)/1024/1024, 1) AS mb
      FROM information_schema.tables WHERE table_schema = DATABASE()`)
  console.log(`\n  on disk: ${size.mb} MB`)
}

// ── Main ───────────────────────────────────────────────────────────────
async function main() {
  const db = await connect()
  console.log(`site ${siteId} -> ${db.config.database}@${db.config.host}\n`)

  if (has('wipe')) {
    await wipe(db)
    if (!has('docs') && !argv.some((a) => a.startsWith('--docs='))) { await db.end(); return }
  }

  // Speed knobs. Every one is a DURABILITY trade — correct for a scratch load,
  // wrong for anything you cannot regenerate. Restored in the finally block.
  const [[orig]] = await db.query(
    `SELECT @@unique_checks AS uc, @@foreign_key_checks AS fk, @@autocommit AS ac`)
  await db.query('SET unique_checks=0, foreign_key_checks=0, autocommit=1')
  const [[bufPool]] = await db.query(`SELECT @@innodb_buffer_pool_size AS b, @@max_allowed_packet AS p`)
  const poolMb = Number(bufPool.b) / 1024 / 1024
  if (poolMb < 512 && CFG.docs > 200_000) {
    console.log(`WARNING: innodb_buffer_pool_size is ${poolMb.toFixed(0)}MB.`)
    console.log(`  At ${CFG.docs.toLocaleString()} documents that will thrash. Set it to 2G+ in my.ini and restart MySQL.\n`)
  }
  // A batch of documents expands to several thousand line rows in one packet.
  // Better to say so now than to fail with a broken pipe an hour in.
  const packetMb = Number(bufPool.p) / 1024 / 1024
  if (packetMb < 16 && CFG.batch > 500) {
    console.log(`WARNING: max_allowed_packet is ${packetMb.toFixed(0)}MB — small for a batch of ${CFG.batch}.`)
    console.log(`  If a batch fails with a packet error, re-run with --batch=500.\n`)
  }

  try {
    // Fixtures the generated rows point at.
    const [[vatS]] = await db.query(`SELECT id, rate FROM vat_rates WHERE vat_type='sales' AND is_default=1 LIMIT 1`)
    const [[vatP]] = await db.query(`SELECT id FROM vat_rates WHERE vat_type='purchase' AND is_default=1 LIMIT 1`)
    const [[struct]] = await db.query(`SELECT id FROM price_structures WHERE is_default=1 LIMIT 1`)
    const [locs] = await db.query(`SELECT id, is_main FROM stock_locations WHERE is_active=1 ORDER BY is_main DESC, id`)
    if (!locs.length) { console.error('No stock locations — run site-migrate first.'); process.exit(1) }
    const mainLocation = locs[0].id
    const locationIds = locs.map((l) => l.id)
    const vatRate = Number(vatS?.rate ?? 15)

    const [tenders] = await db.query(`SELECT id, code, name FROM tender_types WHERE is_active=1`)

    let [terminals] = await db.query(`SELECT id, code FROM terminals`)
    if (!terminals.length) {
      for (let i = 1; i <= 4; i++) {
        await db.query(`INSERT INTO terminals (code, name, location) VALUES (?,?,?)`,
          [`TILL${pad(i, 2)}`, `Till ${i}`, 'Front counter'])
      }
      ;[terminals] = await db.query(`SELECT id, code FROM terminals`)
    }

    const [seqRows] = await db.query(`SELECT doc_type, next_number FROM document_sequences`)
    const startNo = Object.fromEntries(seqRows.map((r) => [r.doc_type, Number(r.next_number)]))

    const deptIds = await seedDepartments(db)
    const brandIds = await seedBrands(db)
    const products = await seedProducts(db, deptIds, brandIds, vatS.id, vatP?.id ?? vatS.id, struct.id, locationIds)
    const customers = await seedCustomers(db, struct.id)
    const suppliers = await seedSuppliers(db)
    await linkProductSuppliers(db, products, suppliers)
    await seedPurchasing(db, products, suppliers, vatRate, mainLocation, startNo)
    await seedSales(db, products, customers, tenders, vatRate, mainLocation, terminals, startNo)
    await seedCustomerPayments(db, customers)

    await reconcile(db)
    const bad = await verify(db)
    await summarise(db)
    console.log(`\nDone in ${hhmmss(Date.now() - t0)}.`)
    if (bad) { console.log(`${bad} invariant(s) failed — the data is not internally consistent.`); process.exitCode = 1 }
  } finally {
    await db.query(`SET unique_checks=${orig.uc}, foreign_key_checks=${orig.fk}`)
    await db.end()
  }
}

main().catch((e) => { console.error('\n' + e.stack); process.exit(1) })
