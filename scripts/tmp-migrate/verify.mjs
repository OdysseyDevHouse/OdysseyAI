import mysql from 'mysql2/promise';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
const c = await mysql.createConnection({host:'localhost',port:3306,user:'root',password:'Odyssey5204!',database:'ody27995_demo_master'});
const s = await mysql.createConnection({host:'localhost',port:3306,user:'root',password:'Odyssey5204!',database:'ody27995_stockfile'});

const q = async (conn,sql)=>{ const [r]=await conn.query(sql); return r };
console.log('=== COUNTS: target vs source ===');
const pairs = [
  ['products', 'SELECT COUNT(*) n FROM products', 'SELECT COUNT(*) n FROM tblstockrecord'],
  ['departments', 'SELECT COUNT(*) n FROM departments', 'SELECT (SELECT COUNT(*) FROM tbldepartments_major)+(SELECT COUNT(*) FROM tbldepartments_sub1)+(SELECT COUNT(*) FROM tbldepartments_sub2) n'],
  ['prices', 'SELECT COUNT(*) n FROM product_prices', 'SELECT COUNT(*) n FROM tblstockprices'],
  ['product images', 'SELECT COUNT(*) n FROM product_images', "SELECT COUNT(*) n FROM tblstockproperties WHERE Picture IS NOT NULL AND LENGTH(Picture)>0"],
];
for (const [label,tq,sq] of pairs) {
  const [[t]]=await c.query(tq); const [[so]]=await s.query(sq);
  console.log(`${label.padEnd(16)} target=${String(t.n).padStart(5)}  source=${String(so.n).padStart(5)}  ${t.n===so.n?'OK':'DIFF'}`);
}
const [[di]]=await c.query('SELECT COUNT(*) n FROM storefront_images');
const [[dl]]=await c.query('SELECT COUNT(*) n FROM departments WHERE pos_image_id IS NOT NULL');
console.log(`dept images      target=${di.n}  linked=${dl.n}`);
const [[pls]]=await c.query('SELECT COUNT(*) n FROM product_location_stock');
console.log(`location stock   ${pls.n}`);

console.log('\n=== DEPARTMENT TREE (top level, with colour + picture) ===');
const [tree]=await c.query(`SELECT d.id,d.name,d.code,d.color,d.sort_order, (SELECT COUNT(*) FROM departments k WHERE k.parent_id=d.id) kids, (SELECT COUNT(*) FROM products p WHERE p.department_id=d.id) prods, d.pos_image_id FROM departments d WHERE d.parent_id IS NULL ORDER BY d.sort_order`);
console.table(tree);

console.log('\n=== SAMPLE PRODUCTS ===');
const [sp]=await c.query(`SELECT p.id,p.code,p.description,d.name dept,p.product_type,p.last_cost,p.stock_on_hand,
 (SELECT selling_price_incl FROM product_prices pp WHERE pp.product_id=p.id AND pp.price_structure_id=1) retail,
 (SELECT selling_price_incl FROM product_prices pp WHERE pp.product_id=p.id AND pp.price_structure_id=2) wholesale,
 p.image_path IS NOT NULL haspic, p.image_color
 FROM products p LEFT JOIN departments d ON d.id=p.department_id ORDER BY p.id LIMIT 10`);
console.table(sp);

console.log('\n=== SPECIAL TYPES ===');
const [st]=await c.query("SELECT product_type, COUNT(*) n FROM products GROUP BY 1");
console.table(st);
const [rf]=await c.query(`SELECT p.code src, t.code tgt, r.factor, r.method FROM product_refers r JOIN products p ON p.id=r.product_id JOIN products t ON t.id=r.target_id`);
console.table(rf);

console.log('\n=== IMAGE FILES ON DISK ===');
const [imgs]=await c.query('SELECT stored_name, size_bytes FROM product_images ORDER BY RAND() LIMIT 5');
const root = path.resolve('uploads');
for (const i of imgs) {
  const f = path.join(root,i.stored_name);
  const ok = existsSync(f); const sz = ok?statSync(f).size:0;
  console.log(`  ${i.stored_name}  db=${i.size_bytes}  disk=${sz}  ${ok&&sz===Number(i.size_bytes)?'OK':'MISMATCH'}`);
}
const [dimgs]=await c.query('SELECT stored_name,size_bytes FROM storefront_images LIMIT 3');
for (const i of dimgs) {
  const f = path.join(root,i.stored_name); const ok=existsSync(f);
  console.log(`  dept ${i.stored_name}  ${ok?'OK':'MISSING'}`);
}
// missing files across the board
const [all]=await c.query('SELECT stored_name FROM product_images');
let missing=0; for(const a of all){ if(!existsSync(path.join(root,a.stored_name))) missing++ }
console.log(`  product image files missing: ${missing} of ${all.length}`);
await c.end(); await s.end();
