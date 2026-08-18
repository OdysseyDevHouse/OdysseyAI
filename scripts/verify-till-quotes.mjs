// Proves quotes work at the till: the list is the shop's, a quote comes onto
// the basket, and it stays a QUOTE once it is there.
//
//   node --env-file=.env --env-file=.env.local scripts/verify-till-quotes.mjs
//
// BOTH env files: the login lives in .env.local and SESSION_SECRET — which the
// till cookie is signed with — lives in .env.
//
// ── WHAT THIS IS FOR ─────────────────────────────────────────────────────────
//
// The back office has had a quote register for a long time. The till had the
// module but no way to reach an existing quote, so a customer walking in with
// one had to have it keyed in again by hand.
//
// The assertions follow a cashier: the recall key is still "Saved" on a sale,
// becomes "Quotes" on a quote, opens the shop's list, brings one onto the
// basket — and leaves the till writing a QUOTE rather than an invoice. That
// last one is the one that matters: an invoice there would fork the customer's
// quote into a second document with both screens looking correct.
//
// ── GETTING PAST THE PIN GATE ────────────────────────────────────────────────
//
// Same as verify-pos-returns.mjs: mint the till cookie, which is a JWT signed
// with SESSION_SECRET. Not a PIN written to a real users row.
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SignJWT } from 'jose'
import { launchChrome } from './lib/cdp-chrome.mjs'

const EMAIL = process.env.DEV_LOGIN_EMAIL
const PASSWORD = process.env.DEV_LOGIN_PASSWORD
const SECRET = process.env.SESSION_SECRET
const BASE = process.env.APP_URL || 'http://localhost:4100'
const OUT = process.env.SHOT_DIR || path.join(process.cwd(), '.screenshots')
/* A serial_number from cp2_devices with status='active'. Override with
   VERIFY_DEVICE_ID — a device that names no row renders "not set up as a till"
   while every API call in here goes on passing. */
const DEVICE = process.env.VERIFY_DEVICE_ID || '8d3bc8d3-0d97-4cc1-91cc-02afd3fa4c8c'

if (!EMAIL || !PASSWORD) {
  console.error('Set DEV_LOGIN_EMAIL / DEV_LOGIN_PASSWORD in .env.local')
  process.exit(1)
}
if (!SECRET) {
  console.error('SESSION_SECRET is not set — the till cookie cannot be minted.')
  process.exit(1)
}

mkdirSync(OUT, { recursive: true })

const { wsUrl, close: closeChrome } = await launchChrome('quo')

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
  writeFileSync(file, Buffer.from(data, 'base64'))
  return file
}

