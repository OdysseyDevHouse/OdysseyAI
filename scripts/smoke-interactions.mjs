// Screens that have to be *used*, not just loaded.
//
//   node --env-file=.env --env-file=.env.local scripts/smoke-interactions.mjs
//
// The route crawl in smoke-routes.mjs proves a screen renders. It cannot prove
// a screen behaves: a PinPad that submits the same PIN on a loop renders
// perfectly and clocks somebody in and out twice a second. That bug shipped —
// the auto-submit effect re-fired every time `busy` went back to false, because
// the entered PIN was still sitting in state — so the behaviour has a test.
//
// Chrome is driven over the DevTools protocol, the same way screenshot.mjs
// does it, so this needs no browser toolchain installed.
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const EMAIL = process.env.DEV_LOGIN_EMAIL
const PASSWORD = process.env.DEV_LOGIN_PASSWORD
const BASE = process.env.APP_URL || 'http://localhost:4100'
const PORT = Number(process.env.CDP_PORT || 9345)
const CHROME =
  process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

const jsonAt = (() => {
  const i = process.argv.indexOf('--json')
  return i === -1 ? null : process.argv[i + 1]
})()

if (!EMAIL || !PASSWORD) {
  console.error('Set DEV_LOGIN_EMAIL and DEV_LOGIN_PASSWORD in .env.local.')
  process.exit(1)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
function record(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
}

// ── Chrome ──────────────────────────────────────────────────────────────
const profile = path.join(tmpdir(), `odyssey-interactions-${process.pid}`)
mkdirSync(profile, { recursive: true })
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    `--user-data-dir=${profile}`,
    '--window-size=1600,1000',
    'about:blank',
  ],
  { stdio: 'ignore' },
)
process.on('exit', () => {
  try { chrome.kill() } catch {}
  try { rmSync(profile, { recursive: true, force: true }) } catch {}
})

async function devtoolsUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      if (r.ok) return (await r.json()).webSocketDebuggerUrl
    } catch {}
    await sleep(250)
  }
  throw new Error('Chrome did not expose a debugging port')
}

let ws
let sessionId
let id = 0
const pending = new Map()
const send = (method, params = {}, sid) =>
  new Promise((resolve, reject) => {
    const n = ++id
    pending.set(n, { resolve, reject })
    ws.send(JSON.stringify({ id: n, method, params, sessionId: sid }))
  })

async function connect() {
  ws = new WebSocket(await devtoolsUrl())
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data)
    const entry = pending.get(msg.id)
    if (!entry) return
    pending.delete(msg.id)
    msg.error ? entry.reject(new Error(JSON.stringify(msg.error))) : entry.resolve(msg.result)
  }
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  ;({ sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }))
  await send('Page.enable', {}, sessionId)
  await send('Runtime.enable', {}, sessionId)
}

async function evaluate(expression) {
  const r = await send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  )
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
  return r.result?.value
}

async function goto(p) {
  await send('Page.navigate', { url: `${BASE}${p}` }, sessionId)
  for (let i = 0; i < 60; i++) {
    await sleep(500)
    const ready = await evaluate(
      `document.readyState === 'complete' && (document.body?.innerText || '').trim().length > 0`,
    )
    if (ready) break
  }
  await sleep(1500)
  return evaluate('location.pathname')
}

async function signIn() {
  const at = await goto('/')
  if (at !== '/' && !at.startsWith('/login')) return
  for (let i = 0; i < 40; i++) {
    if (await evaluate(`!!document.querySelector('input[name="email"]')`)) break
    await sleep(500)
  }
  await evaluate(`(() => {
    const set = (el, v) => {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, v)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    const email = document.querySelector('input[name="email"]')
    const pass = document.querySelector('input[name="password"]')
    set(email, ${JSON.stringify(EMAIL)})
    set(pass, ${JSON.stringify(PASSWORD)})
    email.closest('form').querySelector('button[type="submit"]').click()
  })()`)
  for (let i = 0; i < 120; i++) {
    const p = await evaluate('location.pathname')
    if (p !== '/' && !p.startsWith('/login')) return
    await sleep(500)
  }
  throw new Error('could not sign in')
}

