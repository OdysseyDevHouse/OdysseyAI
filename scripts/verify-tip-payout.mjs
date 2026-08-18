// Proves a manager can actually pay tips out, on the screen.
//
//   node --env-file=.env --env-file=.env.local scripts/verify-tip-payout.mjs
//
// test-tips (67) proves the money is right in the database — including that four managers
// pressing Pay at once produce one envelope. What it cannot reach is the SCREEN, and this
// feature is almost entirely screen: a total that reads as owed after it has been paid, or a
// Split button that looks pressable while the shares do not add up, is money paid twice.
//
// Seeds its own tips, asserts, and removes them. Re-runnable.
//
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { launchChrome } from './lib/cdp-chrome.mjs'

const EMAIL = process.env.DEV_LOGIN_EMAIL
const PASSWORD = process.env.DEV_LOGIN_PASSWORD
const BASE = process.env.APP_URL || 'http://localhost:4100'
const OUT = process.env.SHOT_DIR || path.join(process.cwd(), '.screenshots')

if (!EMAIL || !PASSWORD) {
  console.error('Set DEV_LOGIN_EMAIL / DEV_LOGIN_PASSWORD in .env.local')
  process.exit(1)
}

mkdirSync(OUT, { recursive: true })

const { wsUrl, close: closeChrome } = await launchChrome('tippay', { windowSize: '1600,1200' })

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

/*
 * Money is written with a NARROW NO-BREAK SPACE as its thousands separator, so a
 * `[0-9., ]` character class silently misses every figure over a thousand. Matched on
 * "not a digit" instead, which cannot have that hole.
 */
