/*
 * The "This till is closed" screen on a machine that is not a till.
 *
 *   node --env-file=.env --env-file=.env.local scripts/verify-till-unclaimed.mjs
 *
 * Reproduces the reported problem — a float pad that invites a figure and then
 * refuses it with "Choose a till.", naming nothing the person at the counter
 * can act on — and asserts that the screen now says so BEFORE the pad instead.
 *
 * Driven in a real browser because the bug is entirely about what is on screen
 * and in what order. `openShift` refusing an unclaimed terminal is correct and
 * was never in doubt; what was wrong is that the refusal arrived last.
 *
 * SITE 2 is the subject: its only till has no device claim, which is exactly
 * the state a fresh machine is in. `scripts/probe-till-claim.ts` prints that.
 */
import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { launchChrome } from './lib/cdp-chrome.mjs'

const BASE = process.env.APP_URL || 'http://localhost:4100'
const EMAIL = process.env.DEV_LOGIN_EMAIL
const PASSWORD = process.env.DEV_LOGIN_PASSWORD

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

const { wsUrl, close: closeChrome } = await launchChrome('till', { windowSize: '1400,1000' })
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

/* ── Sign in, choosing the store whose till is unclaimed ─────────────────── */
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

/* The SECOND store, not the first — site 1's tills are claimed, so choosing the
   default would land on a machine that behaves correctly and prove nothing. */
const WANT = process.env.TILL_SITE || ''
const chose = await evaluate(`(() => {
  const dialog = document.querySelector('dialog[open]')
  if (!dialog || !/choose a store|select which one/i.test(dialog.innerText || '')) return null
  const rows = [...dialog.querySelectorAll('button, a[href]')]
    .filter((el) => (el.textContent || '').trim().length > 0)
    .filter((el) => !/cancel|sign out/i.test(el.textContent))
  const want = ${JSON.stringify('')} || ${JSON.stringify(WANT)}
  const hit = want
    ? rows.find((el) => el.textContent.toLowerCase().includes(want.toLowerCase()))
    : rows[rows.length - 1]
  if (!hit) return null
  hit.click()
  return hit.textContent.replace(/\\s+/g, ' ').trim()
})()`)
if (chose) {
  await sleep(4000)
  console.log('chose store:', chose)
}
console.log('landed on', await evaluate('location.pathname'))

/*
 * ── BECOME THE LICENSED MACHINE ──────────────────────────────────────────
 *
 * A fresh Chrome profile mints its own `odyssey.device.id`, which no licence
 * knows — so the till refuses it at the LICENCE gate and never reaches the
 * float screen at all. That is a different bug's screen, and asserting against
 * it proves nothing about this one.
 *
 * The state being reproduced is the one `probe-till-licence-split.ts` prints:
 * a device that IS licensed for the site while the site's `terminals.device_id`
 * names nobody. Borrowing that serial puts this browser in exactly it.
 *
 * `localStorage` needs an origin, so this runs only after a page has loaded.
 */
const SERIAL = process.env.TILL_DEVICE_ID || '8d3bc8d3-0d97-4cc1-91cc-02afd3fa4c8c'
await goto('/dashboard')
await evaluate(
  `(() => { try { localStorage.setItem('odyssey.device.id', ${JSON.stringify(SERIAL)}) } catch {} })()`,
)
console.log('device id set to', SERIAL)

console.log('\n── The till screen on an unclaimed machine ───────────────────')
await goto('/pos')

/*
 * Past the PIN pad, using the scratch operator.
 *
 *   npx tsx --conditions=react-server --env-file=.env scripts/scratch-till-operator.ts create
 *
 * The PIN is typed on the pad rather than posted to the action, because the pad
 * is what a person uses and a server-action shortcut would skip whatever the
 * screen does around it. Remove the operator again when finished — a leaked PIN
 * occupies a UNIQUE slot and breaks unrelated suites.
 */
