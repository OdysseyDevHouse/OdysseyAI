/*
 * Is the "Encountered a script tag" warning gone, and does the theme still
 * apply before the first paint?
 *
 *   node --env-file=.env --env-file=.env.local scripts/verify-theme-script.mjs
 *
 * Both halves matter and they pull against each other, which is why they are
 * asserted together. Silencing the warning is trivial on its own — delete the
 * script — and that reintroduces the white flash the script exists to prevent.
 * A fix is only a fix if the console is clean AND the theme is still applied by
 * the time the page has parsed.
 *
 * The console is read over CDP rather than eyeballed: this warning appears only
 * in a development build, only on hydration, and is exactly the kind of line
 * that scrolls past unnoticed in a busy terminal.
 */
import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { launchChrome } from './lib/cdp-chrome.mjs'

const BASE = process.env.APP_URL || 'http://localhost:4100'

let failures = 0
function check(name, ok, detail = '') {
  if (ok) console.log(`  PASS  ${name}`)
  else {
    failures++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const { wsUrl, close: closeChrome } = await launchChrome('theme')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/*
 * Torn down explicitly rather than from an `exit` handler.
 *
 * Killing Chrome and deleting its profile from inside `process.on('exit')`
 * crashes Node on Windows — "Assertion failed: !(handle->flags &
 * UV_HANDLE_CLOSING), src\win\async.c" — because the socket to the browser is
 * still open while libuv is already shutting the loop down. The run's own
 * output was correct and complete, and the process then exited 9 anyway, which
 * is the worst of both: a suite that passes and reports failure.
 */
async function shutdown(code) {
  try { ws.close() } catch {}
  await sleep(300)
  process.exit(code)
}


const ws = new WebSocket(wsUrl)
await new Promise((res, rej) => {
  ws.onopen = res
  ws.onerror = rej
})
let id = 0
const pending = new Map()

/* Everything Chrome logged, from both channels. React's warning arrives as a
   console API call; a genuine exception would come through Runtime
   .exceptionThrown instead, and missing that would report a page that had in
   fact fallen over as clean. */
const logged = []
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data)
  if (msg.method === 'Runtime.consoleAPICalled') {
    logged.push((msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '))
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    logged.push(msg.params.exceptionDetails?.text || 'exception')
  }
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
  await sleep(2500) // let hydration finish — the warning fires during it
}

console.log(`\nLoading ${BASE}/ (login page, no session needed)`)
await goto('/')

console.log('\n── The console ──────────────────────────────────────────────')
const scriptWarnings = logged.filter((l) => /Encountered a script tag/i.test(l))
check(
  'React does not warn about a script tag',
  scriptWarnings.length === 0,
  scriptWarnings[0] || '',
)

/* The other half. A hydration failure would ALSO make the script warning
   disappear (React bails out to client rendering), so a clean console is only
   meaningful alongside a page that actually hydrated. */
const hydrationErrors = logged.filter((l) => /hydrat/i.test(l) && /error|mismatch|failed/i.test(l))
check('the page hydrated without an error', hydrationErrors.length === 0, hydrationErrors[0] || '')

console.log('\n── The script still does its job ────────────────────────────')
/* The script is inert unless a choice is stored, so one is stored and the page
   reloaded. Asserting `data-theme` after a plain load would pass on a page
   whose script never ran at all — the attribute is absent in both cases. */
await evaluate(`(() => { try { localStorage.setItem('odyssey.theme', 'dark') } catch {} })()`)
await goto('/')
const applied = await evaluate(`document.documentElement.dataset.theme || ''`)
check('a stored theme is applied to <html>', applied === 'dark', `saw "${applied}"`)

/* And it must be applied by the PARSER, not by an effect after paint. A script
   that runs is indistinguishable from one React executed later unless the type
   is checked: the server HTML has to carry real JavaScript. */
const html = await (await fetch(`${BASE}/`)).text()
/* `[\s\S]` rather than `[^<]`: the script body spans newlines, and a
   newline-blind pattern matched nothing at all. `.test('')` on an empty match is
   false — but the FIRST version of this check asked `/text\/javascript/.test(tag)`
   against that empty string and reported PASS for a tag it had never found,
   which is a vacuous assertion of exactly the kind that proves nothing.
   See odyssey-vacuous-assertions. */
const tag = html.match(/<script[^>]*>[\s\S]*?odyssey\.theme[\s\S]*?<\/script>/)?.[0] || ''
check('the theme script is present in the served HTML', tag !== '', 'no matching <script> found')
check(
  'the server sends it as executable JavaScript',
  /type="text\/javascript"/.test(tag),
  tag ? tag.slice(0, 120).replace(/\s+/g, ' ') : '(no tag)',
)
/* And NOT inert. `text/plain` in the server HTML would mean the browser parses
   it and does nothing — the console would be clean and the flash would be back,
   which is the failure this whole check exists to distinguish from success. */
check('it is not sent inert', !/type="text\/plain"/.test(tag))

const stillWarns = logged.filter((l) => /Encountered a script tag/i.test(l))
check('still no script warning after a reload', stillWarns.length === 0, stillWarns[0] || '')

console.log('\n── A client-side re-render, which is where it actually fires ──')
/*
 * THE CASE THE REST OF THIS FILE MISSES.
 *
 * React logs this warning from `react-dom-client` while RECONCILING a <script>
 * into the DOM — not while hydrating server HTML. A hard navigation therefore
 * never triggers it, and every check above passed against the broken code as
 * happily as against the fixed code: they were measuring the wrong moment.
 *
 * A soft navigation re-renders the root layout from the RSC payload, which is
 * when the tag goes through the client renderer and the warning appears. It is
 * also the moment the script genuinely would not execute — the reason React
 * complains in the first place.
 */
const before = logged.length
const navigated = await evaluate(`(() => {
  const link = [...document.querySelectorAll('a[href^="/"]')]
    .find((a) => !a.getAttribute('target') && a.getAttribute('href') !== location.pathname)
  if (!link) return null
  link.click()
  return link.getAttribute('href')
})()`)
if (!navigated) {
  console.log('  SKIP  no in-app link on this page to soft-navigate with')
} else {
  await sleep(3000)
  const softWarnings = logged
    .slice(before)
    .filter((l) => /Encountered a script tag/i.test(l))
  check(
    `no script warning after soft-navigating to ${navigated}`,
    softWarnings.length === 0,
    softWarnings[0] || '',
  )
}

console.log(failures === 0 ? '\nAll good.\n' : `\n${failures} failed.\n`)
await shutdown(failures === 0 ? 0 : 1)
