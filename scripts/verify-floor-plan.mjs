// Proves a manager can draw a floor plan, and that the till then renders it.
//
//   node --env-file=.env --env-file=.env.local scripts/verify-floor-plan.mjs
//
// test-pos-floor (30) proves the ENGINE cannot lose a table or its bill. What it cannot
// reach is the canvas, and a floor plan is a drawing — the only way to know a drawing is
// right is to look at it. Three browser facts:
//
//   1. The designer appears in Setup with an HONEST empty state: it says the sectioned
//      list is a perfectly good floor, rather than implying a plan is required.
//   2. A room can be added, a table dropped in, and the unsaved change is COUNTED —
//      a canvas looks identical saved or not, so the count is the only signal.
//   3. The till then draws that table positioned, and stops listing it in the grid.
//      Drawn on the canvas AND listed below it is the same table twice on one screen.
//
// Requires site 1 in hospitality mode with tables — see the plan.
//
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SignJWT } from 'jose'
import { launchChrome } from './lib/cdp-chrome.mjs'

const EMAIL = process.env.DEV_LOGIN_EMAIL
const PASSWORD = process.env.DEV_LOGIN_PASSWORD
const SECRET = process.env.SESSION_SECRET
const BASE = process.env.APP_URL || 'http://localhost:4100'
const OUT = process.env.SHOT_DIR || path.join(process.cwd(), '.screenshots')
const DEVICE = process.env.VERIFY_DEVICE_ID || 'b7a53389-9e44-4378-873c-af3cbd870b7d'

if (!EMAIL || !PASSWORD) {
  console.error('Set DEV_LOGIN_EMAIL / DEV_LOGIN_PASSWORD in .env.local')
  process.exit(1)
}
if (!SECRET) {
  console.error('SESSION_SECRET is not set — the till cookie cannot be minted.')
  process.exit(1)
}

mkdirSync(OUT, { recursive: true })

const { wsUrl, close: closeChrome } = await launchChrome('flr')

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
  const { writeFileSync } = await import('node:fs')
  writeFileSync(file, Buffer.from(data, 'base64'))
  return file
}

