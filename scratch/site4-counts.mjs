import mysql from 'mysql2/promise'
const conn = await mysql.createConnection({
  host: process.env.ODYSSEY_SITE_DB_HOST, port: Number(process.env.ODYSSEY_SITE_DB_PORT),
  user: process.env.ODYSSEY_SITE_DB_USER, password: process.env.ODYSSEY_SITE_DB_PASSWORD,
  database: process.env.ODYSSEY_SITE_DB_NAME, connectTimeout: 10000,
})
const blockers = [
  ['job_card_lines','product_id'], ['job_headline_parts','product_id'],
  ['manufacturing_orders','product_id'], ['manufacturing_order_lines','product_id'],
  ['product_recipes','component_id'], ['product_refers','target_id'],
  ['stock_adjustment_lines','product_id'], ['stock_movements','product_id'],
  ['stock_take_lines','product_id'], ['stock_transfer_lines','product_id'],
]
console.log('RESTRICT blockers (rows with a non-null reference):')
for (const [t, c] of blockers) {
  const [[r]] = await conn.query(`SELECT COUNT(*) n FROM \`${t}\` WHERE \`${c}\` IS NOT NULL`)
  console.log(`  ${t}.${c}: ${r.n}`)
}
const [[p]] = await conn.query('SELECT COUNT(*) n FROM products')
const [[d]] = await conn.query('SELECT COUNT(*) n FROM departments')
const [[sl]] = await conn.query('SELECT COUNT(*) n FROM sales_document_lines')
const [[pl]] = await conn.query('SELECT COUNT(*) n FROM purchase_document_lines')
console.log(`\nproducts: ${p.n}   departments: ${d.n}`)
console.log(`sales_document_lines: ${sl.n}   purchase_document_lines: ${pl.n}  (both SET NULL — lines survive, link cleared)`)
const [depts] = await conn.query('SELECT id, code, name, parent_id FROM departments ORDER BY id')
console.table(depts)
await conn.end()
