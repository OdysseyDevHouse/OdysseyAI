import mysql from 'mysql2/promise'
const conn = await mysql.createConnection({
  host: process.env.ODYSSEY_SITE_DB_HOST, port: Number(process.env.ODYSSEY_SITE_DB_PORT),
  user: process.env.ODYSSEY_SITE_DB_USER, password: process.env.ODYSSEY_SITE_DB_PASSWORD,
  database: process.env.ODYSSEY_SITE_DB_NAME, connectTimeout: 10000,
})
const KEEP = ['PRD00021','PRD00022','PRD00023','PRD00024','PRD00025']
const [keep] = await conn.query(
  `SELECT p.id, p.code, p.description, p.product_type, p.is_manufactured, p.department_id, d.name AS dept, p.parent_id, p.has_variants
   FROM products p LEFT JOIN departments d ON d.id = p.department_id
   WHERE p.code IN (?) ORDER BY p.code`, [KEEP])
console.table(keep)
const [recipes] = await conn.query(
  `SELECT r.parent_id, pp.code AS parent_code, pp.description AS parent_desc, r.component_id, pc.code AS comp_code, pc.description AS comp_desc
   FROM product_recipes r JOIN products pp ON pp.id = r.parent_id JOIN products pc ON pc.id = r.component_id`)
console.log('product_recipes:'); console.table(recipes)
const [refers] = await conn.query(
  `SELECT r.product_id, ps.code AS from_code, r.target_id, pt.code AS to_code
   FROM product_refers r JOIN products ps ON ps.id = r.product_id JOIN products pt ON pt.id = r.target_id`)
console.log('product_refers:'); console.table(refers)
const [kids] = await conn.query(`SELECT id, code, description, parent_id FROM products WHERE parent_id IS NOT NULL`)
console.log('variant children:'); console.table(kids)
await conn.end()
