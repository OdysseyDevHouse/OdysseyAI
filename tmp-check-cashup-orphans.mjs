// Counts cashup journal batches whose shift no longer exists (test litter check).
import mysql from 'mysql2/promise'
for (const db of ['ody10000_master', 'ody10001_master']) {
  const c = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: db,
  })
  const [r] = await c.query(
    `SELECT COUNT(1) AS n FROM journal_batches b
      WHERE b.source = 'cashup'
        AND NOT EXISTS (SELECT 1 FROM shifts s WHERE s.id = b.source_doc_id)`,
  )
  console.log(`${db}: ${r[0].n} orphan cashup batch(es)`)
  await c.end()
}
