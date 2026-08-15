// Two independent Chrome profiles, same user. Proves the real behaviour:
// signing in on B must sign A out on A's very next request.
//
// Two profiles rather than two tabs, deliberately — tabs share a cookie jar, so
// they cannot demonstrate one session displacing another.
//
// ── BOTH MODES ARE TESTED, NOT JUST THE DEFAULT ────────────────────────────
//
// ALLOW_MULTIPLE_SESSIONS=1 switches eviction off for local development (see
// .env.example). This script reads the same flag the app does and flips its
// expectation, because the alternative is a test that fails on every developer
// machine that has the flag set — and a test that is expected to fail teaches
// people to ignore it, which is worse than not having one.
//
// The assertions are genuinely inverted, not skipped: with the flag on, A
// keeping its session is the thing being proved.
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const EMAIL = process.env.DEV_LOGIN_EMAIL
const PASSWORD = process.env.DEV_LOGIN_PASSWORD
const BASE = process.env.APP_URL || 'http://localhost:4100'
const CHROME =
  process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

/* Mirrors multipleSessionsAllowed() in src/lib/auth.ts. The dev server sets its
   own NODE_ENV, so what matters here is the flag the server was started with. */
const MULTI = process.env.ALLOW_MULTIPLE_SESSIONS === '1'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let fails = 0
const ok = (label, cond, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

/** One isolated browser: its own profile directory, its own debugging port. */
async function browser(name, port) {
  const profile = path.join(tmpdir(), `ody-session-${name}-${process.pid}`)
  mkdirSync(profile, { recursive: true })
  const proc = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      `--user-data-dir=${profile}`,
      '--window-size=1400,900',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  let wsUrl = null
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (r.ok) {
        wsUrl = (await r.json()).webSocketDebuggerUrl
        break
      }
    } catch {}
    await sleep(250)
  }
  if (!wsUrl) throw new Error(`${name}: Chrome did not expose a debugging port`)

  const ws = new WebSocket(wsUrl)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = rej
  })

  let id = 0
  const pending = new Map()
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data)
    const entry = pending.get(msg.id)
    if (!entry) return
    pending.delete(msg.id)
    msg.error ? entry.reject(new Error(JSON.stringify(msg.error))) : entry.resolve(msg.result)
  }
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const n = ++id
      pending.set(n, { resolve, reject })
      ws.send(JSON.stringify({ id: n, method, params, sessionId }))
    })

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  await send('Page.enable', {}, sessionId)
  await send('Runtime.enable', {}, sessionId)

  const evaluate = async (expression) => {
    const r = await send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      sessionId,
    )
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
    return r.result?.value
  }

  const goto = async (p) => {
    await send('Page.navigate', { url: `${BASE}${p}` }, sessionId)
    for (let i = 0; i < 60; i++) {
      await sleep(500)
      const ready = await evaluate(
        `document.readyState === 'complete' && (document.body?.innerText || '').trim().length > 0`,
      )
      if (ready) break
    }
    await sleep(1200)
    return evaluate('location.pathname + location.search')
  }

  return {
    name,
    evaluate,
    goto,
    text: () => evaluate('(document.body.innerText || "").replace(/\\s+/g, " ").trim()'),
    close: () => {
      try { proc.kill() } catch {}
      try { rmSync(profile, { recursive: true, force: true }) } catch {}
    },
  }
}

/** Drive the real login form — React ignores a bare .value assignment. */
async function signIn(b) {
  await b.goto('/')
  for (let i = 0; i < 40; i++) {
    const ready = await b.evaluate(
      `!!document.querySelector('input[name="email"]') && !!document.querySelector('button[type="submit"]')`,
    )
    if (ready) break
    await sleep(500)
  }
  const submitted = await b.evaluate(`(() => {
    const set = (el, v) => {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, v)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    const email = document.querySelector('input[name="email"]')
    const pass = document.querySelector('input[name="password"]')
    if (!email || !pass) return false
    set(email, ${JSON.stringify(EMAIL)})
    set(pass, ${JSON.stringify(PASSWORD)})
    email.closest('form').querySelector('button[type="submit"]').click()
    return true
  })()`)
  if (!submitted) throw new Error(`${b.name}: login form not found`)
  await sleep(5000)

  // A multi-store account gets a picker over the login card.
  const picked = await b.evaluate(`(() => {
    const d = document.querySelector('dialog[open]')
    if (!d) return false
    const row = [...d.querySelectorAll('button, a[href]')]
      .filter((el) => (el.textContent || '').trim())
      .find((el) => !/cancel|sign out/i.test(el.textContent))
    if (!row) return false
    row.click()
    return true
  })()`)
  if (picked) await sleep(4000)
  return b.evaluate('location.pathname')
}

async function main() {
  if (!EMAIL || !PASSWORD) throw new Error('Set DEV_LOGIN_EMAIL / DEV_LOGIN_PASSWORD in .env.local')

  const a = await browser('A', 9401)
  const b = await browser('B', 9402)

  try {
    // ── A signs in and is working ──────────────────────────────────────────
    const landedA = await signIn(a)
    ok('browser A signs in', !landedA.startsWith('/') === false && landedA !== '/', landedA)
    const dashA = await a.goto('/dashboard')
    ok('  and reaches the dashboard', dashA.startsWith('/dashboard'), dashA)

    // ── B signs in as the SAME user ───────────────────────────────────────
    const landedB = await signIn(b)
    ok('browser B signs in as the same user', landedB !== '/', landedB)
    const dashB = await b.goto('/dashboard')
    ok('  and reaches the dashboard', dashB.startsWith('/dashboard'), dashB)

    // ── A's very next request: refused, or not, depending on the mode ──────
    const nextA = await a.goto('/products')

    if (MULTI) {
      ok('*** A KEEPS working (ALLOW_MULTIPLE_SESSIONS=1) ***', nextA.startsWith('/products'), nextA)
      const textA = await a.text()
      ok(
        '  and is never told it was signed out',
        !/signed in on another device/i.test(textA),
        textA.slice(0, 90),
      )
    } else {
      ok('*** A is EVICTED on its next request ***', nextA.startsWith('/?kicked=1'), nextA)
      const textA = await a.text()
      ok(
        '  and is told why',
        /signed in on another device/i.test(textA),
        textA.slice(0, 90),
      )
    }

    // ── B must be untouched ───────────────────────────────────────────────
    const stillB = await b.goto('/products')
    ok('*** B is unaffected and keeps working ***', stillB.startsWith('/products'), stillB)
  } finally {
    a.close()
    b.close()
  }

  const mode = MULTI
    ? 'Multiple sessions allowed (ALLOW_MULTIPLE_SESSIONS=1) — eviction is off, as intended.'
    : 'Single-session enforcement works.'
  console.log(fails === 0 ? `\n${mode}` : `\n${fails} FAILURE(S)  [mode: ${MULTI ? 'multi' : 'single'}]`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