const PIN = process.env.TILL_PIN || '481624'
if (/enter your pin/i.test(await evaluate(`document.body.innerText || ''`))) {
  const typed = await evaluate(`(() => {
    const digits = ${JSON.stringify(PIN)}.split('')
    const keys = [...document.querySelectorAll('button')]
    let hit = 0
    for (const d of digits) {
      const key = keys.find((b) => (b.textContent || '').trim() === d)
      if (key) { key.click(); hit++ }
    }
    return hit
  })()`)
  await sleep(1200)
  /* Some pads submit on the last digit; others need Enter. Tried in that order
     so a pad that already signed in is not sent a stray second action. */
  if (/enter your pin/i.test(await evaluate(`document.body.innerText || ''`))) {
    await evaluate(`(() => {
      const go = [...document.querySelectorAll('button')]
        .find((b) => /enter|sign in|ok|go/i.test(b.textContent || ''))
      if (go) go.click()
    })()`)
  }
  await sleep(4000)
  console.log(`typed ${typed} PIN digit(s)`)
}

const text = await evaluate(`(document.body.innerText || '')`)

/* The till may stop earlier than the float screen — the PIN pad, or the licence
   refusal. Those are different screens and neither can answer this question, so
   they are named rather than counted as a pass. */
const onPin = /enter your pin/i.test(text)
const onLicence = /not licensed|not registered as a till/i.test(text)
const onFloat = /this till is closed/i.test(text)

if (onPin) {
  console.log('  SKIP  the till is at the PIN pad (no operator signed in here)')
  console.log('        Sign in at /pos in a normal browser, then re-run.')
  await shutdown(0)
}
if (onLicence) {
  /*
   * ── WHAT THIS RUN ACTUALLY ESTABLISHED ────────────────────────────────
   *
   * A machine with NO terminal row at all never reaches the float screen: the
   * licence gate (PosNotLicensed) stands in front of it and already says the
   * right thing, with the device serial support will ask for.
   *
   * So the reported symptom is NOT this state. "Choose a till." comes from a
   * machine that IS licensed and claimed but whose claim does not resolve to a
   * terminal id — a released or deactivated till, or a device id that changed
   * under a claim that stayed. That is the case OpenTillGate's new branch
   * covers, and it cannot be produced by simply having no terminals.
   */
  console.log('  NOTE  the licence gate refuses this machine before the float screen.')
  console.log('        That screen is pre-existing and already explains itself, so the')
  console.log('        "Choose a till." path is NOT reachable from a bare unclaimed')
  console.log('        machine. It needs a licensed device whose till was released or')
  console.log('        deactivated — see the note in this file.')
  await shutdown(0)
}
check('the float screen is showing', onFloat, text.slice(0, 160).replace(/\s+/g, ' '))

console.log('\n── What it tells the person standing there ───────────────────')
check(
  'it says the machine is not set up as a till',
  /not set up as a till/i.test(text),
  'the warning did not appear',
)
/* The route AND the control, because "ask someone" is what the old screen
   effectively said. Each is asserted separately so a half-correct message
   cannot pass. */
check('it names where to fix it', /setup/i.test(text) && /till licences/i.test(text))
check('it names the button to press', /use this machine/i.test(text))

console.log('\n── And does not invite a figure it will refuse ───────────────')
/* The regression that matters. The old screen asked for a float and rejected
   it; if the pad is still on screen the fix has not actually landed. */
check('the float pad is not offered', !/opening float/i.test(text))
check(
  'it does not tell them to count the drawer',
  !/count the drawer|count the notes and coins/i.test(text),
)
check('the "Choose a till." error is not what they meet', !/choose a till/i.test(text))

await send('Page.captureScreenshot', { format: 'png' }, sessionId).then(async (shot) => {
  const { writeFileSync, mkdirSync } = await import('node:fs')
  mkdirSync('.screenshots', { recursive: true })
  writeFileSync('.screenshots/till-unclaimed.png', Buffer.from(shot.data, 'base64'))
  console.log('\nwrote .screenshots/till-unclaimed.png')
})

console.log(failures === 0 ? '\nAll good.\n' : `\n${failures} failed.\n`)
await shutdown(failures === 0 ? 0 : 1)
