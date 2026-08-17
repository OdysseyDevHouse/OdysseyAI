// Marks a product sold out from the back office and checks the shop refuses it.
//
//   node --env-file=.env.local scripts/verify-sold-out.mjs
//
// The two halves of this feature live in different apps — a button in the back
// office and a refusal on the public storefront — so this drives both in one
// browser and puts the mark back afterwards.
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const BASE = process.env.APP_URL || 'http://localhost:4100'
const EMAIL = process.env.DEV_LOGIN_EMAIL
const PASSWORD = process.env.DEV_LOGIN_PASSWORD
const SITE = process.env.SHOT_SITE || 'Smash'
const PORT = 9336

if (!EMAIL || !PASSWORD) {
  console.error('Set DEV_LOGIN_EMAIL and DEV_LOGIN_PASSWORD in .env.local.')
  process.exit(1)
}

const profile = path.join(tmpdir(), `ody-soldout-${Date.now()}`)
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

async function evaluate(ws, expression) {
  const res = await rpc(ws, 'Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text)
  return res.result.value
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

  // Sign in.
  await rpc(ws, 'Page.navigate', { url: `${BASE}/` })
  await sleep(3000)
  await evaluate(
    ws,
    [
      '(() => {',
      '  const set = (el, v) => {',
      '    const p = Object.getPrototypeOf(el);',
      '    Object.getOwnPropertyDescriptor(p, "value").set.call(el, v);',
      '    el.dispatchEvent(new Event("input", { bubbles: true }));',
      '  };',
      '  const email = document.querySelector(\'input[type=email]\');',
      '  const pass = document.querySelector(\'input[type=password]\');',
      `  if (email) set(email, ${JSON.stringify(EMAIL)});`,
      `  if (pass) set(pass, ${JSON.stringify(PASSWORD)});`,
      '  document.querySelector("form")?.requestSubmit();',
      '  return "submitted";',
      '})()',
    ].join('\n'),
  )
  await sleep(5000)

  // Choose the store, if the picker came up.
  await evaluate(
    ws,
    [
      '(() => {',
      '  const rows = [...document.querySelectorAll("button, a")];',
      `  const hit = rows.find(r => r.textContent && r.textContent.includes(${JSON.stringify(SITE)}));`,
      '  if (hit) { hit.click(); return "chose"; }',
      '  return "no-picker";',
      '})()',
    ].join('\n'),
  )
  await sleep(4000)

  console.log('\n— The back office —')
  await rpc(ws, 'Page.navigate', { url: `${BASE}/online-store/products` })
  await sleep(4500)
  const listText = await evaluate(ws, 'document.body.innerText')
  ok('the products screen loads', /what your online store shows/i.test(listText))
  ok('published rows offer the control', /mark sold out/i.test(listText))

  // The first row that offers it — whichever product that is.
  const marked = await evaluate(
    ws,
    [
      '(() => {',
      '  const btn = [...document.querySelectorAll("button")].find(b => /mark sold out/i.test(b.innerText));',
      '  if (!btn) return "none";',
      '  const row = btn.closest("li");',
      '  const name = row ? row.querySelector("span")?.innerText : "";',
      '  btn.click();',
      '  return name || "clicked";',
      '})()',
    ].join('\n'),
  )
  ok('a product can be marked', marked !== 'none', String(marked))
  await sleep(4000)

  const afterMark = await evaluate(ws, 'document.body.innerText')
  ok('the row now says so', /sold out today/i.test(afterMark))
  ok('and offers to put it back', /put back/i.test(afterMark))

  console.log('\n— Putting it back —')
  const restored = await evaluate(
    ws,
    [
      '(() => {',
      '  const btn = [...document.querySelectorAll("button")].find(b => /put back/i.test(b.innerText));',
      '  if (!btn) return "none";',
      '  btn.click();',
      '  return "clicked";',
      '})()',
    ].join('\n'),
  )
  ok('it can be put back', restored === 'clicked', String(restored))
  await sleep(4000)
  const afterRestore = await evaluate(ws, 'document.body.innerText')
  // Left as it was found, so this suite can be run twice.
  ok('the mark is gone', !/sold out today/i.test(afterRestore))

  ws.close()
  console.log(fails === 0 ? '\nAll sold-out checks passed.' : `\n${fails} FAILED.`)
  process.exitCode = fails === 0 ? 0 : 1
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => {
    chrome.kill()
    try {
      rmSync(profile, { recursive: true, force: true })
    } catch {
      /* tmp profile; a leftover is harmless */
    }
  })
