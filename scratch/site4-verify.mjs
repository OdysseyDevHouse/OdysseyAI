import mysql from 'mysql2/promise'
const conn = await mysql.createConnection({
  host: process.env.ODYSSEY_SITE_DB_HOST, port: Number(process.env.ODYSSEY_SITE_DB_PORT),
  user: process.env.ODYSSEY_SITE_DB_USER, password: process.env.ODYSSEY_SITE_DB_PASSWORD,
  database: process.env.ODYSSEY_SITE_DB_NAME, connectTimeout: 10000,
})
const [prods] = await conn.query(
  `SELECT p.id, p.code, p.description, p.product_type, p.department_id, d.name AS dept, p.stock_on_hand
   FROM products p LEFT JOIN departments d ON d.id = p.department_id ORDER BY p.code`)
console.table(prods)
const [depts] = await conn.query('SELECT id, code, name, parent_id FROM departments')
console.table(depts)
const after = {}
for (const t of ['product_prices','product_location_stock','product_images','product_suppliers',
                 'stock_movements','stock_take_lines','stock_adjustment_lines',
                 'sales_document_lines','purchase_document_lines','special_items','price_schedule_lines']) {
  const [[r]] = await conn.query(`SELECT COUNT(*) n FROM \`${t}\``)
  after[t] = r.n
}
// documents that survived but lost their product link
const [[sl]] = await conn.query('SELECT COUNT(*) n FROM sales_document_lines WHERE product_id IS NULL')
const [[pl]] = await conn.query('SELECT COUNT(*) n FROM purchase_document_lines WHERE product_id IS NULL')
console.log('row counts after:', after)
console.log(`orphaned (product_id NULL): sales_document_lines ${sl.n}, purchase_document_lines ${pl.n}`)
await conn.end()
