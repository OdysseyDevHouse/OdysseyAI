// Marks a product sold out in the database, then checks the SHOP says so.
//
//   node --env-file=.env scripts/verify-shop-soldout.mjs <storeToken> <productId>
//
// The back-office half is covered by verify-sold-out.mjs. This is the other
// half: a shopper must be told on the product page, not at the checkout button.
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import mysql from 'mysql2/promise'

const BASE = process.env.APP_URL || 'http://localhost:4100'
const TOKEN = process.argv[2]
const PRODUCT_ID = Number(process.argv[3])
const DB = process.env.SHOP_DB || 'ody10001_master'
const PORT = 9337

if (!TOKEN || !Number.isInteger(PRODUCT_ID)) {
  console.error('Usage: verify-shop-soldout.mjs <storeToken> <productId>')
  process.exit(1)
}

const db = await mysql.createConnection({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: DB,
})

const profile = path.join(tmpdir(), `ody-shopsold-${Date.now()}`)
mkdirSync(profile, { recursive: true })
const chrome = spawn(
  process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ],
  { stdio: 'ignore' },
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function target() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page')
      if (page) return page.webSocketDebuggerUrl
    } catch {
      /* not up yet */
    }
    await sleep(250)
  }
  throw new Error('Chrome did not start')
}

let id = 0
function rpc(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const mine = ++id
    const onMessage = (e) => {
      const msg = JSON.parse(e.data)
      if (msg.id !== mine) return
      ws.removeEventListener('message', onMessage)
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
    }
    ws.addEventListener('message', onMessage)
    ws.send(JSON.stringify({ id: mine, method, params }))
  })
}

async function text(ws, url) {
  await rpc(ws, 'Page.navigate', { url })
  await sleep(3500)
  const res = await rpc(ws, 'Runtime.evaluate', {
    expression: 'document.body.innerText',
    returnByValue: true,
  })
  return String(res.result.value ?? '')
}

let fails = 0
const ok = (label, cond, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

async function main() {
  const ws = new WebSocket(await target())
  await new Promise((r) => ws.addEventListener('open', r, { once: true }))
  await rpc(ws, 'Page.enable')
  await rpc(ws, 'Runtime.enable')

  const url = `${BASE}/store/${TOKEN}/p/${PRODUCT_ID}`

  console.log('\n— On the menu —')
  const before = await text(ws, url)
  ok('the product page loads', before.length > 40, before.slice(0, 50).replace(/\n/g, ' | '))
  ok('nothing says sold out', !/back tomorrow/i.test(before))

  console.log('\n— Marked off for today —')
  await db.query(
    `INSERT INTO online_product_availability (product_id, unavailable_until, note)
          VALUES (?, CURDATE(), 'Back tomorrow')
     ON DUPLICATE KEY UPDATE unavailable_until = CURDATE(), note = 'Back tomorrow'`,
    [PRODUCT_ID],
  )
  const after = await text(ws, url)
  // The whole point: said HERE, not at the checkout button.
  ok('the shop says so on the product page', /back tomorrow/i.test(after))
  ok('and the Add button is not offered', !/\badd to basket\b/i.test(after), 'add button gone')

  console.log('\n— Back on the menu —')
  await db.query('DELETE FROM online_product_availability WHERE product_id = ?', [PRODUCT_ID])
  const restored = await text(ws, url)
  ok('the note is gone', !/back tomorrow/i.test(restored))

  const [left] = await db.query('SELECT COUNT(*) AS n FROM online_product_availability')
  ok('nothing left behind', Number(left[0].n) === 0, String(left[0].n))

  ws.close()
  console.log(fails === 0 ? '\nAll shop sold-out checks passed.' : `\n${fails} FAILED.`)
  process.exitCode = fails === 0 ? 0 : 1
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(async () => {
    chrome.kill()
    await db.end().catch(() => {})
    try {
      rmSync(profile, { recursive: true, force: true })
    } catch {
      /* tmp profile */
    }
  })
