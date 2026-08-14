// One-time sweep: removes cashup journal batches whose shift is gone (test
// litter from suites that predate the 133 cleanup), then repairs balances.
import mysql from 'mysql2/promise'
for (const db of ['ody10000_master', 'ody10001_master']) {
  const c = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: db,
  })
  const [rows] = await c.query(
    `SELECT id FROM journal_batches b
      WHERE b.source = 'cashup'
        AND NOT EXISTS (SELECT 1 FROM shifts s WHERE s.id = b.source_doc_id)`,
  )
  for (const r of rows) {
    await c.query('DELETE FROM journal_lines WHERE batch_id = ?', [r.id])
    await c.query('DELETE FROM journal_batches WHERE id = ?', [r.id])
  }
  if (rows.length > 0) {
    await c.query(
      `UPDATE gl_accounts a
          SET a.balance = COALESCE((
                SELECT SUM(l.amount) FROM journal_lines l
                  JOIN journal_batches b ON b.id = l.batch_id
                 WHERE l.account_id = a.id AND b.status = 'posted'
              ), 0)`,
    )
  }
  console.log(`${db}: swept ${rows.length}`)
  await c.end()
}