let fails = 0
const ok = (label, cond, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

/* ── Sign in to the back office ─────────────────────────────────────────────── */

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

/* ── Past the PIN gate, by minting the till cookie the action would issue ───── */

const operator = await evaluate(
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
ok('the catalog answers for this device', operator?.ok === true, JSON.stringify(operator?.status ?? ''))

const userId = operator?.operator?.userId ?? 1
const siteId = operator?.siteId ?? 1
const token = await new SignJWT({ userId, name: 'Tile size verifier', siteId })
  .setProtectedHeader({ alg: 'HS256' })
  .setIssuedAt()
  .setExpirationTime('8h')
  .sign(new TextEncoder().encode(SECRET))

await send(
  'Network.setCookie',
  { name: 'odyssey_till', value: token, domain: 'localhost', path: '/', httpOnly: true },
  sessionId,
)
await evaluate(`localStorage.setItem('ody-device-id', ${JSON.stringify(DEVICE)}), true`)

consoleErrors.length = 0
const landed = await goto('/pos')
const stillGated = await evaluate(`document.body.innerText.includes('Enter your PIN')`)
ok('the till renders rather than the PIN gate', landed === '/pos' && !stillGated, landed)


if (stillGated) {
  console.log('\nStill at the gate — the minted cookie was not accepted, so the split')
  console.log('assertions below cannot run. Nothing about the feature is proven either way.')
  console.log(`\n${fails} FAILURE(S)`)
  process.exit(1)
}

/* ── Setup: the designer ─────────────────────────────────────────────────── */

await goto('/setup/tables')

const designer = await evaluate(
  [
    '(() => {',
    "  const text = document.body.innerText || ''",
    '  return {',
    "    present: /floor plan/i.test(text),",
    "    honest: /sectioned list/i.test(text),",
    "    addRoom: [...document.querySelectorAll('button')].some((b) =>",
    "      /add a room/i.test((b.innerText || '').trim())",
    '    ),',
    '  }',
    '})()',
  ].join('\n'),
)
ok('the designer is on the tables screen', designer?.present === true, JSON.stringify(designer))
/*
 * The honest note about the sectioned list, wherever it appears.
 *
 * Present in the empty state AND in the card's own description, deliberately — a manager
 * who has already built one room should still be told that the tables they have not placed
 * are reaching the till.
 */
ok('  and it says the sectioned list is fine', designer?.honest === true)

/*
 * ── THIS SCRIPT HAS TO WORK ON A FLOOR THAT ALREADY HAS ROOMS ──────────────
 *
 * The first version assumed an empty floor: "Add a room" only renders in the empty state,
 * so the second run of this script failed four assertions — not because anything broke,
 * but because the room it created the first time was still there. A verifier that only
 * passes once is a verifier nobody runs twice.
 *
 * So the room is created only when it is missing, and either path lands in the same place.
 */
const ROOM_NAME = 'Verify Room'
const alreadyThere = await evaluate(
  `(document.body.innerText || '').includes(${JSON.stringify(ROOM_NAME)})`,
)
ok(
  alreadyThere ? `${ROOM_NAME} is already on the plan from an earlier run` : 'the floor has no test room yet',
  true,
)

/**
 * Clicks the first enabled button whose text STARTS WITH `prefix`.
 *
 * A plain string comparison rather than an interpolated regex, and that is not fussiness:
 * the first version interpolated `/^Add a room/i` into a template literal, where `\t\r\n`
 * in the neighbouring replace() collapsed into real whitespace and the browser threw
 * `Invalid regular expression: missing /`. Nothing that crosses this boundary should need
 * escaping, so nothing here does.
 */
const clickText = (prefix, { exact = false } = {}) =>
  evaluate(
    [
      '(() => {',
      `  const want = ${JSON.stringify(prefix.toLowerCase())}`,
      `  const exact = ${exact ? 'true' : 'false'}`,
      "  const norm = (s) => (s || '').split(/\\s+/).join(' ').trim().toLowerCase()",
      "  const b = [...document.querySelectorAll('button')].find((x) => {",
      '    if (x.disabled) return false',
      '    const t = norm(x.innerText)',
      '    return exact ? t === want : t.startsWith(want)',
      '  })',
      '  if (!b) return false',
      '  b.click()',
      '  return true',
      '})()',
    ].join('\n'),
  )

if (!alreadyThere) {
  /* Either button opens the same form: "Add a room" in the empty state, "Room" once the
     picker is showing. */
  const opened = (await clickText('Add a room')) || (await clickText('Room', { exact: true }))
  ok('the add-room form opens', opened === true)
  await sleep(600)

  const typed = await evaluate(
    [
      '(() => {',
      "  const input = [...document.querySelectorAll('input')].find((i) =>",
      "    (i.placeholder || '').indexOf('Inside, Patio') === 0",
      '  )',
      '  if (!input) return false',
      "  const setter = Object.getOwnPropertyDescriptor(input.constructor.prototype, 'value').set",
      `  setter.call(input, ${JSON.stringify(ROOM_NAME)})`,
      "  input.dispatchEvent(new Event('input', { bubbles: true }))",
      '  return true',
      '})()',
    ].join('\n'),
  )
  ok('the room name can be typed', typed === true)

  ok('the room is added', (await clickText('Add', { exact: true })) === true)
  await sleep(2600)
}

/* Select it. On a fresh add the designer already has — a manager who adds a room wants to
   put tables in it — but on a re-run another room may be showing. */
await clickText(ROOM_NAME, { exact: true })
await sleep(900)

const afterRoom = await evaluate(
  [
    '(() => {',
    "  const text = document.body.innerText || ''",
    '  return {',
    "    named: /Verify Room/.test(text),",
    "    tray: /Not on the plan yet/i.test(text),",
    "    palette: [...document.querySelectorAll('button')].some((b) => /^wall$/i.test((b.innerText||'').trim())),",
    '  }',
    '})()',
  ].join('\n'),
)
ok('the room appears', afterRoom?.named === true, JSON.stringify(afterRoom))
ok('  and a furniture palette', afterRoom?.palette === true)

/*
 * ── EMPTY THE TRAY FIRST, IF IT IS ALREADY EMPTY ──────────────────────────
 *
 * On a re-run every table is already placed, so there is nothing to drop and `dropped`
 * came back null — three assertions then failed on a script that had actually worked. So
 * if the tray is empty, take a table OFF the plan to refill it.
 *
 * That is not a workaround: "off the plan" is a real gesture with a real promise — the
 * table survives and keeps showing in the sectioned grid — so exercising it here proves
 * the round trip rather than only the outbound half.
 */
if (afterRoom?.tray !== true) {
  const removed = await evaluate(
    [
      '(() => {',
      "  const t = document.querySelector('[data-table-code]')",
      '  if (!t) return null',
      "  const code = t.getAttribute('data-table-code')",
      '  t.click()',
      '  return code',
      '})()',
    ].join('\n'),
  )
  await sleep(700)
  const offPlan = await clickText('Off the plan')
  await sleep(700)
  ok(`a placed table can be taken off the plan (${removed})`, offPlan === true)
  if (offPlan) {
    ok('the plan saves after removing one', (await clickText('Save plan')) === true)
    await sleep(2600)
  }
}

/* The tray is what makes the plan optional AND discoverable: unplaced tables are listed
   with a note saying they still show on the till meanwhile. */
const trayNow = await evaluate(`/Not on the plan yet/i.test(document.body.innerText || '')`)
ok('  with a tray of unplaced tables', trayNow === true)

/* Drop a table onto the plan by tapping its tray button. */
const dropped = await evaluate(
  [
    '(() => {',
    "  const b = [...document.querySelectorAll('button')].find((x) => /^T0[0-9]$/.test((x.innerText||'').trim()))",
    '  if (!b) return null',
    "  const code = (b.innerText || '').trim()",
    '  b.click()',
    '  return code',
    '})()',
  ].join('\n'),
)
ok('a table drops onto the plan', typeof dropped === 'string', String(dropped))
await sleep(900)

const unsaved = await evaluate(
  [
    '(() => {',
    "  const text = document.body.innerText || ''",
    '  return {',
    "    counted: /table(s)? moved/i.test(text),",
    "    warned: /Nothing is saved yet/i.test(text),",
    "    onCanvas: !!document.querySelector('[data-table-code]'),",
    '  }',
    '})()',
  ].join('\n'),
)
/* Nothing is written until Save, and the screen SAYS so — a canvas looks identical
   whether or not it has been saved, so the count and the warning are the only way a
   manager who walks away knows. */
ok('*** the unsaved change is counted, not implied ***', unsaved?.counted === true, JSON.stringify(unsaved))
ok('  and the till is said to still show the old plan', unsaved?.warned === true)
ok('  the table is drawn on the canvas', unsaved?.onCanvas === true)

ok('the plan saves', (await clickText('Save plan')) === true)
await sleep(2600)

const saved = await evaluate(
  `/table(s)? moved|Nothing is saved yet/i.test(document.body.innerText || '')`,
)
ok('after saving there is nothing outstanding', saved === false)

const shotSetup = await shot('setup-floor-plan')
console.log(`\nscreenshot -> ${shotSetup}`)

/* ── The till draws it ───────────────────────────────────────────────────── */

await goto('/pos')
const onTill = await evaluate(
  [
    '(() => {',
    "  const named = /VERIFY ROOM/i.test(document.body.innerText || '')",
    "  const positioned = [...document.querySelectorAll('[data-table-code]')]",
    "    .map((el) => el.getAttribute('data-table-code'))",
    '  return { named, positioned }',
    '})()',
  ].join('\n'),
)
ok('the till shows the room', onTill?.named === true, JSON.stringify(onTill))
ok(
  '*** and draws the placed table on the plan ***',
  (onTill?.positioned?.length ?? 0) >= 1,
  (onTill?.positioned ?? []).join(', '),
)

/*
 * The placed table must NOT also appear in the sectioned grid below.
 *
 * Drawn on the canvas AND listed underneath is the same table twice on one screen, and a
 * waiter tapping the wrong copy is a bug that looks like a duplicate table. Counted by
 * how many buttons carry that code — the canvas uses data-table-code, the grid does not,
 * so a total of one means exactly one rendering.
 */
const duplicated = await evaluate(
  [
    '(() => {',
    `  const code = ${JSON.stringify(dropped)}`,
    /* String comparison, no regex. Third time in this file that an interpolated pattern
       lost its escapes crossing into the browser — `\\b` and `\t\r\n` both collapse — so
       nothing here needs escaping at all. */
    "  const norm = (s) => (s || '').split(/\\s+/).join(' ').trim()",
    "  const all = [...document.querySelectorAll('button')].filter((b) => {",
    '    const t = norm(b.innerText)',
    "    return t === code || t.startsWith(code + ' ')",
    '  })',
    '  return all.length',
    '})()',
  ].join('\n'),
)
ok(
  '*** the placed table is drawn ONCE, not on the plan and in the grid ***',
  duplicated === 1,
  `${duplicated} rendering(s) of ${dropped}`,
)

/*
 * THE WHOLE ROOM FITS ON THE SCREEN.
 *
 * The assertions above all passed while the plan was unusable: a 100×70 room rendered at
 * full page width stood about 1100px tall, so one table was visible and the other three
 * were below the fold. A waiter scrolling a floor plan has lost the only thing a plan is
 * for. The screenshot showed it immediately; nothing else would have.
 */
const fits = await evaluate(
  [
    '(() => {',
    "  const canvas = document.querySelector('[data-table-code]')?.parentElement",
    '  if (!canvas) return null',
    '  const box = canvas.getBoundingClientRect()',
    '  return {',
    '    height: Math.round(box.height),',
    '    viewport: window.innerHeight,',
    '    withinFold: box.bottom <= window.innerHeight + 2,',
    '  }',
    '})()',
  ].join('\n'),
)
ok(
  '*** the whole room fits on screen without scrolling ***',
  fits?.withinFold === true,
  JSON.stringify(fits),
)

/*
 * NEWLY PLACED TABLES DO NOT LAND ON TOP OF EACH OTHER.
 *
 * Another one the screenshot caught and the assertions did not: the tray dropped every
 * table at the room's centre, so a four-table room rendered as one visible table with
 * three hidden underneath it. Every check above still passed — the tables WERE placed,
 * drawn once each, and inside the room. They were just all in the same spot.
 *
 * Compared pairwise on the rendered boxes, which is the only place the overlap is visible.
 */
const overlapping = await evaluate(
  [
    '(() => {',
    "  const boxes = [...document.querySelectorAll('[data-table-code]')].map((el) => {",
    '    const b = el.getBoundingClientRect()',
    "    return { code: el.getAttribute('data-table-code'), x: Math.round(b.left), y: Math.round(b.top) }",
    '  })',
    '  const pairs = []',
    '  for (let i = 0; i < boxes.length; i++) {',
    '    for (let j = i + 1; j < boxes.length; j++) {',
    '      if (boxes[i].x === boxes[j].x && boxes[i].y === boxes[j].y) {',
    "        pairs.push(boxes[i].code + '=' + boxes[j].code)",
    '      }',
    '    }',
    '  }',
    '  return { count: boxes.length, exact: pairs }',
    '})()',
  ].join('\n'),
)
ok(
  '*** no two tables are drawn in exactly the same place ***',
  (overlapping?.exact?.length ?? 0) === 0,
  `${overlapping?.count} table(s); collisions: ${(overlapping?.exact ?? []).join(', ') || 'none'}`,
)

const shotTill = await shot('pos-floor-plan')
console.log(`screenshot -> ${shotTill}`)

console.log(fails === 0 ? '\nAll floor plan screen checks passed.' : `\n${fails} FAILURE(S)`)
process.exit(fails === 0 ? 0 : 1)
