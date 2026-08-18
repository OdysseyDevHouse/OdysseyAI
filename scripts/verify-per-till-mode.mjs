/*
 * Does the till's mode actually follow the TILL?
 *
 *   node --env-file=.env --env-file=.env.local scripts/verify-per-till-mode.mjs
 *
 * The point of the change is that two registers in ONE shop can run different
 * screens. A unit test cannot show that: the interesting part is that the setup
 * screen writes one till's row, and the POS — resolving the mode from whichever
 * machine is asking — comes up on the matching screen.
 *
 * So this drives both ends in a real browser:
 *
 *   1. sets TILL01 to the trade counter on Setup → Tills,
 *   2. opens /pos as the machine claiming TILL01 and reads the wordmark,
 *   3. sets it back to retail and checks the till follows,
 *
 * and it restores whatever the till started on, so a verification run does not
 * leave a shop's register on a screen nobody chose.
 */
import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { launchChrome } from './lib/cdp-chrome.mjs'

const BASE = process.env.APP_URL || 'http://localhost:4100'
const EMAIL = process.env.DEV_LOGIN_EMAIL
const PASSWORD = process.env.DEV_LOGIN_PASSWORD
/* The machine that claims TILL01 on site 1 — probe-till-claim.ts prints it.
   Borrowed so /pos resolves a terminal at all; a fresh profile's own id claims
   nothing and would resolve to 'retail' whatever the row said, which would make
   every assertion below pass for the wrong reason. */
const SERIAL = process.env.TILL_DEVICE_ID || '8d3bc8d3-0d97-4cc1-91cc-02afd3fa4c8c'
const TILL = process.env.TILL_CODE || 'TILL01'

if (!EMAIL || !PASSWORD) {
  console.error('Set DEV_LOGIN_EMAIL / DEV_LOGIN_PASSWORD in .env.local')
  process.exit(1)
}

