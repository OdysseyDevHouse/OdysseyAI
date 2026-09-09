// Wipe every product except PRD00021..PRD00025 and every department except
// 'Toasties' (the department of the kept toastie) from the Tiaan VM trading DB.
//
//   node --env-file=.env.local scratch/site4-wipe.mjs          # dry run
//   node --env-file=.env.local scratch/site4-wipe.mjs --apply  # commit
import mysql from 'mysql2/promise'

const APPLY = process.argv.includes('--apply')
const KEEP_CODES = ['PRD00021', 'PRD00022', 'PRD00023', 'PRD00024', 'PRD00025']
const KEEP_DEPT = 42

const conn = await mysql.createConnection({
  host: process.env.ODYSSEY_SITE_DB_HOST, port: Number(process.env.ODYSSEY_SITE_DB_PORT),
  user: process.env.ODYSSEY_SITE_DB_USER, password: process.env.ODYSSEY_SITE_DB_PASSWORD,
  database: process.env.ODYSSEY_SITE_DB_NAME, connectTimeout: 10000,
})

await conn.beginTransaction()
try {
  const [keepRows] = await conn.query(`SELECT id, code FROM products WHERE code IN (?) FOR UPDATE`, [KEEP_CODES])
  if (keepRows.length !== KEEP_CODES.length) {
    throw new Error(`expected ${KEEP_CODES.length} keeper products, found ${keepRows.length}: ${keepRows.map(r => r.code).join(',')}`)
  }
  const keep = keepRows.map(r => r.id)
  console.log('keeping products', keepRows.map(r => `${r.code}#${r.id}`).join(' '))

  const [[dept]] = await conn.query(`SELECT id, name FROM departments WHERE id = ?`, [KEEP_DEPT])
  if (!dept) throw new Error(`department ${KEEP_DEPT} not found`)
  console.log('keeping department', `${dept.name}#${dept.id}`)

  const run = async (label, sql, params) => {
    const [res] = await conn.query(sql, params)
    if (res.affectedRows) console.log(`  ${label}: ${res.affectedRows}`)
    return res.affectedRows
  }

  // ── clear the ON DELETE RESTRICT references to the doomed products ──
  await run('products.parent_id -> NULL', `UPDATE products SET parent_id = NULL WHERE parent_id IS NOT NULL AND parent_id NOT IN (?)`, [keep])
  await run('product_refers', `DELETE FROM product_refers WHERE product_id NOT IN (?) OR target_id NOT IN (?)`, [keep, keep])
  await run('product_recipes', `DELETE FROM product_recipes WHERE parent_id NOT IN (?) OR component_id NOT IN (?)`, [keep, keep])
  for (const t of ['stock_movements', 'stock_adjustment_lines', 'stock_take_lines', 'stock_transfer_lines',
                   'job_card_lines', 'job_headline_parts', 'manufacturing_order_lines', 'manufacturing_orders']) {
    await run(t, `DELETE FROM \`${t}\` WHERE product_id NOT IN (?)`, [keep])
  }

  const products = await run('products', `DELETE FROM products WHERE id NOT IN (?)`, [keep])

  // ── departments: parent_id is RESTRICT, so unparent before deleting ──
  await run('departments.parent_id -> NULL', `UPDATE departments SET parent_id = NULL WHERE parent_id IS NOT NULL AND id <> ?`, [KEEP_DEPT])
  const departments = await run('departments', `DELETE FROM departments WHERE id <> ?`, [KEEP_DEPT])

  const [[p]] = await conn.query('SELECT COUNT(*) n FROM products')
  const [[d]] = await conn.query('SELECT COUNT(*) n FROM departments')
  console.log(`\ndeleted ${products} products, ${departments} departments`)
  console.log(`remaining: ${p.n} products, ${d.n} departments`)

  if (APPLY) { await conn.commit(); console.log('\nCOMMITTED') }
  else { await conn.rollback(); console.log('\nDRY RUN - rolled back (pass --apply to commit)') }
} catch (err) {
  await conn.rollback()
  console.error('\nROLLED BACK:', err.message)
  process.exitCode = 1
}
await conn.end()
