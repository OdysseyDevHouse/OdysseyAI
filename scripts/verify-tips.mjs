// Proves a cashier can take a tip, and that the pad tells the truth about the change.
//
//   node --env-file=.env --env-file=.env.local scripts/verify-tips.mjs
//
// test-tips (41) proves the money is right in the database. What it cannot reach is the
// PAD, and the pad carries the one thing a customer sees: how much change comes back.
//
// Needs the bands seeded and CARD set to take tips on over-tender.
//
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SignJWT } from 'jose'
import { launchChrome } from './lib/cdp-chrome.mjs'

const EMAIL = process.env.DEV_LOGIN_EMAIL
const PASSWORD = process.env.DEV_LOGIN_PASSWORD
const SECRET = process.env.SESSION_SECRET
const BASE = process.env.APP_URL || 'http://localhost:4100'
const OUT = process.env.SHOT_DIR || path.join(process.cwd(), '.screenshots')
const DEVICE = process.env.VERIFY_DEVICE_ID || 'b7a53389-9e44-4378-873c-af3cbd870b7d'

if (!EMAIL || !PASSWORD) {
  console.error('Set DEV_LOGIN_EMAIL / DEV_LOGIN_PASSWORD in .env.local')
  process.exit(1)
}
if (!SECRET) {
  console.error('SESSION_SECRET is not set — the till cookie cannot be minted.')
  process.exit(1)
}

mkdirSync(OUT, { recursive: true })

const { wsUrl, close: closeChrome } = await launchChrome('tip')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
process.on('exit', () => {
})


const ws = new WebSocket(wsUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })

let id = 0
const waiting = new Map()
const consoleErrors = []
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data)
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
    consoleErrors.push((msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '))
    return
  }
  const entry = waiting.get(msg.id)
  if (!entry) return
  waiting.delete(msg.id)
  msg.error ? entry.reject(new Error(JSON.stringify(msg.error))) : entry.resolve(msg.result)
}
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const n = ++id
    waiting.set(n, { resolve, reject })
    ws.send(JSON.stringify({ id: n, method, params, sessionId }))
  })

const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
await send('Page.enable', {}, sessionId)
await send('Runtime.enable', {}, sessionId)
await send('Network.enable', {}, sessionId)

async function evaluate(expression) {
  const r = await send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  )
  if (r.exceptionDetails) {
    const detail =
      r.exceptionDetails.exception?.description ||
      r.exceptionDetails.exception?.value ||
      JSON.stringify(r.exceptionDetails)
    throw new Error(`${r.exceptionDetails.text}: ${detail}`)
  }
  return r.result?.value
}

async function goto(p) {
  await send('Page.navigate', { url: `${BASE}${p}` }, sessionId)
  for (let i = 0; i < 60; i++) {
    await sleep(500)
    if (
      await evaluate(
        `document.readyState === 'complete' && (document.body?.innerText||'').trim().length > 0`,
      )
    )
      break
  }
  await sleep(1500)
  return evaluate('location.pathname')
}

async function shot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId)
  const file = path.join(OUT, `${name}.png`)
  const { writeFileSync } = await import('node:fs')
  writeFileSync(file, Buffer.from(data, 'base64'))
  return file
}