let failures = 0
function check(name, ok, detail = '') {
  if (ok) console.log(`  PASS  ${name}`)
  else {
    failures++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const { wsUrl, close: closeChrome } = await launchChrome('mode', { windowSize: '1500,1000' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function shutdown(code) {
  try { ws.close() } catch {}
  await sleep(300)
  process.exit(code)
}


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
}

/* ── Sign in to site 1 ────────────────────────────────────────────────────── */
await goto('/')
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
await sleep(4500)
/* The FIRST store: TILL01 lives on site 1. */
await evaluate(`(() => {
  const dialog = document.querySelector('dialog[open]')
  if (!dialog || !/choose a store|select which one/i.test(dialog.innerText || '')) return
  const rows = [...dialog.querySelectorAll('button, a[href]')]
    .filter((el) => (el.textContent || '').trim().length > 0)
    .filter((el) => !/cancel|sign out/i.test(el.textContent))
  if (rows[0]) rows[0].click()
})()`)
await sleep(4000)
console.log('signed in, landed on', await evaluate('location.pathname'))

/* Become the machine that claims TILL01 — see the note on SERIAL. */
await evaluate(
  `(() => { try { localStorage.setItem('odyssey.device.id', ${JSON.stringify(SERIAL)}) } catch {} })()`,
)

/*
 * Set one till's mode on the setup screen.
 *
 * Driven through the SELECT rather than by calling the action, because the wiring
 * between the row control and the action is exactly what could be broken while
 * both halves are individually fine.
 */
async function setMode(label) {
  await goto('/setup/terminals')
  const done = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('select')]
      .filter((s) => /what kind of till/i.test(s.getAttribute('aria-label') || ''))
    const hit = rows.find((s) => (s.getAttribute('aria-label') || '').includes(${JSON.stringify(TILL)}))
    if (!hit) return 'no-select'
    const option = [...hit.options].find((o) => o.textContent.trim() === ${JSON.stringify(label)})
    if (!option) return 'no-option'
    const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(hit), 'value').set
    set.call(hit, option.value)
    hit.dispatchEvent(new Event('change', { bubbles: true }))
    return option.value
  })()`)
  await sleep(4000)
  return done
}

/* What the till currently says it is. The status bar carries the mode as the
   second word of the lockup — "Odyssey Retail", "Odyssey Invoicing" — which is
   the mode made visible rather than inferred from which controls rendered. */
async function tillMode() {
  await goto('/pos')

  /* Past the PIN pad, with the scratch operator. Typed on the pad rather than
     posted to the action, so whatever the screen does around a sign-in is
     exercised too. Create it with:
       TILL_SITE_ID=1 npx tsx --conditions=react-server --env-file=.env \
         scripts/scratch-till-operator.ts create
     and REMOVE it afterwards — a leaked PIN occupies a UNIQUE slot. */
  if (/enter your pin/i.test(await evaluate(`document.body.innerText || ''`))) {
    await evaluate(`(() => {
      const keys = [...document.querySelectorAll('button')]
      for (const d of ${JSON.stringify(process.env.TILL_PIN || '481624')}.split('')) {
        const key = keys.find((b) => (b.textContent || '').trim() === d)
        if (key) key.click()
      }
    })()`)
    await sleep(600)
    /* A 4-digit PIN submits itself; a 5- or 6-digit one does NOT — the pad
       renders a confirm key that has to be pressed. Missing this is why an
       earlier run typed all six digits and sat on the gate reporting "cannot
       read the mode": the digits went in and nothing was ever sent. */
    await evaluate(`(() => {
      const go = [...document.querySelectorAll('button')].find(
        (b) => !b.disabled && /^(enter|sign in|ok|go|unlock)$/i.test((b.textContent || '').trim()),
      )
      if (go) go.click()
    })()`)
    await sleep(4500)
  }

  return evaluate(`(() => {
    const t = (document.body.innerText || '')
    if (/enter your pin/i.test(t)) return 'gate'
    if (/not licensed|not set up as a till/i.test(t)) return 'blocked'
    const m = t.match(/ODYSSEY\\s+(RETAIL|HOSPITALITY|INVOICING)/i)
    if (m) return m[1].toLowerCase()
    /* The lockup is not always on screen — the status bar swaps it for a screen
       TITLE in some states. Fall back to the shape of the screen itself, which
       is the mode made structural rather than merely printed:
         · the trade counter has a document-lines editor and no catalogue pane;
         · tables put a floor gate in front of everything;
         · retail is the scanning counter.
       Reported verbatim on a miss so a failure says what it saw rather than
       just "unknown" — which is what the first version of this did, and it
       cost a run to work out that the regex was the problem. */
    /* Matched on the pane each mode SWAPS IN, not on the shared chrome.
       Invoicing keeps the same basket, totals and Pay button as retail — only
       the right-hand half differs — so "CURRENT SALE" is present in BOTH and a
       probe keying off it reports retail for a working trade counter. That is
       exactly what the first version of this did.
         · invoicing → TradeEntryPane's keyed lookup field
         · hospitality → the floor gate, in front of everything
         · retail → the catalogue/quick-key grid */
    if (/type a code and press enter/i.test(t)) return 'invoicing'
    if (/choose a table|no tables set up/i.test(t)) return 'hospitality'
    if (/scan or add|current sale/i.test(t)) return 'retail'
    return 'unknown:' + t.replace(/\\s+/g, ' ').slice(0, 200)
  })()`)
}

console.log('\n── What the till starts on ──────────────────────────────────')
const before = await tillMode()
console.log('  starting mode:', before)
if (before === 'gate' || before === 'blocked') {
  console.log('  SKIP  the till is not past its gates on this profile; cannot read the mode.')
  console.log('        Create a scratch operator and re-run — see scratch-till-operator.ts.')
  await shutdown(0)
}

console.log('\n── Set THIS till to the trade counter ───────────────────────')
const set1 = await setMode('Trade counter')
check(`the row control accepted the change (${set1})`, set1 === 'invoicing', String(set1))
const asInvoicing = await tillMode()
check('the till now runs invoicing', asInvoicing === 'invoicing', `saw "${asInvoicing}"`)

console.log('\n── And back to the retail counter ───────────────────────────')
const set2 = await setMode('Retail counter')
check(`the row control accepted the change (${set2})`, set2 === 'retail', String(set2))
const asRetail = await tillMode()
check('the till follows back to retail', asRetail === 'retail', `saw "${asRetail}"`)

/* Restored to whatever it was, so a verification run leaves no trace. `before`
   is the wordmark word, which maps onto the option labels one-for-one. */
const RESTORE = { retail: 'Retail counter', hospitality: 'Tables', invoicing: 'Trade counter' }
if (RESTORE[before] && before !== 'retail') {
  await setMode(RESTORE[before])
  console.log(`\nrestored ${TILL} to ${RESTORE[before]}`)
}

console.log(failures === 0 ? '\nAll good.\n' : `\n${failures} failed.\n`)
await shutdown(failures === 0 ? 0 : 1)
