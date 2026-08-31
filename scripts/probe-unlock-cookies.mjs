// Drives a REAL unlock in a browser and reports whether the session survives.
//
//   APP_URL=http://localhost:4200 TILL_PIN=1234 node --env-file=.env.local scripts/probe-unlock-cookies.mjs
//
// The tablet loops: PIN accepted, back to the pad, no error. The suspicion is
// `Secure` cookies on a plain-HTTP origin — the browser drops them, /pos sees no
// session and bounces. This proves it by doing what the tablet does: claim the
// tablet's device id, submit the PIN, then look at what the jar actually holds.
import { launchChrome, sleep } from './lib/cdp-chrome.mjs'

const BASE = process.env.APP_URL || 'http://localhost:4200'
const DEVICE = process.env.TABLET_DEVICE_ID || 'c4b66d1f-ab3e-4e88-bae4-b95e1a1731fe'
const PIN = process.env.TILL_PIN

if (!PIN) { console.error('Set TILL_PIN to the operator PIN.'); process.exit(1) }

const { wsUrl, close } = await launchChrome('unlockck')
const ws = new WebSocket(wsUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let id = 0
const pending = new Map()
ws.onmessage = (e) => {
  const m = JSON.parse(e.data); if (m.method) return
  const entry = pending.get(m.id); if (!entry) return
  pending.delete(m.id); m.error ? entry.reject(new Error(JSON.stringify(m.error))) : entry.resolve(m.result)
}
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => { const n = ++id; pending.set(n, { resolve, reject }); ws.send(JSON.stringify({ id: n, method, params, sessionId })) })
const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
for (const d of ['Page', 'Runtime', 'Network']) await send(d + '.enable', {}, sessionId)
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId)
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
  return r.result?.value
}

let fails = 0
const ok = (label, cond, extra = '') => { if (!cond) fails++; console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`) }

// Be the tablet: same device id, same origin.
await send('Page.navigate', { url: BASE + '/pos-unlock' }, sessionId)
await sleep(3000)
await evaluate(`localStorage.setItem('odyssey.device.id', ${JSON.stringify(DEVICE)}), true`)
await send('Page.navigate', { url: BASE + '/pos-unlock' }, sessionId)
await sleep(3500)

const before = await send('Network.getCookies', { urls: [BASE] }, sessionId)
console.log(`cookies before unlock: ${before.cookies.length}`)

// Type the PIN into the pad and submit, the way a finger does.
const typed = await evaluate(`
  (() => {
    const digits = ${JSON.stringify(PIN)}.split('')
    const btns = [...document.querySelectorAll('button')]
    for (const d of digits) {
      const b = btns.find(x => x.textContent.trim() === d)
      if (!b) return 'no key for ' + d
      b.click()
    }
    const okBtn = btns.find(x => /^OK$/i.test(x.textContent.trim()))
    if (!okBtn) return 'no OK key'
    okBtn.click()
    return 'submitted'
  })()
`)
console.log(`pad: ${typed}`)
await sleep(6000)

const after = await send('Network.getCookies', { urls: [BASE] }, sessionId)
const where = await evaluate('location.pathname')
const bodyText = await evaluate('document.body.innerText.slice(0, 200)')

console.log(`\nafter unlock: at ${where}`)
console.log(`cookies now: ${after.cookies.length}`)
for (const c of after.cookies) {
  console.log(`  ${c.name.padEnd(24)} secure:${c.secure ? 'YES' : 'no'}  httpOnly:${c.httpOnly ? 'yes' : 'no'}  sameSite:${c.sameSite ?? '-'}`)
}

ok('the unlock left a session cookie behind', after.cookies.length > before.cookies.length,
   after.cookies.length === before.cookies.length ? 'NONE kept — this is the loop' : '')
ok('it landed on the till, not back at the pad', where === '/pos', `at ${where}`)
if (where !== '/pos') console.log(`\nscreen says:\n   ${bodyText.split('\n').slice(0,4).join('\n   ')}`)

console.log(`\n(origin was ${BASE} — a Secure cookie is dropped on plain http)`)
await close()
process.exit(fails === 0 ? 0 : 1)
