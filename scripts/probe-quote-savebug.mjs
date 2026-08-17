// Does saving a quote through the shared editor turn it into an invoice?
//
//   node --env-file=.env.local scripts/probe-quote-savebug.mjs
//
// Reading the code says yes: saveInvoiceAction hardcodes docType:'invoice'
// (invoicing/actions.ts) and saveDraft writes doc_type on UPDATE, not only on
// INSERT. But "the code says so" has been wrong before, so this drives the real
// Save button on a real quote and reads the row back.
//
// It creates its own throwaway quote and removes it afterwards.
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import mysql from 'mysql2/promise'

const EMAIL = process.env.DEV_LOGIN_EMAIL
const PASSWORD = process.env.DEV_LOGIN_PASSWORD
const BASE = process.env.APP_URL || 'http://localhost:4100'
const PORT = 9336

if (!EMAIL || !PASSWORD) {
  console.error('Set DEV_LOGIN_EMAIL / DEV_LOGIN_PASSWORD in .env.local')
  process.exit(1)
}

const db = await mysql.createConnection({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.VERIFY_DB || 'ody10000_master',
  timezone: 'Z',
})

// ── A throwaway quote with one line, copied from a real one ────────────────
const [src] = await db.query(
  "SELECT id FROM sales_documents WHERE doc_type='quote' ORDER BY id DESC LIMIT 1",
)
if (!src.length) {
  console.error('No quote on this site to copy from.')
  process.exit(1)
}
const [ins] = await db.execute(
  `INSERT INTO sales_documents
     (doc_type,status,document_date,customer_name,subtotal_excl,vat_total,total_incl,
      user_name,quote_outcome,valid_until,origin)
   VALUES ('quote','draft',CURDATE(),'ZZ_SAVEBUG',86.96,13.04,100,'probe','open',
           DATE_ADD(CURDATE(),INTERVAL 30 DAY),'back_office')`,
)
const quoteId = ins.insertId
await db.execute(
  `INSERT INTO sales_document_lines
     (document_id,line_number,product_id,product_code,description,qty,unit_price_incl,
      discount_pct,discount_incl,vat_rate_pct,line_total_incl,line_total_excl,line_vat,unit_cost_excl)
   SELECT ?,1,product_id,product_code,description,1,100,0,0,15,100,86.96,13.04,10
     FROM sales_document_lines WHERE document_id=? LIMIT 1`,
  [quoteId, src[0].id],
)

console.log(`\nprobe quote ${quoteId} created as doc_type='quote'\n`)

const CHROME =
  process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const profile = path.join(tmpdir(), `odyssey-savebug-${process.pid}`)
mkdirSync(profile, { recursive: true })

const chrome = spawn(
  CHROME,
  [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--headless=new',
    '--no-first-run',
    '--window-size=1600,1200',
    'about:blank',
  ],
  { stdio: 'ignore' },
)

let ws
let nextId = 1
const waiting = new Map()

function send(method, params = {}, sessionId) {
  const id = nextId++
  ws.send(JSON.stringify({ id, method, params, sessionId }))
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject })
    setTimeout(() => waiting.has(id) && reject(new Error(`${method} timed out`)), 30000)
  })
}

async function connect() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      return (await res.json()).webSocketDebuggerUrl
    } catch {
      await new Promise((r) => setTimeout(r, 250))
    }
  }
  throw new Error('Chrome never came up')
}

async function evaluate(sessionId, expression) {
  const result = await send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  )
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? 'page threw')
  }
  return result.result?.value
}

async function goto(sessionId, url) {
  await send('Page.navigate', { url }, sessionId)
  await new Promise((r) => setTimeout(r, 2800))
}

let verdict = 'INCONCLUSIVE'

try {
  const wsUrl = await connect()
  ws = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = reject
  })
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id && waiting.has(msg.id)) {
      const { resolve, reject } = waiting.get(msg.id)
      waiting.delete(msg.id)
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
    }
  }

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  await send('Page.enable', {}, sessionId)
  await send('Runtime.enable', {}, sessionId)

  await goto(sessionId, `${BASE}/login`)
  await evaluate(
    sessionId,
    `(() => {
      const set = (el, v) => {
        const proto = Object.getPrototypeOf(el);
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      set(document.querySelector('input[type=email], input[name=email]'), ${JSON.stringify(EMAIL)});
      set(document.querySelector('input[type=password]'), ${JSON.stringify(PASSWORD)});
      document.querySelector('form').requestSubmit();
      return true;
    })()`,
  )
  await new Promise((r) => setTimeout(r, 3500))
  await evaluate(
    sessionId,
    `(() => {
      const b = [...document.querySelectorAll('button, a')]
        .find(x => /odyssey software ai 1|ODY-10000/i.test(x.textContent || ''));
      if (b) b.click();
      return true;
    })()`,
  )
  await new Promise((r) => setTimeout(r, 2500))

  await goto(sessionId, `${BASE}/invoicing/quotes/${quoteId}`)

  const found = await evaluate(
    sessionId,
    `(() => {
      const btn = [...document.querySelectorAll('button')]
        .find(b => /save \\(draft\\)/i.test(b.textContent || ''));
      if (!btn) return 'no save button';
      btn.click();
      return 'clicked Save (draft)';
    })()`,
  )
  console.log('action:', found)
  await new Promise((r) => setTimeout(r, 3500))

  const [[row]] = await db.query(
    'SELECT doc_type, status FROM sales_documents WHERE id = ?',
    [quoteId],
  )
  console.log(`\nafter saving, doc_type = '${row.doc_type}' (status ${row.status})`)

  if (row.doc_type === 'invoice') {
    verdict = 'CONFIRMED — saving a quote rewrote it to an invoice'
  } else if (row.doc_type === 'quote') {
    verdict = 'NOT REPRODUCED — the quote kept its doc_type'
  }
} catch (error) {
  console.error('PROBE FAILED:', error.message)
  verdict = `FAILED: ${error.message}`
} finally {
  try {
    ws?.close()
  } catch {}
  chrome.kill()

  await db.execute('DELETE FROM sale_deposits WHERE document_id = ?', [quoteId])
  await db.execute('DELETE FROM document_audit WHERE document_id = ?', [quoteId])
  await db.execute('DELETE FROM sales_document_lines WHERE document_id = ?', [quoteId])
  await db.execute('DELETE FROM sales_documents WHERE id = ?', [quoteId])
  const [[left]] = await db.query(
    "SELECT COUNT(*) AS n FROM sales_documents WHERE customer_name = 'ZZ_SAVEBUG'",
  )
  console.log(`cleanup: ${left.n} probe documents left behind`)
  await db.end()
}

console.log(`\nVERDICT: ${verdict}\n`)
