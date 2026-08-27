/**
 * The whole gesture: a document number in a report -> Print -> the print
 * dialog, with no tab opened and the report left exactly as it was.
 *
 * Instrumented through Page.addScriptToEvaluateOnNewDocument because a stub
 * installed from the parent never survives the frame's navigation — see
 * probe-frame-autoprint.mjs.
 *
 *   node --env-file=.env.local scripts/probe-report-print-flow.mjs
 */
import { launchChrome } from './lib/cdp-chrome.mjs'

const EMAIL = process.env.DEV_LOGIN_EMAIL
const PASSWORD = process.env.DEV_LOGIN_PASSWORD
const BASE = process.env.APP_URL || 'http://localhost:4100'
const REPORT = process.env.PROBE_REPORT || '/reports/discount-history?period=last5Years'

const { wsUrl, close } = await launchChrome('report-print')
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
await send('Target.setDiscoverTargets', { discover: true })

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
  return r.result.value
}

await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `window.print = function () { console.log('__AUTOPRINT__ ' + location.pathname + location.search) }`,
}, sessionId)

await send('Page.navigate', { url: BASE + '/dashboard' }, sessionId)
await sleep(3500)
for (let i = 0; i < 40; i++) {
  if (await evaluate(`!!document.querySelector('input[name="email"]') && !!document.querySelector('button[type="submit"]')`)) break
  await sleep(500)
}
if (await evaluate(`!!document.querySelector('input[name="email"]')`)) {
  await evaluate(`(() => {
    const set = (el, v) => { Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value').set.call(el,v); el.dispatchEvent(new Event('input',{bubbles:true})) }
    const email = document.querySelector('input[name="email"]'); const pass = document.querySelector('input[name="password"]')
    set(email, ${JSON.stringify(EMAIL)}); set(pass, ${JSON.stringify(PASSWORD)})
    email.closest('form').querySelector('button[type="submit"]').click()
  })()`)
  await sleep(4500)
}
await evaluate(`(() => {
  const d = document.querySelector('dialog[open]')
  if (!d || !/choose a store|select which one/i.test(d.innerText||'')) return null
  const rows = [...d.querySelectorAll('a[href],button')].filter((el)=>(el.textContent||'').trim() && !/sign out/i.test(el.textContent))
  rows[0] && rows[0].click(); return true
})()`)
await sleep(4000)

const targetsBefore = (await send('Target.getTargets')).targetInfos.filter((t) => t.type === 'page').length

await send('Page.navigate', { url: BASE + REPORT }, sessionId)
await sleep(6000)

const opened = await evaluate(`(() => {
  const cells = [...document.querySelectorAll('button')].filter((b) => /^(INV|CRN)/.test((b.textContent||'').trim()))
  if (!cells.length) return null
  cells[0].click()
  return cells[0].textContent.trim()
})()`)
if (!opened) { console.log('**No document cell in this report — nothing verified.**'); close(); process.exit(1) }
await sleep(3500)
console.log('opened record dialog for', opened)

const footer = await evaluate(`(() => {
  const d = [...document.querySelectorAll('dialog[open]')].pop()
  return [...d.querySelectorAll('button')].map((b)=>(b.textContent||'').trim()).filter(Boolean)
})()`)
console.log('footer buttons:', JSON.stringify(footer))

await evaluate(`(() => {
  const d = [...document.querySelectorAll('dialog[open]')].pop()
  ;[...d.querySelectorAll('button')].find((b)=>(b.textContent||'').trim()==='Print').click()
})()`)
await sleep(9000)

const prints = events
  .filter((e) => e.method === 'Runtime.consoleAPICalled')
  .flatMap((e) => (e.params.args || []).map((a) => a.value))
  .filter((v) => typeof v === 'string' && v.startsWith('__AUTOPRINT__'))

const targetsAfter = (await send('Target.getTargets')).targetInfos.filter((t) => t.type === 'page').length
const state = await evaluate(`(() => {
  const f = document.querySelector('iframe')
  return {
    frames: document.querySelectorAll('iframe').length,
    frameSrc: f ? f.getAttribute('src') : null,
    recordDialogStillOpen: !!document.querySelector('dialog[open]'),
    stillOnReport: location.pathname,
  }
})()`)

console.log('print() calls:', JSON.stringify(prints))
console.log('browser tabs before/after:', targetsBefore, '/', targetsAfter)
console.log('page state:', JSON.stringify(state))

const pass =
  prints.length > 0 &&
  targetsAfter === targetsBefore &&
  state.recordDialogStillOpen &&
  state.stillOnReport.startsWith('/reports') &&
  !footer.includes('Open')
console.log(pass
  ? 'PASS  Print goes straight to the print dialog: no new tab, report and dialog untouched, no Open button'
  : '**FAIL** see the values above')

close()
process.exit(pass ? 0 : 1)
