// Measures the deposit panel's VERTICAL spacing.
//
//   node --env-file=.env --env-file=.env.local scripts/probe-deposit-padding.mjs <documentId>
//
// The anchor probe checked the left/right rails and passed while the padding
// was still wrong, which is exactly why this is separate: "it lines up" and
// "it breathes" are different questions and only one of them was asked.
//
// Reports every gap that should be symmetric, so an eyeball is not the judge.
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

const EMAIL = process.env.DEV_LOGIN_EMAIL
const PASSWORD = process.env.DEV_LOGIN_PASSWORD
const BASE = process.env.APP_URL || 'http://localhost:4100'
const PORT = 9338
const documentId = process.argv[2]

if (!EMAIL || !PASSWORD || !documentId) {
  console.error('Usage: node --env-file=.env --env-file=.env.local scripts/probe-deposit-padding.mjs <documentId>')
  process.exit(1)
}

const CHROME =
  process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const profile = path.join(tmpdir(), `odyssey-pad-${process.pid}`)
mkdirSync(profile, { recursive: true })

const chrome = spawn(
  CHROME,
  [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--headless=new',
    '--no-first-run',
    '--window-size=1600,1400',
    'about:blank',
  ],
  { stdio: 'ignore' },
)

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

  await send('Page.navigate', { url: `${BASE}/sales/invoicing/${documentId}` }, sessionId)
  await new Promise((r) => setTimeout(r, 3000))

  const m = await evaluate(
    sessionId,
    `(() => {
      const label = [...document.querySelectorAll('p')]
        .find(p => /DOCUMENT TOTAL/i.test(p.textContent || ''));
      if (!label) return { found: false };

      const grid = label.parentElement.parentElement;
      const body = grid.parentElement;                 // CardBody
      const card = body.closest('[data-card]') || body.parentElement;
      const header = card.querySelector('[data-card-header]')
        || [...card.children].find(c => c !== body);

      const track = body.querySelector('[role=img]');
      const meterWrap = track ? track.parentElement : null;
      const caption = [...body.querySelectorAll('p')]
        .find(p => /% of .* held/i.test(p.textContent || ''));

      const r = (el) => {
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return { top: Math.round(b.top), bottom: Math.round(b.bottom), height: Math.round(b.height) };
      };
      const cs = getComputedStyle(body);

      const last = caption || meterWrap || grid;

      /*
       * The gutter, which is the check that was MISSING first time round.
       *
       * Measuring only inside the card said "20px top, 20px bottom, all good"
       * while the card itself ran to the window edges and sat flush against the
       * editor above it. So compare this card's left edge against a sibling
       * card's — they are supposed to stand on the same page gutter.
       */
      const cardBox = card.getBoundingClientRect();
      const siblings = [...document.querySelectorAll('[data-card]')]
        .filter(c => c !== card)
        .map(c => Math.round(c.getBoundingClientRect().left));
      const above = card.previousElementSibling;

      return {
        found: true,
        bodyPaddingTop: cs.paddingTop,
        bodyPaddingBottom: cs.paddingBottom,
        card: r(card),
        body: r(body),
        grid: r(grid),
        meter: r(meterWrap),
        caption: r(caption),
        // The two gaps that should agree: body top edge -> first content,
        // and last content -> body bottom edge.
        gapTop: r(grid).top - r(body).top,
        gapBottom: r(body).bottom - r(last).bottom,
        cardBottomToBody: r(card).bottom - r(body).bottom,
        cardLeft: Math.round(cardBox.left),
        cardRight: Math.round(cardBox.right),
        viewportWidth: Math.round(document.documentElement.clientWidth),
        siblingLefts: [...new Set(siblings)].sort((a, b) => a - b),
        gapAbove: above ? Math.round(cardBox.top - above.getBoundingClientRect().bottom) : null,
      };
    })()`,
  )

  console.log('\ndeposit panel vertical spacing\n')
  console.log(JSON.stringify(m, null, 1))
  console.log('')

  if (!m.found) {
    check('the panel is on the page', false)
  } else {
    check(
      'the card body has equal top and bottom padding',
      m.bodyPaddingTop === m.bodyPaddingBottom,
      `${m.bodyPaddingTop} top vs ${m.bodyPaddingBottom} bottom`,
    )
    check(
      'content starts and ends the same distance from the body edges',
      Math.abs(m.gapTop - m.gapBottom) <= 2,
      `${m.gapTop}px above vs ${m.gapBottom}px below`,
    )
    check(
      'the body reaches the card edge',
      Math.abs(m.cardBottomToBody) <= 2,
      `${m.cardBottomToBody}px of card below the body`,
    )

    /* The ones that actually catch the reported bug. */
    check(
      'the card is inside the page gutter, not against the window',
      m.cardLeft > 8 && m.viewportWidth - m.cardRight > 8,
      `left ${m.cardLeft}, ${m.viewportWidth - m.cardRight}px clear on the right`,
    )
    check(
      'it stands on the same gutter as the other cards',
      m.siblingLefts.length === 0 || m.siblingLefts.some((l) => Math.abs(l - m.cardLeft) <= 2),
      `card ${m.cardLeft} vs siblings ${JSON.stringify(m.siblingLefts)}`,
    )
    check(
      'it is not flush against whatever is above it',
      m.gapAbove === null || m.gapAbove >= 12,
      `${m.gapAbove}px above`,
    )
  }
} catch (error) {
  console.error('PROBE FAILED:', error.message)
  fail += 1
} finally {
  try {
    ws?.close()
  } catch {}
  chrome.kill()
}

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