let fails = 0
const ok = (label, cond, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

/* ── Sign in ────────────────────────────────────────────────────────────────── */

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

for (let i = 0; i < 40; i++) {
  const state = await evaluate(
    [
      '(() => {',
      '  const dialog = document.querySelector("dialog[open]")',
      '  if (dialog && /choose a store|select which one/i.test(dialog.innerText || "")) return "picker"',
      '  return location.pathname.startsWith("/login") || location.pathname === "/" ? "login" : "app"',
      '})()',
    ].join('\n'),
  )
  if (state === 'picker' || state === 'app') break
  await sleep(500)
}

/* The dev account reaches more than one store, so sign-in ends on a picker over
   the login card. Skipping it does not fail loudly — the catalog fetch below
   returns the picker's HTML with a 200 and r.json() dies on "<!DOCTYPE". */
const picked = await evaluate(
  [
    '(() => {',
    '  const dialog = document.querySelector("dialog[open]")',
    '  if (!dialog || !/choose a store|select which one/i.test(dialog.innerText || "")) return "no picker"',
    '  const rows = [...dialog.querySelectorAll("button, a[href]")]',
    '    .filter((el) => (el.textContent || "").trim().length > 0)',
    '    .filter((el) => !/cancel|sign out/i.test(el.textContent))',
    '  const want = ' + JSON.stringify(process.env.SHOT_SITE || ''),
    '  const hit = want',
    '    ? rows.find((el) => el.textContent.toLowerCase().includes(want.toLowerCase()))',
    '    : rows[0]',
    '  if (!hit) return null',
    '  hit.click()',
    '  return hit.textContent.replace(/\\s+/g, " ").trim()',
    '})()',
  ].join('\n'),
)
if (picked === null) {
  console.error('The store picker opened but held no store to choose.')
  process.exit(1)
}
if (picked !== 'no picker') {
  await sleep(4000)
  console.log('chose store:', picked, '->', await evaluate('location.pathname'))
}

/* ── Past the PIN gate, by minting the till cookie the action would issue ───── */

const catalog = await evaluate(
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
ok('the catalog answers for this device', catalog?.ok === true, JSON.stringify(catalog?.status ?? ''))

const token = await new SignJWT({
  userId: catalog?.operator?.userId ?? 1,
  name: 'Quotes verifier',
  siteId: catalog?.siteId ?? 1,
})
  .setProtectedHeader({ alg: 'HS256' })
  .setIssuedAt()
  .setExpirationTime('8h')
  .sign(new TextEncoder().encode(SECRET))

await send(
  'Network.setCookie',
  { name: 'odyssey_till', value: token, domain: 'localhost', path: '/', httpOnly: true },
  sessionId,
)
/* The key deviceId() actually reads — see src/lib/deviceId.ts. */
await evaluate(`localStorage.setItem('odyssey.device.id', ${JSON.stringify(DEVICE)}), true`)

consoleErrors.length = 0
const landed = await goto('/pos')
const stillGated = await evaluate(`document.body.innerText.includes('Enter your PIN')`)
ok('the till renders rather than the PIN gate', landed === '/pos' && !stillGated, landed)

if (stillGated) {
  console.log('\nStill at the gate — the minted cookie was not accepted, so nothing')
  console.log('below can run. Nothing about the menu is proven either way.')
  console.log(`\n${fails} FAILURE(S)`)
  process.exit(1)
}

/* ── Helpers that talk to the screen ────────────────────────────────────────── */

const heading = () =>
  evaluate(
    [
      '(() => {',
      '  const h = document.querySelector("header")',
      '  return h ? (h.innerText || "").replace(/\\s+/g, " ").trim() : ""',
      '})()',
    ].join('\n'),
  )

const onGate = () =>
  evaluate(
    [
      '(() => {',
      '  const h = document.querySelector("header h1")',
      '  return h ? /odyssey/i.test(h.innerText || "") : false',
      '})()',
    ].join('\n'),
  )

/** Items in the basket, off the header's own pill. */
const lineCount = () =>
  evaluate(
    [
      '(() => {',
      '  const h = document.querySelector("header")',
      '  if (!h) return null',
      '  const m = (h.innerText || "").match(/(\\d+)\\s+items?\\b/i)',
      '  return m ? Number(m[1]) : null',
      '})()',
    ].join('\n'),
  )

const openModuleMenu = () =>
  evaluate(
    [
      '(() => {',
      '  const btn = [...document.querySelectorAll("header button")]',
      '    .find((b) => /go to/i.test(b.getAttribute("aria-label") || b.title || ""))',
      '  if (!btn) return false',
      '  btn.click()',
      '  return true',
      '})()',
    ].join('\n'),
  )

const pickModule = (label) =>
  evaluate(
    [
      '(() => {',
      '  const p = document.querySelector("aside[aria-label=\\"Till modules\\"]")',
      '  if (!p) return "no panel"',
      '  const row = [...p.querySelectorAll("button")]',
      `    .find((el) => (el.innerText || "").toLowerCase().includes(${JSON.stringify(
        String(label).toLowerCase(),
      )}))`,
      '  if (!row) return "no row"',
      '  row.click()',
      '  return "clicked"',
      '})()',
    ].join('\n'),
  )

/**
 * The pane's recall key — "Saved" on a sale, "Quotes" on a quote.
 *
 * Matched on its LABEL rather than its position, because the whole assertion of
 * this phase is that the label changes with the module.
 */
const recallKeyLabel = () =>
  evaluate(
    [
      '(() => {',
      '  const btns = [...document.querySelectorAll("button")]',
      '    .filter((b) => !b.closest("header") && !b.closest("dialog"))',
      '    .filter((b) => /^(saved|quotes)\\b/i.test((b.innerText || "").trim()))',
      '  return btns.length ? (btns[0].innerText || "").replace(/\\s+/g, " ").trim() : null',
      '})()',
    ].join('\n'),
  )

const pressRecallKey = () =>
  evaluate(
    [
      '(() => {',
      '  const btn = [...document.querySelectorAll("button")]',
      '    .filter((b) => !b.closest("header") && !b.closest("dialog"))',
      '    .find((b) => /^(saved|quotes)\\b/i.test((b.innerText || "").trim()))',
      '  if (!btn) return "no key"',
      '  btn.click()',
      '  return "clicked"',
      '})()',
    ].join('\n'),
  )

/** The open dialog's text, or null. */
const dialogText = () =>
  evaluate(
    [
      '(() => {',
      '  const d = document.querySelector("dialog[open]")',
      '  return d ? (d.innerText || "").replace(/\\s+/g, " ").trim() : null',
      '})()',
    ].join('\n'),
  )

/**
 * The quote rows in the open dialog, with whether each is tappable.
 *
 * `disabled` is the assertion that matters: an accepted quote is already an
 * invoice, and a till that let somebody recall one would sell the same goods
 * twice with nothing on screen looking wrong.
 */
const quoteRows = () =>
  evaluate(
    [
      '(() => {',
      '  const d = document.querySelector("dialog[open]")',
      '  if (!d) return null',
      '  return [...d.querySelectorAll("button")]',
      '    .filter((b) => !/^close$/i.test((b.innerText || "").trim()))',
      '    .filter((b) => (b.innerText || "").trim().length > 8)',
      '    .map((b) => ({',
      '      text: (b.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 90),',
      '      disabled: b.disabled === true,',
      '    }))',
      '})()',
    ].join('\n'),
  )

const closeDialog = () =>
  evaluate(
    [
      '(() => {',
      '  const d = document.querySelector("dialog[open]")',
      '  if (!d) return "no dialog"',
      '  const btn = [...d.querySelectorAll("button")].find((b) => /^close$/i.test((b.innerText || "").trim()))',
      '  if (!btn) return "no close"',
      '  btn.click()',
      '  return "clicked"',
      '})()',
    ].join('\n'),
  )

/* ── Onto the sale screen ───────────────────────────────────────────────────── */

if (await onGate()) {
  const entered = await evaluate(
    [
      '(() => {',
      '  const all = [...document.querySelectorAll("button")].filter((b) => !b.closest("header"))',
      '  const quick = all.find((b) => /quick sale|walk-?in|no table/i.test(b.innerText || ""))',
      '  if (quick) { quick.click(); return "quick sale" }',
      '  const table = all.find((b) => /^[A-Z]?\\d+$|table/i.test((b.innerText || "").trim()))',
      '  if (table) { table.click(); return (table.innerText || "").trim().slice(0, 20) }',
      '  return null',
      '})()',
    ].join('\n'),
  )
  await sleep(2500)
  console.log(`through the floor gate via: ${entered ?? 'nothing found'}`)
}

const reachedSale = !(await onGate())
ok('the sale screen is reachable', reachedSale, await heading())
if (!reachedSale) {
  console.log('\nStill on a gate. Nothing about quotes is proven either way.')
  console.log(`\n${fails} FAILURE(S)`)
  process.exit(1)
}

/* ── 1. On a SALE, the recall key is still the parked baskets ───────────────── */

/*
 * Asserted first, and it is not a formality.
 *
 * One key serves both modules — it opens parked sales on a sale and the shop's
 * quotes on a quote. The risk of that design is the quote list leaking onto the
 * ordinary sale screen, where a cashier reaching for a parked basket would get
 * a list of quotes instead. So the sale case is pinned down before the quote
 * case is even opened.
 */
/*
 * ON A HOSPITALITY TILL THE KEY IS LEGITIMATELY ABSENT on a sale, because a
 * waiter's basket parks to a TABLE through Close rather than to a saved-sale
 * list. So this asserts what is true either way: if a recall key is showing on
 * a sale, it must be the parked baskets and never the quote list.
 *
 * Written this way after the first run reported a failure that was really the
 * script assuming a retail layout — the till under test is hospitality, and the
 * absent key was correct. What the run DID uncover was real: the same rule hid
 * the key on a quote too, where it had no business applying.
 */
const saleKey = await recallKeyLabel()
ok(
  'a sale never shows the quote list',
  saleKey === null || /^saved/i.test(saleKey),
  saleKey === null ? 'no recall key on a sale (hospitality parks to a table)' : saleKey,
)

/* ── 2. Switch to quotes, and the key becomes the quote list ────────────────── */

await openModuleMenu()
await sleep(700)
const switched = await pickModule('Quotes')
ok('the till can be switched to quotes', switched === 'clicked', switched)
await sleep(1500)

const quoteHeading = await heading()
ok('the header names a quote', /quote/i.test(quoteHeading), quoteHeading.slice(0, 40))

const quoteKey = await recallKeyLabel()
ok(
  'the recall key becomes the quote list',
  /^quotes/i.test(quoteKey || ''),
  quoteKey || 'no key found',
)

/* ── 3. The list opens, and shows the SHOP's quotes ─────────────────────────── */

const pressed = await pressRecallKey()
ok('the quote list opens', pressed === 'clicked', pressed)
await sleep(2500)

const listed = await dialogText()
ok(
  'it is the quotes dialog',
  listed !== null && /quotes/i.test(listed || '') && /tap one/i.test(listed || ''),
  (listed || 'no dialog').slice(0, 80),
)
await shot('till-quotes-list')

const rows = await quoteRows()
console.log(`   (${(rows || []).length} quote row(s) listed)`)
for (const r of (rows || []).slice(0, 6)) {
  console.log(`     ${r.disabled ? 'inert ' : 'tap   '} ${r.text}`)
}

/*
 * THE LIST IS NOT EMPTY — and this is checked rather than assumed.
 *
 * Every assertion below reads a row. Over an empty list they would all pass
 * while proving nothing, which is the vacuous-assertion trap this repo has been
 * bitten by before. The site has quotes (draft and issued both), so an empty
 * list here means the query is wrong, not that the shop has none.
 */
const haveRows = Array.isArray(rows) && rows.length > 0
ok('the shop\'s quotes are listed', haveRows, `${(rows || []).length} row(s)`)

if (!haveRows) {
  console.log('\nNo rows to work with, so recall was never exercised.')
  console.log(`\n${fails} FAILURE(S)`)
  process.exit(1)
}

/*
 * Settled quotes are shown but inert.
 *
 * Not asserted as "there is at least one disabled row" — this site may have no
 * accepted quote, and demanding one would make the script fail on a database
 * that is simply in a different state. What IS asserted: every row the list
 * marks as accepted or declined must be inert, and every open one tappable.
 * That holds whatever the data happens to be.
 */
const wrongState = (rows || []).filter((r) => {
  const settled = /already invoiced|the customer said no|accepted|declined/i.test(r.text)
  return settled ? !r.disabled : r.disabled
})
ok(
  'settled quotes are inert and open ones are tappable',
  wrongState.length === 0,
  wrongState.map((r) => r.text.slice(0, 40)).join(' | '),
)

/* ── 4. Tapping one puts it on the till ─────────────────────────────────────── */

const tappable = (rows || []).findIndex((r) => !r.disabled)
if (tappable < 0) {
  console.log('')
  console.log('**SKIPPED**  recall — every listed quote is settled, so none could be')
  console.log('             brought onto the till. Nothing is proven about recall.')
  console.log(`\n${fails} FAILURE(S)`)
  process.exit(fails > 0 ? 1 : 0)
}

const wanted = rows[tappable].text
const tapped = await evaluate(
  [
    '(() => {',
    '  const d = document.querySelector("dialog[open]")',
    '  if (!d) return "no dialog"',
    '  const rows = [...d.querySelectorAll("button")]',
    '    .filter((b) => !/^close$/i.test((b.innerText || "").trim()))',
    '    .filter((b) => (b.innerText || "").trim().length > 8)',
    '  const hit = rows.filter((b) => !b.disabled)[0]',
    '  if (!hit) return "none tappable"',
    '  hit.click()',
    '  return "clicked"',
    '})()',
  ].join('\n'),
)
ok('a quote can be tapped', tapped === 'clicked', tapped)
await sleep(3500)

const afterRecall = await dialogText()
ok('the list closes once a quote is taken', afterRecall === null, (afterRecall || '').slice(0, 60))

const recalledLines = await lineCount()
ok(
  'the quote lines land in the basket',
  typeof recalledLines === 'number' && recalledLines > 0,
  `${recalledLines} item(s) — wanted: ${wanted.slice(0, 40)}`,
)

/*
 * AND IT IS STILL A QUOTE.
 *
 * The single most important assertion here. If recall left the till on an
 * invoice, saving would write a SECOND document and leave the original quote
 * untouched — the customer's quote silently forked, with both screens looking
 * correct. The header is what says which it is.
 */
const stillQuote = await heading()
ok(
  'the till is still writing a quote, not an invoice',
  /quote/i.test(stillQuote) && !/current sale/i.test(stillQuote),
  stillQuote.slice(0, 40),
)
await shot('till-quotes-recalled')

/* ── 5. A second recall is refused over a basket ────────────────────────────── */

/*
 * Two quotes' lines in one basket is one document for two customers. The till
 * must say what is in the way rather than silently combining them.
 */
await pressRecallKey()
await sleep(2000)
const second = await evaluate(
  [
    '(() => {',
    '  const d = document.querySelector("dialog[open]")',
    '  if (!d) return "no dialog"',
    '  const hit = [...d.querySelectorAll("button")]',
    '    .filter((b) => !/^close$/i.test((b.innerText || "").trim()))',
    '    .filter((b) => (b.innerText || "").trim().length > 8)',
    '    .filter((b) => !b.disabled)[0]',
    '  if (!hit) return "none tappable"',
    '  hit.click()',
    '  return "clicked"',
    '})()',
  ].join('\n'),
)
await sleep(1800)

if (second === 'clicked') {
  const linesNow = await lineCount()
  ok(
    'a second quote does not merge into the basket',
    linesNow === recalledLines,
    `${recalledLines} before, ${linesNow} after`,
  )
} else {
  console.log(`   (second recall not exercised: ${second})`)
}
await closeDialog()
await sleep(600)

/* ── 6. Saving writes back to the SAME quote ────────────────────────────────── */

/*
 * THE ASSERTION THIS PHASE EXISTS FOR.
 *
 * A recalled quote carries its document id, so saving must UPDATE it. If the id
 * were dropped anywhere along the way the save would write a second quote and
 * leave the customer's original untouched — and both screens would look
 * correct, which is what makes it worth proving rather than reasoning about.
 *
 * Counted through the till's own list rather than the database: the number of
 * quotes in the shop before and after. A fork shows up as one more.
 */
const countQuotes = async () => {
  await pressRecallKey()
  await sleep(2200)
  const rows = await quoteRows()
  await closeDialog()
  await sleep(600)
  return Array.isArray(rows) ? rows.length : null
}

const before = await countQuotes()

/*
 * The FINISH key, which on a quote reads "Save R1 150.00" — the one that ends
 * the document, in the slot where an invoice shows Pay.
 *
 * Matched on the amount rather than on the word alone: the pane also carries a
 * ghost "Save" for parking, and clicking that would prove something different
 * while looking identical in the log.
 */
const saved = await evaluate(
  [
    '(() => {',
    '  const btn = [...document.querySelectorAll("button")]',
    '    .filter((b) => !b.closest("header") && !b.closest("dialog"))',
    '    .find((b) => /^save\\s+R\\s?[\\d.,]/i.test((b.innerText || "").replace(/\\s+/g, " ").trim()))',
    '  if (!btn) return "no finish key"',
    '  if (btn.disabled) return "finish key disabled"',
    '  btn.click()',
    '  return "clicked"',
    '})()',
  ].join('\n'),
)
await sleep(3500)

if (saved !== 'clicked') {
  console.log(`   (save not exercised: ${saved})`)
} else {
  const after = await countQuotes()
  ok(
    'saving updates the quote instead of forking it',
    typeof before === 'number' && before === after,
    `${before} quote(s) before, ${after} after`,
  )
  await shot('till-quotes-saved')
}

/* ── 7. Leaving the quote hands the claim back ──────────────────────────────── */

/*
 * A TERMINAL CLAIM NEVER EXPIRES — that is deliberate (an offline till looks
 * exactly like a dead one), and it is what makes releasing it on the way out
 * load-bearing rather than tidy. A quote left claimed is a quote no other till
 * can ever open again without a supervisor.
 *
 * This was a real gap: the re-park action guarded on `draft`/`saved`, so an
 * ISSUED quote fell straight through it and kept its claim forever. Proven by
 * re-opening the list and checking the quote is offered again — which is the
 * same thing the next cashier would do.
 */
await evaluate(
  [
    '(() => {',
    '  const btn = [...document.querySelectorAll("button")]',
    '    .filter((b) => !b.closest("header") && !b.closest("dialog"))',
    '    .find((b) => /^close\\b/i.test((b.innerText || "").trim()))',
    '  if (!btn) return "no close key"',
    '  btn.click()',
    '  return "clicked"',
    '})()',
  ].join('\n'),
)
await sleep(2500)

/* Close on a hospitality till goes back to the floor, so walk in again. */
if (await onGate()) {
  await evaluate(
    [
      '(() => {',
      '  const all = [...document.querySelectorAll("button")].filter((b) => !b.closest("header"))',
      '  const quick = all.find((b) => /quick sale|walk-?in|no table/i.test(b.innerText || ""))',
      '  if (quick) { quick.click(); return true }',
      '  return false',
      '})()',
    ].join('\n'),
  )
  await sleep(2500)
}

/* Back to the quote module — Close cleared the basket and with it the mode. */
if (!/quote/i.test(await heading())) {
  await openModuleMenu()
  await sleep(700)
  await pickModule('Quotes')
  await sleep(1500)
}

/*
 * Checked in the DATABASE, not by re-opening the list.
 *
 * The list would pass either way and prove nothing: a claim held by THIS
 * terminal is freely reclaimable by design — a till must never be locked out of
 * its own bill — so the row would be tappable whether the claim was handed back
 * or not. The question is whether ANOTHER till could take it, and the only
 * honest answer to that is the claim column itself.
 *
 * Read straight from MariaDB rather than through a probe endpoint: adding a
 * route to production so a test can look at a column is the wrong trade.
 */
const held = await (async () => {
  const mysql = await import('mysql2/promise')
  const root = await mysql.default.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    timezone: 'Z',
  })
  const [sites] = await root.query(
    "SELECT database_name FROM cp2_site_databases WHERE status='active' LIMIT 1",
  )
  await root.end()
  if (!sites.length) return null

  const site = await mysql.default.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: sites[0].database_name,
    timezone: 'Z',
  })
  const [rows] = await site.query(
    `SELECT COUNT(*) AS n FROM sales_documents
      WHERE doc_type = 'quote' AND claimed_terminal_id IS NOT NULL`,
  )
  await site.end()
  return Number(rows[0].n)
})()

ok(
  'the claim is handed back when the till leaves the quote',
  held === 0,
  held === null ? 'no active site to read' : `${held} quote(s) still claimed`,
)

/* ── Console ────────────────────────────────────────────────────────────────── */

const noisy = consoleErrors.filter(
  (m) => !/favicon|Download the React DevTools|Failed to load resource/i.test(m),
)
ok('no console errors while driving quotes', noisy.length === 0, noisy.slice(0, 2).join(' | '))

console.log(`\nShots in ${OUT}`)
console.log(`${fails} FAILURE(S)`)
process.exit(fails > 0 ? 1 : 0)
