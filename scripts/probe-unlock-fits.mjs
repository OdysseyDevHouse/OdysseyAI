// Does the locked screen fit a tablet in portrait — and can you REACH the id?
//
//   APP_URL=http://localhost:4100 node scripts/probe-unlock-fits.mjs
//
// The screen is inside the till's `fixed inset-0 overflow-hidden` shell, which
// is right for the till (keys must never move under a thumb) and wrong for this
// one screen: on a tablet in portrait the card, the pad and the machine id are
// together taller than the viewport, and `justify-center` spilled the overflow
// off BOTH ends with no gesture able to bring it back.
//
// So this asserts two things at several real device sizes: that the id is
// reachable, and that a screen with room to spare is still CENTRED rather than
// pinned to the top.
import { launchChrome, sleep } from './lib/cdp-chrome.mjs'

const BASE = process.env.APP_URL || 'http://localhost:4200'
const { wsUrl, close } = await launchChrome('unlockfit')
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
for (const d of ['Page', 'Runtime', 'Emulation']) await send(d + '.enable', {}, sessionId).catch(() => {})
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId)
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
  return r.result?.value
}

let fails = 0
const ok = (label, cond, extra = '') => { if (!cond) fails++; console.log(`  ${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`) }

const DEVICES = [
  { name: 'tablet portrait  800x1280', w: 800, h: 1280 },
  { name: 'tablet portrait  768x1024', w: 768, h: 1024 },
  { name: 'small tablet     600x960', w: 600, h: 960 },
  { name: 'tablet landscape 1280x800', w: 1280, h: 800 },
  { name: 'desktop         1600x1000', w: 1600, h: 1000 },
]

for (const d of DEVICES) {
  await send('Emulation.setDeviceMetricsOverride', { width: d.w, height: d.h, deviceScaleFactor: 1, mobile: d.w < 1000 }, sessionId)
  await send('Page.navigate', { url: BASE + '/pos-unlock' }, sessionId)
  await sleep(3500)

  const r = await evaluate(`
    (() => {
      const stored = localStorage.getItem('odyssey.device.id')
      const scroller = [...document.querySelectorAll('div')].find(el => getComputedStyle(el).overflowY === 'auto')
      // The id panel: the block whose text names it.
      const panel = [...document.querySelectorAll('div')].find(el =>
        /This machine's id/.test(el.innerText || '') && el.children.length <= 4)
      if (!panel) return { hasPanel: false, stored }
      const box = panel.getBoundingClientRect()
      const s = scroller ? { top: scroller.scrollTop, height: scroller.scrollHeight, client: scroller.clientHeight } : null
      // Scroll it into view the way a finger would, then re-measure.
      panel.scrollIntoView({ block: 'end' })
      const after = panel.getBoundingClientRect()
      return {
        hasPanel: true, stored,
        overflows: s ? s.height > s.client + 1 : false,
        visibleAfterScroll: after.bottom <= innerHeight + 1 && after.top >= -1,
        cardTop: document.querySelector('[class*=max-w-sm]')?.getBoundingClientRect().top ?? -1,
        viewport: innerHeight,
      }
    })()
  `)

  console.log(`\n${d.name}`)
  if (!r.hasPanel) { ok('id panel present', false, 'not rendered'); continue }
  ok('the id panel can be brought fully on screen', r.visibleAfterScroll)
  if (r.overflows) {
    ok('taller than the viewport, so it scrolls', true, 'content exceeds the screen')
  } else {
    // Room to spare: it must still be centred, not jammed to the top.
    ok('fits, and is still centred (not pinned to the top)', r.cardTop > 12, `card top ${Math.round(r.cardTop)}px`)
  }
}

console.log(fails === 0 ? '\nAll layout checks passed.' : `\n${fails} FAILED`)
await close()
process.exit(fails === 0 ? 0 : 1)
