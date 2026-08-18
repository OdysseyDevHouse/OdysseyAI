// Measures the deposit panel's geometry: do the figures and the meter share
// the same rails, and does the fill match the arithmetic?
//
//   node --env-file=.env --env-file=.env.local scripts/probe-deposit-anchor.mjs <documentId>
//
// A screenshot shows a bar that "looks about right". This reads the actual
// pixel boxes, because "about right" is exactly how an anchoring bug survives
// a visual check.
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { launchChrome } from './lib/cdp-chrome.mjs'

const EMAIL = process.env.DEV_LOGIN_EMAIL
const PASSWORD = process.env.DEV_LOGIN_PASSWORD
const BASE = process.env.APP_URL || 'http://localhost:4100'
const documentId = process.argv[2]

if (!EMAIL || !PASSWORD || !documentId) {
  console.error('Usage: node --env-file=.env --env-file=.env.local scripts/probe-deposit-anchor.mjs <documentId>')
  process.exit(1)
}

const { pageTarget, wsUrl, close: closeChrome } = await launchChrome('anchor', { windowSize: '1600,1200' })

let ws
let nextId = 1
const waiting = new Map()

function send(method, params = {}, sessionId) {
  const id = nextId++
  ws.send(JSON.stringify({ id, method, params, sessionId }))
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject })
    setTimeout(() => waiting.has(id) && reject(new Error(`${method} timed out`)), 30000)
  })
}

async function connect() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      return (await res.json()).webSocketDebuggerUrl
    } catch {
      await new Promise((r) => setTimeout(r, 250))
    }
  }
  throw new Error('Chrome never came up')
}

async function evaluate(sessionId, expression) {
  const result = await send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  )
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? 'page threw')
  }
  return result.result?.value
}

let pass = 0
let fail = 0
function check(name, ok, detail = '') {
  if (ok) {
    pass += 1
    console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    fail += 1
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

try {
  const wsUrl = await connect()
  ws = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = reject
  })
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id && waiting.has(msg.id)) {
      const { resolve, reject } = waiting.get(msg.id)
      waiting.delete(msg.id)
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
    }
  }

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  await send('Page.enable', {}, sessionId)
  await send('Runtime.enable', {}, sessionId)

  await send('Page.navigate', { url: `${BASE}/login` }, sessionId)
  await new Promise((r) => setTimeout(r, 2800))
  await evaluate(
    sessionId,
    `(() => {
      const set = (el, v) => {
        const proto = Object.getPrototypeOf(el);
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      set(document.querySelector('input[type=email], input[name=email]'), ${JSON.stringify(EMAIL)});
      set(document.querySelector('input[type=password]'), ${JSON.stringify(PASSWORD)});
      document.querySelector('form').requestSubmit();
      return true;
    })()`,
  )
  await new Promise((r) => setTimeout(r, 3500))
  await evaluate(
    sessionId,
    `(() => {
      const b = [...document.querySelectorAll('button, a')]
        .find(x => /odyssey software ai 1|ODY-10000/i.test(x.textContent || ''));
      if (b) b.click();
      return true;
    })()`,
  )
  await new Promise((r) => setTimeout(r, 2500))

  await send('Page.navigate', { url: `${BASE}/invoicing/${documentId}` }, sessionId)
  await new Promise((r) => setTimeout(r, 3000))

  const geometry = await evaluate(
    sessionId,
    `(() => {
      const label = [...document.querySelectorAll('p')]
        .find(p => /DOCUMENT TOTAL/i.test(p.textContent || ''));
      if (!label) return { found: false };
      const grid = label.parentElement.parentElement;
      const body = grid.parentElement;
      const cols = [...grid.children].map(c => {
        const r = c.getBoundingClientRect();
        return {
          text: (c.querySelector('p')?.textContent || '').trim(),
          left: Math.round(r.left),
          right: Math.round(r.right),
        };
      });
      const track = body.querySelector('[role=img]');
      const fill = track ? track.firstElementChild : null;
      const tr = track ? track.getBoundingClientRect() : null;
      const fr = fill ? fill.getBoundingClientRect() : null;
      const caption = [...body.querySelectorAll('p')]
        .map(p => (p.textContent || '').trim())
        .find(t => /% of .* held/i.test(t));
      const bodyRect = body.getBoundingClientRect();
      return {
        found: true,
        cols,
        track: tr ? { left: Math.round(tr.left), right: Math.round(tr.right), width: Math.round(tr.width) } : null,
        fillWidth: fr ? Math.round(fr.width) : null,
        fillPct: (fr && tr) ? +( (fr.width / tr.width) * 100 ).toFixed(1) : null,
        caption: caption || null,
        bodyBottom: Math.round(bodyRect.bottom),
      };
    })()`,
  )

  console.log('\ndeposit panel geometry\n')
  console.log(JSON.stringify(geometry, null, 1))
  console.log('')

  if (!geometry.found) {
    check('the panel is on the page', false)
  } else {
    const [first] = geometry.cols
    check(
      'the first column and the bar start on the same rail',
      Math.abs(first.left - geometry.track.left) <= 2,
      `column ${first.left} vs bar ${geometry.track.left}`,
    )
    check(
      'the bar ends on the card rail, like the last column',
      Math.abs(geometry.cols[geometry.cols.length - 1].right - geometry.track.right) <= 2,
      `column ${geometry.cols[geometry.cols.length - 1].right} vs bar ${geometry.track.right}`,
    )
    // R50 of R154 is 32.5%, and percentHeld rounds to 1dp.
    check(
      'the fill matches the arithmetic',
      geometry.fillPct !== null && Math.abs(geometry.fillPct - 32.5) < 1.5,
      `${geometry.fillPct}% drawn, 32.5% expected`,
    )
    check('the bar states its scale', !!geometry.caption, geometry.caption ?? 'no caption')
  }
} catch (error) {
  console.error('PROBE FAILED:', error.message)
  fail += 1
} finally {
  try {
    ws?.close()
  } catch {}
    closeChrome()
}

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
