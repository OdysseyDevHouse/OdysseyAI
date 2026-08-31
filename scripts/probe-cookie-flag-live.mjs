// Reads the Secure flag off a cookie this server actually SETS.
//
//   node scripts/probe-cookie-flag-live.mjs
//
// Rather than infer from NODE_ENV, this signs in with the dev back-office
// credentials — the same setSessionCookie the unlock path calls — and reports
// the flags on what comes back. If Secure is off, a plain-http tablet keeps it.
import { launchChrome, sleep } from './lib/cdp-chrome.mjs'

const BASE = process.env.APP_URL || 'http://localhost:4200'
const EMAIL = process.env.DEV_LOGIN_EMAIL
const PASSWORD = process.env.DEV_LOGIN_PASSWORD
if (!EMAIL) { console.error('needs DEV_LOGIN_EMAIL / DEV_LOGIN_PASSWORD'); process.exit(1) }

const { wsUrl, close } = await launchChrome('ckflag')
const ws = new WebSocket(wsUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let id = 0
const pending = new Map()
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.method) return
  const en = pending.get(m.id); if (!en) return; pending.delete(m.id)
  m.error ? en.reject(new Error(JSON.stringify(m.error))) : en.resolve(m.result) }
const send = (method, params = {}, sessionId) =>
  new Promise((res, rej) => { const n = ++id; pending.set(n, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: n, method, params, sessionId })) })
const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
for (const d of ['Page', 'Runtime', 'Network']) await send(d + '.enable', {}, sessionId)
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId)
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
  return r.result?.value
}

await send('Page.navigate', { url: BASE + '/' }, sessionId); await sleep(3000)
await evaluate(`
  (() => { const set = (s, v) => { const el = document.querySelector(s)
      Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set.call(el, v)
      el.dispatchEvent(new Event('input', { bubbles: true })) }
    set('input[type=email]', ${JSON.stringify(EMAIL)}); set('input[type=password]', ${JSON.stringify(PASSWORD)})
    document.querySelector('form').requestSubmit(); return true })()
`)
await sleep(5000)

const { cookies } = await send('Network.getCookies', { urls: [BASE] }, sessionId)
let fails = 0
const ok = (l, c, e = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : '**FAIL**'}  ${l}${e ? '  -- ' + e : ''}`) }

console.log(`origin ${BASE}\ncookies held: ${cookies.length}`)
for (const c of cookies) console.log(`  ${c.name.padEnd(24)} secure:${c.secure ? 'YES' : 'no'}  httpOnly:${c.httpOnly ? 'yes' : 'no'}`)

const session = cookies.find((c) => /session|till/i.test(c.name))
ok('a session cookie was kept over plain http', !!session, session ? session.name : 'none kept')
if (session) ok('and it is NOT marked Secure (so a tablet keeps it)', !session.secure)
ok('the browser is past the login form', !(await evaluate('location.pathname')).includes('login'),
   `at ${await evaluate('location.pathname')}`)

await close()
process.exit(fails === 0 ? 0 : 1)
