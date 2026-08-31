// Does the locked screen show this machine's id when nothing has claimed it?
//
//   APP_URL=http://localhost:4200 node scripts/probe-unlock-deviceid.mjs
//
// The panel is the answer to "someone with back-office access must claim it
// first" — that person needs the id, and until now the screen held it in state
// and never printed it. A fresh browser profile IS an unclaimed machine, so
// simply loading the page in one is the test.
import { launchChrome, sleep } from './lib/cdp-chrome.mjs'

const BASE = process.env.APP_URL || 'http://localhost:4200'
const { wsUrl, close } = await launchChrome('unlockid')
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
for (const d of ['Page', 'Runtime']) await send(d + '.enable', {}, sessionId)
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId)
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
  return r.result?.value
}

await send('Page.navigate', { url: BASE + '/pos-unlock' }, sessionId)
await sleep(4000)

const seen = await evaluate(`({
  text: document.body.innerText,
  stored: localStorage.getItem('odyssey.device.id'),
})`)

let fails = 0
const ok = (label, cond, extra = '') => { if (!cond) fails++; console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`) }

ok('the locked screen renders', /locked|PIN/i.test(seen.text), seen.text.split('\n')[0])
ok('a device id exists in this profile', !!seen.stored, seen.stored ? seen.stored.slice(0, 18) + '…' : 'none')
ok('the screen PRINTS the id (the whole point)', !!seen.stored && seen.text.includes(seen.stored))
ok('it says what to do with it', /Setup/i.test(seen.text) && /claims the till/i.test(seen.text))

console.log('\n--- what the tablet will show ---')
console.log(seen.text.split('\n').filter((l) => l.trim()).map((l) => '   ' + l).join('\n'))

await close()
process.exit(fails === 0 ? 0 : 1)
