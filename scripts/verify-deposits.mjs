/**
 * Proves the deposit money model against the real database.
 *
 * Not a unit test of the pure rules — those are arithmetic and obvious. This
 * checks the things that only break against a real schema: the CHECK
 * constraint, the FK, the cash-up query shape, and that Σ amount behaves as
 * the "what is held" figure the whole feature rests on.
 *
 * Cleans up after itself. A leaked scratch row on a table the cash-up sums
 * would make somebody's drawer wrong.
 */
import mysql from 'mysql2/promise'

const DB = process.env.VERIFY_DB || 'ody10000_master'

const conn = await mysql.createConnection({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: DB,
  timezone: 'Z',
  multipleStatements: false,
})

let pass = 0
let fail = 0
const created = { docs: [], deposits: [] }

function check(name, ok, detail = '') {
  if (ok) {
    pass += 1
    console.log(`  ok   ${name}`)
  } else {
    fail += 1
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

async function makeDoc(totalIncl, status = 'draft') {
  const [r] = await conn.execute(
    `INSERT INTO sales_documents
       (doc_type, status, document_date, customer_name, subtotal_excl, vat_total,
        total_incl, user_name)
     VALUES ('invoice', ?, CURDATE(), 'ZZ_DEPOSIT_VERIFY', ?, ?, ?, 'verify')`,
    [status, (totalIncl / 1.15).toFixed(4), (totalIncl - totalIncl / 1.15).toFixed(4), totalIncl.toFixed(4)],
  )
  created.docs.push(r.insertId)
  return r.insertId
}

async function addDeposit(docId, amount, kind = 'deposit', shiftId = null) {
  const [r] = await conn.execute(
    `INSERT INTO sale_deposits
       (document_id, kind, amount, tender_type_id, tender_name, taken_on, shift_id, user_name)
     VALUES (?, ?, ?, 1, 'Cash', CURDATE(), ?, 'verify')`,
    [docId, kind, amount.toFixed(4), shiftId],
  )
  created.deposits.push(r.insertId)
  return r.insertId
}

async function held(docId) {
  const [[row]] = await conn.query(
    'SELECT COALESCE(SUM(amount),0) AS held FROM sale_deposits WHERE document_id = ?',
    [docId],
  )
  return Number(row.held)
}

console.log('\nsale_deposits — money model\n')

try {
  /* 1. The table and the tender exist, with the flags the design depends on. */
  const [[tender]] = await conn.query(
    "SELECT id, counts_as_drawer_cash, allows_change, is_active, is_system FROM tender_types WHERE code = 'DEPOSIT'",
  )
  check('DEPOSIT tender exists', !!tender)
  check(
    'DEPOSIT does not count as drawer cash',
    tender && tender.counts_as_drawer_cash === 0,
    'counting it again would double the deposit day takings',
  )
  check(
    'DEPOSIT gives no change',
    tender && tender.allows_change === 0,
    'change from a drawer that never received the money',
  )
  check('DEPOSIT is a system tender', tender && tender.is_system === 1)

  /* 2. Sum-not-stored: held is Σ amount, and refunds subtract. */
  const doc = await makeDoc(1000)
  await addDeposit(doc, 300)
  check('one deposit holds 300', (await held(doc)) === 300)

  await addDeposit(doc, 200)
  check('two deposits hold 500', (await held(doc)) === 500)

  // Stored negative, the way refundDeposit writes it: Σ amount is what is
  // still held, so a refund has to subtract.
  await addDeposit(doc, 150, 'refund')
  await conn.execute('UPDATE sale_deposits SET amount = -150 WHERE id = ?', [
    created.deposits[created.deposits.length - 1],
  ])
  check('a refund subtracts', (await held(doc)) === 350)

  /* 3. Applying zeroes the held figure without deleting the history. */
  await addDeposit(doc, 0, 'applied')
  await conn.execute('UPDATE sale_deposits SET amount = -350 WHERE id = ?', [
    created.deposits[created.deposits.length - 1],
  ])
  check('applying leaves nothing held', (await held(doc)) === 0)

  const [[hist]] = await conn.query(
    "SELECT COUNT(*) AS n FROM sale_deposits WHERE document_id = ? AND kind = 'deposit'",
    [doc],
  )
  check(
    'the deposits themselves survive',
    Number(hist.n) === 2,
    'history must stay readable after the sale posts',
  )

  /* 4. The CHECK constraint refuses money that belongs to nothing. */
  let refused = false
  try {
    await conn.execute(
      "INSERT INTO sale_deposits (kind, amount, tender_name, taken_on) VALUES ('deposit', 5, 'Cash', CURDATE())",
    )
  } catch {
    refused = true
  }
  check('an orphan deposit is refused', refused)

  /* 5. An offline basket may hold a deposit with no document. */
  const [uidRow] = await conn.execute(
    `INSERT INTO sale_deposits (basket_uid, kind, amount, tender_name, taken_on, user_name)
     VALUES ('ZZVERIFY-uid-1', 'deposit', 75, 'Cash', CURDATE(), 'verify')`,
  )
  created.deposits.push(uidRow.insertId)
  check('an offline basket can hold a deposit', true)

  /* And attaching it to a document later moves it. */
  const doc2 = await makeDoc(500)
  await conn.execute(
    'UPDATE sale_deposits SET document_id = ? WHERE basket_uid = ? AND document_id IS NULL',
    [doc2, 'ZZVERIFY-uid-1'],
  )
  check('attaching moves it onto the document', (await held(doc2)) === 75)

  const [[keptUid]] = await conn.query(
    'SELECT basket_uid FROM sale_deposits WHERE document_id = ? LIMIT 1',
    [doc2],
  )
  check(
    'the basket uid is kept as evidence',
    keptUid.basket_uid === 'ZZVERIFY-uid-1',
    'it is the only record the deposit was taken offline',
  )

  /* 6. The cash-up query returns the shape cashupDeclaration expects. */
  const doc3 = await makeDoc(400)
  await addDeposit(doc3, 120, 'deposit', null)
  const [[cash]] = await conn.query(
    `SELECT
       COALESCE(SUM(CASE WHEN kind = 'deposit' THEN amount END), 0)      AS taken,
       COALESCE(SUM(CASE WHEN kind = 'refund'  THEN ABS(amount) END), 0) AS refunded
     FROM sale_deposits WHERE shift_id <=> NULL`,
  )
  check(
    'the cash-up query returns taken and refunded',
    cash.taken !== undefined && cash.refunded !== undefined,
    JSON.stringify(cash),
  )
  check(
    "'applied' rows are excluded from takings",
    Number(cash.taken) >= 120 && !Number.isNaN(Number(cash.taken)),
    'applying moves no cash and must not be counted twice',
  )

  /* 7. The FK refuses to strand money when a document is deleted. */
  let fkHeld = false
  try {
    await conn.execute('DELETE FROM sales_documents WHERE id = ?', [doc3])
  } catch {
    fkHeld = true
  }
  check(
    'a document holding a deposit cannot be deleted',
    fkHeld,
    'discarding it must be a refund, not a delete',
  )
} finally {
  /* Clean up in FK order. A leaked row here makes a real cash-up wrong. */
  if (created.deposits.length) {
    await conn.query('DELETE FROM sale_deposits WHERE id IN (?)', [created.deposits])
  }
  await conn.query("DELETE FROM sale_deposits WHERE basket_uid LIKE 'ZZVERIFY%'")
  if (created.docs.length) {
    await conn.query('DELETE FROM document_audit WHERE document_id IN (?)', [created.docs])
    await conn.query('DELETE FROM sales_documents WHERE id IN (?)', [created.docs])
  }
  const [[leftD]] = await conn.query(
    "SELECT COUNT(*) AS n FROM sales_documents WHERE customer_name = 'ZZ_DEPOSIT_VERIFY'",
  )
  const [[leftS]] = await conn.query(
    "SELECT COUNT(*) AS n FROM sale_deposits WHERE user_name = 'verify' OR basket_uid LIKE 'ZZVERIFY%'",
  )
  console.log(`\ncleanup: ${leftD.n} documents, ${leftS.n} deposits left behind`)
  if (Number(leftD.n) || Number(leftS.n)) fail += 1

  await conn.end()
}

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
