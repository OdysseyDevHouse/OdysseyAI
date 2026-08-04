// Development seed: one store, two logins, VAT rates, departments and a small
// amount of master data so every screen has something to show.
//
// Safe to re-run — every insert is keyed on a natural code and skipped if the
// row already exists. It never touches a store it didn't create.
import { randomBytes, scrypt as scryptCb } from 'node:crypto'
import { promisify } from 'node:util'
import mysql from 'mysql2/promise'

const scrypt = promisify(scryptCb)

// Must match src/lib/password.ts — same format, same key length.
async function hashPassword(plain) {
  const salt = randomBytes(16)
  const derived = await scrypt(plain, salt, 64)
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`
}

const DEV_PASSWORD = process.env.SEED_PASSWORD || 'Odyssey#2026'

const db = await mysql.createConnection({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'odysseyai',
})

async function upsert(table, matchCols, row) {
  const where = matchCols.map((c) => `${c} = ?`).join(' AND ')
  const [found] = await db.query(
    `SELECT id FROM ${table} WHERE ${where} LIMIT 1`,
    matchCols.map((c) => row[c]),
  )
  if (found.length) return found[0].id

  const cols = Object.keys(row)
  const [res] = await db.query(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    cols.map((c) => row[c]),
  )
  return res.insertId
}

// ── Store ────────────────────────────────────────────────────────────────
const storeId = await upsert('stores', ['code'], {
  code: 'DEMO',
  name: 'Demo Store',
  trading_name: 'Odyssey Demo',
  email: 'demo@odysseyai.local',
  city: 'Cape Town',
  currency: 'ZAR',
})
console.log(`[seed] store #${storeId}`)

// ── Users ────────────────────────────────────────────────────────────────
const hash = await hashPassword(DEV_PASSWORD)

await upsert('users', ['email'], {
  store_id: null,
  email: 'admin@odysseyai.local',
  password_hash: hash,
  name: 'Platform Admin',
  role: 'platform_admin',
})

await upsert('users', ['email'], {
  store_id: storeId,
  email: 'owner@odysseyai.local',
  password_hash: hash,
  name: 'Demo Owner',
  role: 'owner',
})
console.log('[seed] users')

// ── VAT rates ────────────────────────────────────────────────────────────
const vatStandard = await upsert('vat_rates', ['store_id', 'code'], {
  store_id: storeId,
  code: 'STD',
  name: 'Standard rate',
  rate: '15.000',
  is_default: 1,
})
await upsert('vat_rates', ['store_id', 'code'], {
  store_id: storeId,
  code: 'ZERO',
  name: 'Zero rated',
  rate: '0.000',
  is_default: 0,
})
console.log('[seed] vat rates')

// ── Departments ──────────────────────────────────────────────────────────
const deptDefs = [
  { code: 'GROC', name: 'Groceries', color: '#2f6fed' },
  { code: 'BEV', name: 'Beverages', color: '#0f7b4f' },
  { code: 'BAKE', name: 'Bakery', color: '#b5730a' },
]
const depts = {}
for (const [i, d] of deptDefs.entries()) {
  depts[d.code] = await upsert('departments', ['store_id', 'code'], {
    store_id: storeId,
    code: d.code,
    name: d.name,
    color: d.color,
    sort_order: i,
  })
}
console.log('[seed] departments')

// ── Suppliers ────────────────────────────────────────────────────────────
const supDefs = [
  { code: 'SUP001', name: 'Cape Wholesale Foods', contact_name: 'Riaan Botha', email: 'orders@capewholesale.test', phone: '021 555 0101', payment_terms_days: 30 },
  { code: 'SUP002', name: 'Table Bay Beverages', contact_name: 'Nomsa Dlamini', email: 'sales@tablebaybev.test', phone: '021 555 0202', payment_terms_days: 14 },
]
const sups = {}
for (const s of supDefs) {
  sups[s.code] = await upsert('suppliers', ['store_id', 'code'], { store_id: storeId, ...s })
}
console.log('[seed] suppliers')

// ── Customers ────────────────────────────────────────────────────────────
const custDefs = [
  { code: 'CUST001', name: 'Harbour Cafe', contact_name: 'Lee Adams', email: 'lee@harbourcafe.test', phone: '021 555 0303', credit_limit: '10000.0000', balance: '2450.0000' },
  { code: 'CUST002', name: 'Sunset Guest House', contact_name: 'Thandi Mokoena', email: 'book@sunsetgh.test', phone: '021 555 0404', credit_limit: '5000.0000', balance: '0.0000' },
  { code: 'CUST003', name: 'Mountain Deli', contact_name: 'Pieter van Wyk', email: 'pieter@mountaindeli.test', phone: '021 555 0505', credit_limit: '2000.0000', balance: '2750.0000' },
]
for (const c of custDefs) {
  await upsert('customers', ['store_id', 'code'], { store_id: storeId, ...c })
}
console.log('[seed] customers')

// ── Products ─────────────────────────────────────────────────────────────
const prodDefs = [
  { sku: 'MILK-1L', name: 'Full Cream Milk 1L', dept: 'GROC', sup: 'SUP001', cost: '12.5000', sell: '19.9900', stock: '48.000', reorder: '24.000', barcode: '6001234500011' },
  { sku: 'BREAD-WHT', name: 'White Bread 700g', dept: 'BAKE', sup: 'SUP001', cost: '9.8000', sell: '16.4900', stock: '12.000', reorder: '20.000', barcode: '6001234500028' },
  { sku: 'COKE-330', name: 'Cola Can 330ml', dept: 'BEV', sup: 'SUP002', cost: '6.2000', sell: '11.9900', stock: '240.000', reorder: '96.000', barcode: '6001234500035' },
  { sku: 'WATER-500', name: 'Still Water 500ml', dept: 'BEV', sup: 'SUP002', cost: '3.1000', sell: '7.5000', stock: '8.000', reorder: '48.000', barcode: '6001234500042' },
  { sku: 'RICE-2KG', name: 'Long Grain Rice 2kg', dept: 'GROC', sup: 'SUP001', cost: '32.0000', sell: '54.9900', stock: '30.000', reorder: '12.000', barcode: '6001234500059' },
]

for (const p of prodDefs) {
  const productId = await upsert('products', ['store_id', 'sku'], {
    store_id: storeId,
    sku: p.sku,
    name: p.name,
    department_id: depts[p.dept],
    supplier_id: sups[p.sup],
    vat_rate_id: vatStandard,
    unit: 'each',
    cost_price: p.cost,
    selling_price: p.sell,
    stock_on_hand: p.stock,
    reorder_level: p.reorder,
    reorder_qty: p.reorder,
  })

  await upsert('product_barcodes', ['store_id', 'barcode'], {
    store_id: storeId,
    product_id: productId,
    barcode: p.barcode,
    pack_size: '1.000',
    is_primary: 1,
  })
}
console.log('[seed] products')

await db.end()

console.log('')
console.log('  Seed complete. Sign in at http://localhost:4100/login')
console.log('')
console.log(`    Store owner    owner@odysseyai.local   ${DEV_PASSWORD}`)
console.log(`    Platform admin admin@odysseyai.local   ${DEV_PASSWORD}`)
console.log('')
