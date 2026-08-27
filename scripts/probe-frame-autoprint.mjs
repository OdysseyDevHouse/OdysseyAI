/**
 * Does the A4 document route actually print ITSELF when loaded in a frame?
 *
 * This cannot be answered from inside the page: Chrome gives every navigation
 * a fresh window, so a `print` stub installed by the parent is always thrown
 * away before the route's own scripts run — every in-page attempt reported
 * "no print", which is an artefact of the race and not an answer.
 *
 * Page.addScriptToEvaluateOnNewDocument runs BEFORE any script of the new
 * document, in that document's own world, so the stub is guaranteed to be in
 * place. It reports through console, which CDP surfaces per-frame.
 *
 *   node --env-file=.env.local scripts/probe-frame-autoprint.mjs
 */
import { launchChrome } from './lib/cdp-chrome.mjs'

const EMAIL = process.env.DEV_LOGIN_EMAIL
const PASSWORD = process.env.DEV_LOGIN_PASSWORD
const BASE = process.env.APP_URL || 'http://localhost:4100'
const DOC = process.env.PROBE_DOC || '/sales/1/document'

if (!EMAIL || !PASSWORD) {
  console.error('Set DEV_LOGIN_EMAIL / DEV_LOGIN_PASSWORD in .env.local')
  process.exit(1)
}

const { wsUrl, close } = await launchChrome('autoprint')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ws = new WebSocket(wsUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })

let id = 0
const pending = new Map()
const events = []
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data)
  if (msg.id === undefined) { events.push(msg); return }
  const entry = pending.get(msg.id)
  if (!entry) return
  pending.delete(msg.id)
  msg.error ? entry.reject(new Error(JSON.stringify(msg.error))) : entry.resolve(msg.result)
}
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const mid = ++id
    pending.set(mid, { resolve, reject })
    ws.send(JSON.stringify({ id: mid, method, params, sessionId }))
  })

const { targetInfos } = await send('Target.getTargets')
const page = targetInfos.find((t) => t.type === 'page')
const { sessionId } = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true })
await send('Page.enable', {}, sessionId)
await send('Runtime.enable', {}, sessionId)

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true }, sessionId)
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.result?.description ?? ''))
  return r.result.value
}

/* ── Sign in ──────────────────────────────────────────────────────────────
 *
 * Same flow as scripts/screenshot.mjs, and for the same reasons: wait for the
 * form to HYDRATE before filling it (the inputs exist in server HTML before
 * the submit handler does), and expect a two-store account to be held at '/'
 * by a store-picker DIALOG rather than redirected to a /select-site page. */
await send('Page.navigate', { url: BASE + '/dashboard' }, sessionId)
await sleep(3500)

for (let i = 0; i < 40; i++) {
  const ready = await evaluate(
    `!!document.querySelector('input[name="email"]') && !!document.querySelector('button[type="submit"]')`,
  )
  if (ready) break
  await sleep(500)
}

if (await evaluate(`!!document.querySelector('input[name="email"]')`)) {
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
  await sleep(4500)
}

const picked = await evaluate(`(() => {
  const dialog = document.querySelector('dialog[open]')
  if (!dialog || !/choose a store|select which one/i.test(dialog.innerText || '')) return null
  const rows = [...dialog.querySelectorAll('a[href],button')]
    .filter((el) => (el.textContent || '').trim() && !/sign out/i.test(el.textContent))
  if (!rows.length) return null
  rows[0].click()
  return rows[0].textContent.replace(/\\s+/g, ' ').trim()
})()`)
if (picked) {
  console.log('chose store:', picked)
  await sleep(4000)
}

const landed = await evaluate('location.pathname')
console.log('signed in at', landed)
if (landed === '/' || landed.includes('login')) {
  console.error('**Sign-in did not land on an app route — nothing below is meaningful.**')
  close()
  process.exit(1)
}

// ── Instrument every NEW document, before its own scripts run ─────────────
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `
    (() => {
      try {
        const real = window.print
        window.print = function () {
          console.log('__AUTOPRINT__ ' + location.pathname + location.search)
        }
      } catch (e) {}
    })()
  `,
}, sessionId)

// ── Load the document into a hidden frame, exactly as usePrintDocument does ─
await evaluate(`(() => {
  const f = document.createElement('iframe')
  f.setAttribute('style','position:fixed;left:-10000px;top:0;width:210mm;height:297mm;border:0;')
  f.setAttribute('aria-hidden','true')
  document.body.appendChild(f)
  f.src = ${JSON.stringify(DOC)} + '?auto=1'
  return 'frame added'
})()`)

await sleep(9000)

const prints = events
  .filter((e) => e.method === 'Runtime.consoleAPICalled')
  .flatMap((e) => (e.params.args || []).map((a) => a.value))
  .filter((v) => typeof v === 'string' && v.startsWith('__AUTOPRINT__'))

const loaded = await evaluate(`(() => {
  const f = document.querySelector('iframe')
  const t = f && f.contentDocument ? (f.contentDocument.body.innerText||'') : ''
  return /TAX INVOICE/i.test(t)
})()`)

/* ── Is the instrumentation itself alive? ──────────────────────────────────
 *
 * A probe that reports "print was never called" is worthless unless it can be
 * shown to notice a print that DID happen. Clicking the frame's own Print
 * button drives the same window.print() by a path known to work, so a silent
 * stub and a silent page are told apart. */
const controlFired = await evaluate(`(() => {
  const f = document.querySelector('iframe')
  const d = f && f.contentDocument
  const btn = d && [...d.querySelectorAll('button')].find((b) => /Print/.test(b.textContent||''))
  if (!btn) return 'no toolbar Print button in the frame'
  btn.click()
  return 'clicked'
})()`)
await sleep(1200)
const afterControl = events
  .filter((e) => e.method === 'Runtime.consoleAPICalled')
  .flatMap((e) => (e.params.args || []).map((a) => a.value))
  .filter((v) => typeof v === 'string' && v.startsWith('__AUTOPRINT__'))
console.log('control (clicked the frame toolbar):', controlFired,
  '-> captured', afterControl.length - prints.length, 'more print call(s)')
if (afterControl.length === prints.length) {
  console.log('**The stub never fires even for a real click — this probe cannot see print at all.**')
}

console.log('frame rendered the document:', loaded)
console.log('print() calls captured:', JSON.stringify(prints))
console.log(
  prints.length > 0
    ? 'PASS  auto=1 prints itself inside a hidden frame — no tab, no extra click'
    : '**FAIL** the frame loaded but never called print()',
)

close()
process.exit(prints.length > 0 && loaded ? 0 : 1)