let fails = 0
const ok = (label, cond, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

/* ── Sign in to the back office ─────────────────────────────────────────────── */

await goto('/')
await evaluate(
  [
    '(() => {',
    '  const set = (sel, value) => {',
    '    const el = document.querySelector(sel)',
    "    const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set",
    '    setter.call(el, value)',
    "    el.dispatchEvent(new Event('input', { bubbles: true }))",
    '  }',
    `  set('input[type=email]', ${JSON.stringify(EMAIL)})`,
    `  set('input[type=password]', ${JSON.stringify(PASSWORD)})`,
    "  document.querySelector('form').requestSubmit()",
    '  return true',
    '})()',
  ].join('\n'),
)
await sleep(4000)

/* ── Past the PIN gate, by minting the till cookie the action would issue ───── */

const operator = await evaluate(
  [
    '(async () => {',
    "  const r = await fetch('/api/pos/catalog?deviceId=' + encodeURIComponent(",
    `    ${JSON.stringify(DEVICE)}`,
    "  ), { headers: { accept: 'application/json' } })",
    '  if (!r.ok) return { ok: false, status: r.status }',
    '  const b = await r.json()',
    '  return {',
    '    ok: true,',
    '    siteId: b.siteId ?? null,',
    '    operator: (b.operators || [])[0] || null,',
    '    products: (b.products || []).length,',
    '  }',
    '})()',
  ].join('\n'),
)
ok('the catalog answers for this device', operator?.ok === true, JSON.stringify(operator?.status ?? ''))

const userId = operator?.operator?.userId ?? 1
const siteId = operator?.siteId ?? 1
const token = await new SignJWT({ userId, name: 'Tile size verifier', siteId })
  .setProtectedHeader({ alg: 'HS256' })
  .setIssuedAt()
  .setExpirationTime('8h')
  .sign(new TextEncoder().encode(SECRET))

await send(
  'Network.setCookie',
  { name: 'odyssey_till', value: token, domain: 'localhost', path: '/', httpOnly: true },
  sessionId,
)
await evaluate(`localStorage.setItem('ody-device-id', ${JSON.stringify(DEVICE)}), true`)

consoleErrors.length = 0
const landed = await goto('/pos')
const stillGated = await evaluate(`document.body.innerText.includes('Enter your PIN')`)
ok('the till renders rather than the PIN gate', landed === '/pos' && !stillGated, landed)


if (stillGated) {
  console.log('\nStill at the gate — the minted cookie was not accepted, so the split')
  console.log('assertions below cannot run. Nothing about the feature is proven either way.')
  console.log(`\n${fails} FAILURE(S)`)
  process.exit(1)
}

/* ── Helpers ──────────────────────────────────────────────────────────────── */

/** Clicks the first enabled button whose normalised text starts with `prefix`. */
const clickText = (prefix, { exact = false } = {}) =>
  evaluate(
    [
      '(() => {',
      `  const want = ${JSON.stringify(prefix.toLowerCase())}`,
      `  const exact = ${exact ? 'true' : 'false'}`,
      "  const norm = (s) => (s || '').split(/\s+/).join(' ').trim().toLowerCase()",
      "  const b = [...document.querySelectorAll('button')].find((x) => {",
      '    if (x.disabled) return false',
      '    const t = norm(x.innerText)',
      '    return exact ? t === want : t.startsWith(want)',
      '  })',
      '  if (!b) return false',
      '  b.click()',
      '  return true',
      '})()',
    ].join('\n'),
  )

/** Puts one priced product in the basket, drilling until it finds one. */
async function addOneItem() {
  await evaluate(
    [
      '(() => {',
      "  const nav = document.querySelector('nav')",
      "  const rows = nav ? [...nav.querySelectorAll('button')] : []",
      '  if (rows.length) rows[0].click()',
      '  return rows.length',
      '})()',
    ].join('\n'),
  )
  await sleep(1800)
  for (let depth = 0; depth < 6; depth++) {
    const found = await evaluate(
      [
        '(() => {',
        "  const grids = [...document.querySelectorAll('div')].filter(",
        '    (d) =>',
        "      getComputedStyle(d).display === 'grid' &&",
        '      /minmax/.test(d.style.gridTemplateColumns) &&',
        '      d.getBoundingClientRect().width > 0',
        '  )',
        '  for (const g of grids) {',
        "    const tiles = [...g.querySelectorAll('button')].filter((b) => b.getBoundingClientRect().width > 0)",
        '    if (!tiles.length) continue',
        "    const priced = tiles.filter((b) => /R\s?[0-9]/.test(b.innerText || ''))",
        '    if (priced.length) { priced[0].click(); return "product" }',
        '    tiles[0].click()',
        '    return "department"',
        '  }',
        '  return "none"',
        '})()',
      ].join('\n'),
    )
    await sleep(1500)
    if (found === 'product' || found === 'none') return found
  }
  return 'gave-up'
}

/** The pad's headline label, figure, and any tip note. */
const padState = () =>
  evaluate(
    [
      '(() => {',
      "  const d = document.querySelector('dialog[open]')",
      '  if (!d) return null',
      /*
       * `[ \t\r\n]+`, not `\s+`.
       *
       * THE bug behind every null in this object. `"\s"` inside a double-quoted JS string is
       * an escape that resolves to the plain letter `s`, so this line reached the browser as
       * `.split(/s+/)` and split the pad's text on the letter S — mangling "SETTLED",
       * "Service charge" and every figure, while looking entirely reasonable in the source.
       *
       * A character class needs no escaping and cannot rot this way. The debug print of the
       * raw text is what exposed it: the text plainly said "R206.36 kept as a tip" while the
       * matcher, given a different string, found nothing.
       */
      "  const text = (d.innerText || '').split(/[ \\t\\r\\n]+/).join(' ')",
      '  return {',
      "    change: /Change ([R0-9., ]+)/.exec(text)?.[1]?.trim() ?? null,",
      "    stillToPay: /Still to pay ([R0-9., ]+)/.exec(text)?.[1]?.trim() ?? null,",
      /*
       * A STRING SEARCH, not a regex.
       *
       * Two reasons, both learned the hard way in this file. The money is formatted with a
       * NARROW NO-BREAK SPACE as its thousands separator — "R1 150.38" is not a plain space
       * — so a [0-9., ] character class silently misses every figure over a thousand, and
       * the pad was right while the pattern was wrong. And every attempt to write a looser
       * regex here lost its escapes crossing into the browser. indexOf needs no escaping at
       * any layer.
       */
      "    tipNote: (() => { const i = text.indexOf(' kept as a tip'); return i < 0 ? null : text.slice(Math.max(0, i - 20), i).trim().split(' ').pop() })(),",
      "    asksTip: /is any of the .* change a tip/i.test(text),",
      "    serviceCharge: /Service charge/i.test(text),",
      "    removable: [...d.querySelectorAll('button')].some((b) => (b.innerText||'').trim() === 'Remove'),",
      "    settled: /SETTLED/i.test(text),",
      "    overTenderError: /cannot give change|Over-tendered by/i.test(text),",
      '  }',
      '})()',
    ].join('\n'),
  )

/* ── Seat a table and build a bill over R500 ──────────────────────────────── */

/* A table, so the tables-only rule lets a service charge apply at all. */
const seated = await evaluate(
  [
    '(() => {',
    "  const t = [...document.querySelectorAll('[data-table-code]')].find((x) => x.getBoundingClientRect().width > 0)",
    '  if (!t) return null',
    "  const code = t.getAttribute('data-table-code')",
    '  t.click()',
    '  return code',
    '})()',
  ].join('\n'),
)
await sleep(2200)
ok('a table opens', typeof seated === 'string', String(seated))

/* Enough of one product to clear R500, so a band fires. */
let added = 0
for (let i = 0; i < 12; i++) {
  const kind = await addOneItem()
  if (kind === 'product') added++
  const total = await evaluate(
    `/Pay|Refund/.test(document.body.innerText||'') ? (/R\s?([0-9., ]+)\s*$/m.exec(document.body.innerText)?.[1] ?? '') : ''`,
  )
  if (added >= 1) break
}
ok('an item goes on the bill', added >= 1, `${added} added`)

/* ── Open the pad. The bill is already well over R500, so a band applies. ──── */

const billTotal = await evaluate(
  [
    '(() => {',
    "  const b = [...document.querySelectorAll('button')].find((x) => /^Pay/.test((x.innerText||'').trim()))",
    "  return b ? (b.innerText || '').replace(/\s+/g, ' ').trim() : null",
    '})()',
  ].join('\n'),
)
ok('the bill is payable', typeof billTotal === 'string', String(billTotal))

ok('the tender pad opens', (await clickText('Pay')) === true)
await sleep(1400)

/*
 * ── THE SERVICE CHARGE ────────────────────────────────────────────────────
 * A table bill over R500 earns one, and it must be VISIBLE on the pad — a charge the
 * customer will query has to be on the screen the cashier is reading from.
 */
const opened = await padState()
ok('the pad shows the service charge', opened?.serviceCharge === true, JSON.stringify(opened))
/* This operator holds sales.discount_override, so Remove is offered. A waiter without it
   would see no button at all rather than a greyed one. */
ok('  and this operator may remove it', opened?.removable === true)

/* ── Pay by CARD, over the bill: the automatic tip path ───────────────────── */

ok('a card payment can be chosen', (await clickText('Card')) === true)
await sleep(900)

/* Type an amount well over the bill. CARD gives no change and has tip_on_over_tender on,
   so the excess is unambiguously a tip. */
/*
 * ── THE KEYS HAVE TO BE PRESSED ONE AT A TIME, WITH A GAP ─────────────────
 *
 * `NumPad.press` reads `valueRef.current`, which only updates when React re-renders. Firing
 * fourteen synthetic clicks in one evaluate() therefore had every one of them read the SAME
 * stale string — so fourteen backspaces each computed slice(0,-1) from the original and the
 * display never moved. That is not a bug in the pad: a finger cannot outrun a render, and a
 * script can.
 *
 * So: one click per evaluate, with a short await between. Slower, and it is what a real
 * cashier's tapping actually looks like.
 */
/**
 * Taps one pad key, matched by TEXT or by aria-label.
 *
 * The backspace key is an ICON with no innerText at all — its only handle is
 * `aria-label="Backspace"`, which is why matching on text alone found nothing and the
 * prefilled amount never cleared. The digits have text; the icon keys do not, so both are
 * tried.
 */
const tapKey = (label) =>
  evaluate(
    [
      '(() => {',
      "  const d = document.querySelector('dialog[open]')",
      '  if (!d) return false',
      `  const want = ${JSON.stringify(label)}`,
      "  const b = [...d.querySelectorAll('button')].find(",
      "    (k) => (k.innerText||'').trim() === want || (k.getAttribute('aria-label')||'') === want",
      '  )',
      '  if (!b || b.disabled) return false',
      '  b.click()',
      '  return true',
      '})()',
    ].join('\n'),
  )

const displayed = () =>
  evaluate(
    [
      '(() => {',
      "  const d = document.querySelector('dialog[open]')",
      "  const m = (d?.innerText || '').match(/amount handed over\\s+([0-9.]+)/)",
      '  return m ? m[1] : null',
      '})()',
    ].join('\n'),
  )

/* Clear the prefill — bounded by the display actually emptying rather than a fixed count,
   so this cannot silently under- or over-clear. */
for (let i = 0; i < 20; i++) {
  const current = await displayed()
  if (!current || current === '0') break
  await tapKey('Backspace')
  await sleep(140)
}
// R2000 — comfortably above the bill, so the excess is large and unmistakable.
for (const ch of '2000') {
  await tapKey(ch)
  await sleep(140)
}
const typed = await displayed()
ok('an over-payment can be entered', typed === '2000', String(typed))
await sleep(700)

/* "Take R2 000.00", not "Add" — the confirm names the amount, which the screenshot showed
   and my guess did not. Matched on the prefix so the figure can change. */
ok('the payment is added', (await clickText('Take')) === true)
await sleep(1200)

const afterCard = await padState()
/* The raw dialog text, printed once. When an assertion on a screen disagrees with a
   screenshot of that screen, the pattern is wrong far more often than the screen is — and
   the only way to tell is to look at exactly what the matcher was given. */
const rawPad = await evaluate(
  `(document.querySelector('dialog[open]')?.innerText || '').split(/\\s+/).join(' ').slice(0, 220)`,
)
console.log(`      pad text: ${rawPad}`)
/*
 * THE ASSERTIONS THIS FILE EXISTS FOR.
 *
 * A card over-payment must be named as a TIP and must offer no change — there is none to
 * give. Reporting change would have a cashier counting money out of the drawer against a
 * card payment.
 *
 * Note the headline reads SETTLED rather than "Change", which is correct: once the excess
 * is a tip there is nothing to hand back. My first version of this looked for the word
 * "Change" and failed while the pad was right — the screenshot is what showed that.
 */
ok(
  '*** a card over-payment is named as a tip, not as change ***',
  afterCard?.tipNote !== null,
  JSON.stringify(afterCard),
)
ok('  and no change is promised', afterCard?.change === null, JSON.stringify(afterCard?.change))
ok(
  '  the sale reads SETTLED, since a tip leaves nothing to hand back',
  afterCard?.settled === true,
  JSON.stringify(afterCard?.settled),
)
/*
 * AND NO over-tender error.
 *
 * `checkTenders` used to refuse any excess a drawer could not cover, which meant this exact
 * payment showed "Over-tendered by 111.96, but only 0.00 can give change" AT THE SAME TIME
 * as showing the tip. It now takes what the plan claims and only refuses the unexplained
 * remainder.
 */
ok(
  '*** and no "cannot give change" error beside it ***',
  afterCard?.overTenderError === false,
  JSON.stringify(afterCard),
)

const shotPad = await shot('pos-tips-pad')
console.log(`\nscreenshot -> ${shotPad}`)

console.log(fails === 0 ? '\nAll tip-pad checks passed.' : `\n${fails} FAILURE(S)`)
process.exit(fails === 0 ? 0 : 1)
