/*
 * Does closing the counter window actually sign the operator out?
 *
 *   node --env-file=.env --env-file=.env.local scripts/verify-window-session.mjs
 *
 * Drives the REAL app in a real browser rather than the policy function. That
 * function already has a unit suite (scripts/test-window-session.ts) and is not
 * where this can go wrong. What can go wrong is the WIRING: a `wid` signed into
 * the token but never read back, a cookie written on a path the counter routes
 * do not send, a claim dropped by the field-by-field rebuild in
 * `getTillSession`. Every one of those leaves both the typecheck and the screen
 * looking perfectly healthy while the feature does nothing at all.
 *
 * ── WHY IT MINTS THE TILL COOKIE ITSELF ───────────────────────────────────
 *
 * Signing in at the counter needs a PIN, and PINs are bcrypt hashes nobody can
 * read back — so a script that typed one would need a credential written into
 * it. Instead this signs a till token with the app's own SESSION_SECRET, in
 * exactly the shape `counterSignInAction` produces. The server cannot tell the
 * difference, which is the point: everything downstream of the sign-in is the
 * real code path.
 *
 * ── AND WHY THE TAB CLOSE IS SIMULATED BY CLEARING sessionStorage ─────────
 *
 * Closing a tab and opening a new one is precisely "same cookies, empty
 * sessionStorage, no wid cookie". Clearing both here reproduces that state
 * exactly, and unlike an actual close it leaves the debugging session attached
 * so the next navigation can be inspected.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SignJWT } from 'jose'
import { launchChrome } from './lib/cdp-chrome.mjs'

const BASE = process.env.APP_URL || 'http://localhost:4100'
const EMAIL = process.env.DEV_LOGIN_EMAIL
const PASSWORD = process.env.DEV_LOGIN_PASSWORD
const SECRET = process.env.SESSION_SECRET

if (!SECRET || !EMAIL || !PASSWORD) {
  console.error(
    'Needs SESSION_SECRET, DEV_LOGIN_EMAIL and DEV_LOGIN_PASSWORD.\n' +
      '  node --env-file=.env --env-file=.env.local scripts/verify-window-session.mjs',
  )
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

const { wsUrl, close: closeChrome } = await launchChrome('wid', { windowSize: '1400,900' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
process.on('exit', () => {
})


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
await send('Network.enable', {}, sessionId)

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
  await sleep(1200)
  return evaluate('location.pathname')
}

/* ── Sign in to the back office ───────────────────────────────────────────
   The counter layout runs `requireSession` before it ever asks who is at the
   counter, so without this every check below would be measuring the login
   redirect instead of the thing being tested. Driven as a user because the form
   posts a server action — see the note in screenshot.mjs. */
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
  if (!email || !pass) return false
  set(email, ${JSON.stringify(EMAIL)})
  set(pass, ${JSON.stringify(PASSWORD)})
  email.closest('form').querySelector('button[type="submit"]').click()
  return true
})()`)
await sleep(4500)

/* The two-store dev account gets a picker over the login card rather than a
   redirect — see odyssey-store-picker-breaks-verify-scripts. Without this the
   script asserts against a dialog. */
const picked = await evaluate(`(() => {
  const dialog = document.querySelector('dialog[open]')
  if (!dialog || !/choose a store|select which one/i.test(dialog.innerText || '')) return null
  const rows = [...dialog.querySelectorAll('button, a[href]')]
    .filter((el) => (el.textContent || '').trim().length > 0)
    .filter((el) => !/cancel|sign out/i.test(el.textContent))
  if (!rows[0]) return null
  rows[0].click()
  return rows[0].textContent.replace(/\\s+/g, ' ').trim()
})()`)
if (picked) {
  await sleep(4000)
  console.log('chose store:', picked)
}
if ((await evaluate('location.pathname')).startsWith('/select-site')) {
  await evaluate(`(() => {
    const rows = [...document.querySelectorAll('a[href], button')]
      .filter((el) => (el.textContent || '').trim().length > 0)
      .filter((el) => !/sign out/i.test(el.textContent))
    if (rows[0]) rows[0].click()
  })()`)
  await sleep(3500)
}

const landed = await evaluate('location.pathname')
if (landed === '/' ) {
  console.error('Sign-in failed — still on the login page.')
  process.exit(1)
}
console.log('signed in, landed on', landed)

/* Which site the session actually opened, read from the cookie the app just
   set. The till token must name the SAME site or `getTillSession` refuses it on
   the site check rather than the window check — and the script would then
   "pass" for entirely the wrong reason. */
const { cookies } = await send('Network.getCookies', { urls: [BASE] }, sessionId)
const sessionCookie = cookies.find((c) => c.name === 'odyssey_session')
if (!sessionCookie) {
  console.error('No odyssey_session cookie after sign-in.')
  process.exit(1)
}
const claims = JSON.parse(
  Buffer.from(sessionCookie.value.split('.')[1], 'base64url').toString('utf8'),
)
const siteId = Number(claims.siteId)
console.log('site id:', siteId)

const key = new TextEncoder().encode(SECRET)
async function tillToken(wid) {
  const payload = { userId: Number(claims.userId), name: 'Verify Clerk', siteId }
  if (wid) payload.wid = wid
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('8h')
    .sign(key)
}

async function setTill(wid) {
  await send(
    'Network.setCookie',
    { name: 'odyssey_till', value: await tillToken(wid), url: BASE, path: '/', httpOnly: true },
    sessionId,
  )
}
async function setWidCookie(value) {
  await send('Network.setCookie', { name: 'odyssey_wid', value, url: BASE, path: '/' }, sessionId)
}
async function clearWid() {
  await send('Network.deleteCookies', { name: 'odyssey_wid', url: BASE }, sessionId)
  await evaluate(`(() => { try { sessionStorage.clear() } catch {} })()`)
}

/* Gate or counter, decided on text only the PIN pad carries. The invoicing gate
   asks for a PIN; the chrome behind it never does.

   Matched case-insensitively for a reason that has already cost time once here:
   a heading set in `uppercase` reads back from innerText transformed, so a
   case-sensitive probe invents a bug in working code. See
   odyssey-uppercase-headings-fool-probes. */
async function state(route = '/invoicing') {
  await goto(route)
  return evaluate(`(() => {
    const t = (document.body.innerText || '')
    if (/enter your pin/i.test(t)) return 'gate'
    /* The till refuses unlicensed devices BEFORE it asks who is standing there,
       and this headless profile is not a claimed terminal. That screen is
       neither answer, so it is named rather than silently counted as one — a
       'counter' reading here would be a false pass. */
    if (/not licensed|not registered as a till/i.test(t)) return 'unlicensed'
    return 'counter'
  })()`)
}

const TAB = 'verify-tab-0000-1111-2222'

console.log('\n── A session bound to THIS tab ───────────────────────────────')
await setTill(TAB)
await setWidCookie(TAB)
await evaluate(`(() => { try { sessionStorage.setItem('odyssey_wid', ${JSON.stringify(TAB)}) } catch {} })()`)
check('the window that signed in reaches the counter', (await state()) === 'counter')

console.log('\n── The tab is closed and reopened ────────────────────────────')
/* Same till cookie, still valid, still hours from expiry — but a new tab has no
   sessionStorage and therefore sends no wid. This IS the reported problem. */
await clearWid()
const reopened = await state()
check('a reopened tab is sent back to the PIN pad', reopened === 'gate', `saw "${reopened}"`)

console.log('\n── A different tab, same machine ─────────────────────────────')
await setWidCookie('some-other-tab-9999')
const other = await state()
check('another tab is sent back to the PIN pad', other === 'gate', `saw "${other}"`)

console.log('\n── A token minted before this shipped ────────────────────────')
/* No `wid` claim at all. It must still work, or every counter in the field
   meets a PIN pad the moment this deploys. */
await setTill(null)
await clearWid()
const legacy = await state()
check('an unbound token still reaches the counter', legacy === 'counter', `saw "${legacy}"`)

console.log('\n── The till, which shares the same cookie ────────────────────')
/* The POS reads the SAME `odyssey_till` cookie through the same
   `getTillSession`, so the binding either covers both windows or neither.
   Asserted rather than assumed: /pos resolves its operator in the page rather
   than the layout, and a check that lived only in the invoicing layout would
   pass everything above while leaving the till wide open. */
await setTill(TAB)
await setWidCookie(TAB)
const tillBound = await state('/pos')
if (tillBound === 'unlicensed') {
  /* Not a failure and not a pass. This machine is not a claimed terminal, so
     the licence screen stands in front of the PIN pad and the question cannot
     be asked here at all. Said out loud rather than skipped quietly. */
  console.log('  SKIP  the till (this machine is not a claimed terminal)')
} else {
  check('the till reaches the sale on its own tab', tillBound === 'counter', `saw "${tillBound}"`)
  await clearWid()
  const tillReopened = await state('/pos')
  check(
    'a reopened till tab is sent back to the PIN pad',
    tillReopened === 'gate',
    `saw "${tillReopened}"`,
  )
}

console.log(failures === 0 ? '\nAll good.\n' : `\n${failures} failed.\n`)
process.exit(failures === 0 ? 0 : 1)