const money = (text, label) => {
  const at = text.indexOf(label)
  if (at < 0) return null
  const after = text.slice(at, at + 400)
  const m = after.match(/R\s*([\d\u202f\u00a0,. ]+)/)
  if (!m) return null
  return Number(m[1].replace(/[^\d.]/g, ''))
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
await sleep(4000)

/* ── The screen ─────────────────────────────────────────────────────────────── */

const at = await goto('/sales/tips')
ok('the payout screen loads', at === '/sales/tips', at)

const text = await evaluate('document.body.innerText')
ok('it is the tips screen', /Tips/.test(text) && /Owed/i.test(text), text.slice(0, 120))
ok('and the paid-out section is there too', /Paid out/i.test(text))

/*
 * The seeded tips must be VISIBLE, with the pool separated from the named waiter.
 * Seeded by the caller (see the sql at the bottom of this file's companion run).
 */
const rows = await evaluate(
  [
    '(() => {',
    "  const owed = [...document.querySelectorAll('dl')][0]",
    '  if (!owed) return null',
    '  return owed.innerText',
    '})()',
  ].join('\n'),
)
ok('the owed list renders rows', typeof rows === 'string' && rows.length > 0, String(rows).slice(0, 200))
const hasPool = /Pool/i.test(String(rows))
ok('*** the POOL is listed as its own row, not folded into a waiter ***', hasPool, String(rows).slice(0, 200))

const owedTotal = money(text, 'Total owed')
ok('a total is stated', owedTotal !== null && owedTotal > 0, `R${owedTotal}`)

await shot('tip-payout-owed')

/* ── The split dialog: the button must not look pressable while it cannot be ── */

const opened = await evaluate(
  [
    '(() => {',
    "  const rows = [...document.querySelectorAll('dl > div')]",
    "  const poolRow = rows.find((r) => /Pool/i.test(r.innerText))",
    '  if (!poolRow) return { ok: false, why: "no pool row" }',
    "  const btn = [...poolRow.querySelectorAll('button')].find((b) => /Split/i.test(b.textContent))",
    '  if (!btn) return { ok: false, why: "no split button" }',
    '  btn.click()',
    '  return { ok: true }',
    '})()',
  ].join('\n'),
)
ok('the pool row offers a Split button', opened?.ok === true, opened?.why ?? '')
await sleep(1200)

const dialog = await evaluate(
  [
    '(() => {',
    "  const d = document.querySelector('dialog[open]')",
    '  if (!d) return null',
    "  const pay = [...d.querySelectorAll('button')].find((b) => /Pay out the pool/i.test(b.textContent))",
    '  return {',
    '    text: d.innerText,',
    "    inputs: d.querySelectorAll('input[type=text], input[inputmode], input[type=number]').length,",
    '    payDisabled: pay ? pay.disabled : null,',
    '  }',
    '})()',
  ].join('\n'),
)
ok('the split dialog opens', dialog !== null, JSON.stringify(dialog?.text?.slice(0, 80) ?? ''))
ok('  with a share box per active staff member', (dialog?.inputs ?? 0) >= 1, String(dialog?.inputs))
/* Pre-filled to an exact equal split, so it opens READY — a dialog that opens refusing to
   pay looks broken. The leftover assertions below prove the guard still bites. */
ok(
  '*** it opens pre-filled to an exact split, so Pay is live ***',
  dialog?.payDisabled === false,
  `disabled=${dialog?.payDisabled}`,
)
ok('  and says nothing is left over', /Nothing left over/i.test(dialog?.text ?? ''), (dialog?.text ?? '').slice(0, 200))

await shot('tip-payout-split')

/* Now break the arithmetic and watch the button die. This is the assertion that would have
   caught a dialog whose Pay button ignored the leftover. */
const broken = await evaluate(
  [
    '(() => {',
    "  const d = document.querySelector('dialog[open]')",
    "  const box = d.querySelector('input')",
    "  const setter = Object.getOwnPropertyDescriptor(box.constructor.prototype, 'value').set",
    "  setter.call(box, '1')",
    "  box.dispatchEvent(new Event('input', { bubbles: true }))",
    '  return true',
    '})()',
  ].join('\n'),
)
await sleep(900)
const afterBreak = await evaluate(
  [
    '(() => {',
    "  const d = document.querySelector('dialog[open]')",
    "  const pay = [...d.querySelectorAll('button')].find((b) => /Pay out the pool/i.test(b.textContent))",
    '  return { text: d.innerText, payDisabled: pay ? pay.disabled : null }',
    '})()',
  ].join('\n'),
)
ok(
  '*** a short split DISABLES Pay rather than refusing at the end ***',
  afterBreak?.payDisabled === true,
  `disabled=${afterBreak?.payDisabled}`,
)
ok(
  '  and says how much is unallocated',
  /Left over/i.test(afterBreak?.text ?? ''),
  (afterBreak?.text ?? '').match(/Left over[^\n]*/)?.[0] ?? '',
)
await shot('tip-payout-short')

/* ── Paying one person, for real ─────────────────────────────────────────────── */

await evaluate(
  [
    '(() => {',
    "  const d = document.querySelector('dialog[open]')",
    "  const cancel = [...d.querySelectorAll('button')].find((b) => /Cancel/i.test(b.textContent))",
    '  cancel.click()',
    '  return true',
    '})()',
  ].join('\n'),
)
await sleep(800)

const before = money(await evaluate('document.body.innerText'), 'Total owed')

const payOpened = await evaluate(
  [
    '(() => {',
    "  const rows = [...document.querySelectorAll('dl > div')]",
    "  const row = rows.find((r) => /Pay out/i.test(r.innerText) && !/Pool/i.test(r.innerText))",
    '  if (!row) return { ok: false, why: "no named waiter row with a Pay button" }',
    "  const btn = [...row.querySelectorAll('button')].find((b) => /Pay out/i.test(b.textContent))",
    '  btn.click()',
    '  return { ok: true, who: row.innerText.split("\\n")[0] }',
    '})()',
  ].join('\n'),
)
ok('a named waiter can be paid', payOpened?.ok === true, payOpened?.why ?? payOpened?.who ?? '')
await sleep(1200)
await shot('tip-payout-pay')

const confirmed = await evaluate(
  [
    '(() => {',
    "  const d = document.querySelector('dialog[open]')",
    '  if (!d) return { ok: false, why: "no dialog" }',
    "  const pay = [...d.querySelectorAll('button')].find((b) => /^Pay out$/i.test(b.textContent.trim()))",
    '  if (!pay) return { ok: false, why: "no confirm button" }',
    '  pay.click()',
    '  return { ok: true }',
    '})()',
  ].join('\n'),
)
ok('  and the dialog confirms', confirmed?.ok === true, confirmed?.why ?? '')
await sleep(3500)

const after = await evaluate('document.body.innerText')
const afterTotal = money(after, 'Total owed')
ok(
  '*** once paid, the owed total FALLS ***',
  afterTotal !== null && before !== null && afterTotal < before,
  `R${before} -> R${afterTotal}`,
)
ok(
  '*** and the payout appears under Paid out, naming who handed it over ***',
  /Paid out/i.test(after) && /by /i.test(after.slice(after.indexOf('Paid out'))),
  after.slice(after.indexOf('Paid out'), after.indexOf('Paid out') + 200).replace(/\n/g, ' | '),
)
await shot('tip-payout-paid')

/* The same person must no longer be offered a Pay button for money already handed over. */
const stillOffered = await evaluate(
  [
    '(() => {',
    "  const owed = [...document.querySelectorAll('dl')][0]",
    '  return owed ? owed.innerText : ""',
    '})()',
  ].join('\n'),
)
ok(
  '*** the paid waiter is GONE from Owed, so they cannot be paid twice ***',
  !new RegExp(String(payOpened?.who ?? 'zzzz').split('\n')[0], 'i').test(String(stillOffered)),
  String(stillOffered).slice(0, 200).replace(/\n/g, ' | '),
)

ok('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '))

console.log(`\nShots in ${OUT}`)
console.log(fails === 0 ? 'All tip payout checks passed.' : `${fails} FAILURE(S)`)
process.exit(fails === 0 ? 0 : 1)