/**
 * ONE PIN, ONE ENTRY.
 *
 * Taps a PIN on the real clock keypad and counts the rows it produced. The
 * regression this guards clocked the person in, out, in, out for as long as
 * the page stayed open — about two entries a second.
 */
async function clockPadDoesNotLoop({ siteExecute, siteQuery }) {
  const PIN = '4821'
  const SITE = 1
  let roleId = 0
  let userId = 0

  try {
    const role = await siteExecute(
      SITE,
      `INSERT INTO roles (name, description) VALUES ('Clock Smoke','Temporary, from smoke-interactions.')`,
    )
    roleId = role.insertId
    await siteExecute(
      SITE,
      `INSERT INTO role_permissions (role_id, capability, allowed) VALUES (?,'staff.clock',1)`,
      [roleId],
    )
    const bcrypt = (await import('bcryptjs')).default
    const made = await siteExecute(
      SITE,
      `INSERT INTO users (name, user_type, role_id, pin_hash, is_active)
       VALUES ('Clock Smoke','pos_only',?,?,1)`,
      [roleId, await bcrypt.hash(PIN, 10)],
    )
    userId = made.insertId

    const landed = await goto('/staff/clock')
    if (landed !== '/staff/clock') {
      record('clock pad: one PIN, one entry', false, `landed on ${landed}`)
      return
    }

    for (const digit of PIN) {
      const tapped = await evaluate(`(() => {
        const b = [...document.querySelectorAll('button')]
          .find(x => x.textContent.trim() === ${JSON.stringify(digit)})
        if (!b) return false
        b.click()
        return true
      })()`)
      if (!tapped) {
        record('clock pad: one PIN, one entry', false, `keypad button ${digit} not found`)
        return
      }
      await sleep(120)
    }

    // The confirmation auto-closes after 4s, so look inside that window.
    await sleep(2500)
    const confirmed = await evaluate(
      `(document.body.innerText.match(/Clocked (in|out)/) || ['none'])[0]`,
    )
    record('clock pad: confirms the action', confirmed === 'Clocked in', `showed "${confirmed}"`)

    // Then wait out many would-be loop cycles before counting.
    await sleep(12000)

    const rows = await siteQuery(
      SITE,
      'SELECT id, ended_at FROM staff_time_entries WHERE user_id = ? ORDER BY id',
      [userId],
    )
    const ok = rows.length === 1 && rows[0].ended_at === null
    record(
      'clock pad: one PIN, one entry',
      ok,
      ok ? '1 open entry' : `${rows.length} entries — the pad is re-submitting`,
    )
  } finally {
    const quiet = (p) => p.catch(() => {})
    if (userId) await quiet(siteExecute(SITE, 'DELETE FROM staff_time_entries WHERE user_id = ?', [userId]))
    if (userId) await quiet(siteExecute(SITE, 'DELETE FROM users WHERE id = ?', [userId]))
    if (roleId) await quiet(siteExecute(SITE, 'DELETE FROM role_permissions WHERE role_id = ?', [roleId]))
    if (roleId) await quiet(siteExecute(SITE, 'DELETE FROM roles WHERE id = ?', [roleId]))
  }
}

async function main() {
  // Imported through tsx so the app's own DB routing is used rather than a
  // second, hand-rolled connection with its own idea of the credentials.
  const { siteExecute, siteQuery } = await import('../src/lib/siteDb.ts')

  await connect()
  await signIn()
  await clockPadDoesNotLoop({ siteExecute, siteQuery })

  const failed = results.filter((r) => !r.ok)
  if (jsonAt) writeFileSync(jsonAt, JSON.stringify({ results }, null, 2))
  console.log(`\n${results.length - failed.length}/${results.length} interactions passed`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => {
  console.error('error:', e.message)
  process.exit(1)
})
