// Logs in and screenshots app screens, so a change can be looked at rather
// than only compiled.
//
//   node --env-file=.env.local scripts/screenshot.mjs /invoicing [more paths...]
//
// Credentials come from DEV_LOGIN_EMAIL / DEV_LOGIN_PASSWORD in .env.local,
// which is gitignored. Nothing is written to disk but the PNGs.
//
// Chrome is driven over the DevTools protocol rather than through Playwright:
// Node ships a global WebSocket, so this needs no dependency at all, and a
// verification tool that installs a browser toolchain is a tool nobody runs.
import { writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { launchChrome } from './lib/cdp-chrome.mjs'

const EMAIL = process.env.DEV_LOGIN_EMAIL
const PASSWORD = process.env.DEV_LOGIN_PASSWORD
const BASE = process.env.APP_URL || 'http://localhost:4100'
const OUT = process.env.SHOT_DIR || path.join(process.cwd(), '.screenshots')

if (!EMAIL || !PASSWORD) {
  console.error(
    'Set DEV_LOGIN_EMAIL and DEV_LOGIN_PASSWORD in .env.local, then run with\n' +
      '  node --env-file=.env.local scripts/screenshot.mjs <path> [...]',
  )
  process.exit(1)
}

const paths = process.argv.slice(2)
if (!paths.length) {
  console.error('Give at least one path, e.g. /invoicing')
  process.exit(1)
}

mkdirSync(OUT, { recursive: true })

const { wsUrl, close: closeChrome } = await launchChrome('shot')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))



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

async function evaluate(expression) {
  const r = await send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  )
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
  return r.result?.value
}

// SHOT_THEME=light|dark captures a screen in a specific theme rather than
// whatever the headless profile inherits from the OS — which is how a light-mode
// styling bug goes unseen in a dark-mode screenshot. The choice is stored the
// same way the avatar menu stores it, so the inline script in layout.tsx applies
// it during parsing and the first paint is already correct.
const THEME = process.env.SHOT_THEME
if (THEME && THEME !== 'light' && THEME !== 'dark') {
  console.error(`SHOT_THEME must be "light" or "dark", got "${THEME}"`)
  process.exit(1)
}

async function applyTheme() {
  if (!THEME) return
  await evaluate(
    `(() => {
       try { window.localStorage.setItem('odyssey.theme', ${JSON.stringify(THEME)}) } catch {}
       document.documentElement.dataset.theme = ${JSON.stringify(THEME)}
     })()`,
  )
}

async function goto(p) {
  await send('Page.navigate', { url: `${BASE}${p}` }, sessionId)
  // A fixed wait under-shoots when the dev server is compiling the route for
  // the first time (blank white PNGs). Poll until the page has painted real
  // content, then settle briefly for data that streams in after the shell.
  for (let i = 0; i < 60; i++) {
    await sleep(500)
    const ready = await evaluate(
      `document.readyState === 'complete' && (document.body?.innerText || '').trim().length > 0`,
    )
    if (ready) break
  }
  await sleep(1500)
  return evaluate('location.pathname')
}

// ── Sign in ─────────────────────────────────────────────────────────────
// The form posts a server action, not a plain endpoint, so it has to be
// driven as a user: React ignores a raw `.value =`, hence the native setter
// plus an input event.
// '/' IS the login page. There is no route at /login — src/app/login/ holds
// only the form component and its action, with no page.tsx, so navigating
// there 404s and the fields are never found.
const at = await goto('/')

// ALREADY SIGNED IN. Chrome is launched with a fresh --user-data-dir, but a
// stale profile can still be picked up — so the session cookie survives and '/' redirects
// straight to /dashboard. There is then no form to fill in, and the script
// used to report "has the form changed?" while looking at a working app.
const alreadyIn = at !== '/' && !at.startsWith('/login')

// Otherwise wait for the form specifically. `goto` returns once the body has
// text, which on a cold route happens while React is still hydrating — the
// inputs exist in the server HTML but the handler that submits them does not,
// so a login driven a moment too early silently does nothing.
if (!alreadyIn) {
  for (let i = 0; i < 40; i++) {
    const ready = await evaluate(
      `!!document.querySelector('input[name="email"]') &&
       !!document.querySelector('button[type="submit"]')`,
    )
    if (ready) break
    await sleep(500)
  }
}

const submitted = alreadyIn || (await evaluate(`(() => {
  const set = (el, v) => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')
      .set.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const email = document.querySelector('input[name="email"]')
  const pass = document.querySelector('input[name="password"]')
  if (!email || !pass) return false
  set(email, ${JSON.stringify(EMAIL)})
  set(pass, ${JSON.stringify(PASSWORD)})
  email.closest('form').querySelector('button[type="submit"]').click()
  return true
})()`))

if (!submitted) {
  console.error('Could not find the login fields — has the form changed?')
  process.exit(1)
}

await sleep(4500)

// STAYING ON '/' IS NOT A FAILURE ANY MORE.
//
// An account with more than one store used to be redirected to a /select-site
// page; it now gets a dialog OVER the login card, so the path is still '/' long
// after the credentials were accepted. Checking the path alone reported "Sign-in
// failed: no message shown" for a login that had in fact worked — the giveaway
// being that the account's failed_attempts never moved off zero.
//
// So the dialog is checked first: if it is open, sign-in succeeded and the only
// thing left is to choose a store.
const pickerOpen = () =>
  evaluate(`(() => {
     const dialog = document.querySelector('dialog[open]')
     if (!dialog) return false
     return /choose a store|select which one/i.test(dialog.innerText || '')
   })()`)

if (await pickerOpen()) {
  const wanted = process.env.SHOT_SITE
  const chose = await evaluate(
    [
      '(() => {',
      '  const dialog = document.querySelector("dialog[open]")',
      '  const rows = [...dialog.querySelectorAll("button, a[href]")]',
      '    .filter((el) => (el.textContent || "").trim().length > 0)',
      '    .filter((el) => !/cancel|sign out/i.test(el.textContent))',
      '  const want = ' + JSON.stringify(wanted || ''),
      '  const hit = want',
      '    ? rows.find((el) => el.textContent.toLowerCase().includes(want.toLowerCase()))',
      '    : rows[0]',
      '  if (!hit) return null',
      '  hit.click()',
      '  return hit.textContent.replace(/\\s+/g, " ").trim()',
      '})()',
    ].join('\n'),
  )
  if (!chose) {
    console.error(
      'The store picker opened but held no store to choose' +
        (wanted ? ` matching SHOT_SITE="${wanted}"` : ''),
    )
    process.exit(1)
  }
  await sleep(4000)
  console.log('chose store:', chose, '->', await evaluate('location.pathname'))
}

const landed = await evaluate('location.pathname')
if (landed === '/' || landed.startsWith('/login')) {
  const message = await evaluate(
    `(document.querySelector('[role="alert"]') || {}).textContent || 'no message shown'`,
  )
  console.error('Sign-in failed:', message.trim())
  process.exit(1)
}
console.log('signed in, landed on', landed)

// ── Choose a store ──────────────────────────────────────────────────────
// An account with access to more than one site lands on /select-site, and every
// app route redirects back there until one is picked. Without this the script
// happily wrote three PNGs of the store picker and reported success — the shots
// looked like a screen that renders, so the bug was in the verification tool
// rather than in the page being verified.
//
// SHOT_SITE picks by name or code; the default is the first store listed.
if ((await evaluate('location.pathname')).startsWith('/select-site')) {
  const wanted = process.env.SHOT_SITE
  const clicked = await evaluate(
    [
      '(() => {',
      '  const rows = [...document.querySelectorAll("a[href], button")]',
      '    .filter((el) => (el.textContent || "").trim().length > 0)',
      '    .filter((el) => !/sign out/i.test(el.textContent))',
      '  const want = ' + JSON.stringify(wanted || ''),
      '  const hit = want',
      '    ? rows.find((el) => el.textContent.toLowerCase().includes(want.toLowerCase()))',
      '    : rows[0]',
      '  if (!hit) return null',
      '  hit.click()',
      '  return hit.textContent.replace(/\\s+/g, " ").trim()',
      '})()',
    ].join('\n'),
  )
  if (!clicked) {
    console.error(
      'Landed on /select-site but found no store to choose' +
        (wanted ? ` matching SHOT_SITE="${wanted}"` : ''),
    )
    process.exit(1)
  }
  await sleep(3500)
  console.log('chose store:', clicked, '->', await evaluate('location.pathname'))
}

// ── Shoot ───────────────────────────────────────────────────────────────
// SHOT_CLICK="Finalise" clicks the button with that label before capturing, so
// a dialog can be looked at too — plenty of screens only show the thing worth
// checking once something has been pressed.
const CLICK = process.env.SHOT_CLICK

// localStorage needs an origin, so this can only be written once a page from
// the app has loaded — hence after sign-in rather than before the first goto.
await applyTheme()

for (const p of paths) {
  let landedOn = await goto(p)
  // The stored choice is picked up during parsing, so a page navigated to
  // BEFORE it was written is still showing the inherited theme. Reload once so
  // the capture matches what SHOT_THEME asked for.
  if (THEME) {
    await applyTheme()
    landedOn = await goto(p)
  }

  // Split on '>>' so a control that only appears after another was pressed can
  // still be reached — SHOT_CLICK="New in >> Add products". A single label has
  // no separator and comes through as a one-step chain, unchanged.
  for (const step of CLICK ? CLICK.split('>>') : []) {
    const label = step.trim()
    if (!label) continue
    const clicked = await evaluate(`(() => {
      const wanted = ${JSON.stringify(label)}.trim().toLowerCase()
      // Falls back to aria-label because a control is not always its text: an
      // icon-only button, or the invisible overlay that selects a section in
      // the page builder, carry their whole name in the attribute.
      const name = (b) =>
        ((b.textContent || '').trim() + ' ' + (b.getAttribute('aria-label') || ''))
          .trim()
          .toLowerCase()
      const el = [...document.querySelectorAll('button, [role="button"], a')]
        .find((b) => name(b).includes(wanted))
      if (!el) return false
      el.click()
      return true
    })()`)
    if (!clicked) console.warn(`  (no control matching "${label}" on ${p})`)
    await sleep(2500)
  }

  // SHOT_DIAG=1 prints what the page actually says BEFORE the overlay below is
  // stripped. A screen that fails to render captures as a near-black rectangle
  // that tells you nothing; the overlay holds the message that does.
  //
  // innerText of the rendered elements, not textContent of the shadow root —
  // the latter returns the overlay's own stylesheet before any of its text.
  if (process.env.SHOT_DIAG) {
    const diag = await evaluate(
      `(() => {
         const out = []
         const portal = document.querySelector('nextjs-portal')
         const root = portal && portal.shadowRoot
         if (root) {
           root.querySelectorAll('h1, h2, p, pre, code, [data-nextjs-codeframe]').forEach((el) => {
             const t = (el.innerText || el.textContent || '').trim()
             if (t && !out.includes(t)) out.push(t)
           })
         }
         const body = document.body ? document.body.innerText.trim() : ''
         if (body) out.push(body)
         return out.join('\\n').slice(0, 2000)
       })()`,
    )
    if (diag) console.log(`--- ${p} says ---\n${diag}\n--- end ---`)
  }

  // The dev error overlay (<nextjs-portal>) paints above the whole app, so a
  // single console warning would otherwise blot out every capture. Remove it —
  // this inspects the screen, not the console.
  await evaluate(`document.querySelectorAll('nextjs-portal').forEach((el) => el.remove())`)

  /*
   * SHOT_PROBE='<js expression>' prints what the expression evaluates to and
   * captures nothing else out of the ordinary.
   *
   * For the questions a picture cannot answer: whether an element actually
   * scrolls, what a computed height resolved to, whether a pane is clipping.
   * Run BEFORE the viewport is stretched below — that resize is a lie about
   * height for any screen that fills the viewport rather than growing past it,
   * and measuring after it would report the lie.
   */
  // `async` and awaited, so a probe can drive an interaction — click something,
  // wait for the re-render, then report — rather than only measure what is
  // already on screen. SHOT_PROBE_FILE reads the expression from a file, for
  // anything longer than a shell one-liner will survive quoting.
  const PROBE = process.env.SHOT_PROBE_FILE
    ? readFileSync(process.env.SHOT_PROBE_FILE, 'utf8')
    : process.env.SHOT_PROBE
  if (PROBE) {
    const probed = await evaluate(`(async () => { ${PROBE} })()`)
    console.log('probe:', typeof probed === 'string' ? probed : JSON.stringify(probed))
  }

  // captureBeyondViewport paints black past the first couple of viewports on
  // long pages under the software rasterizer. Resizing the emulated viewport
  // to the document height (capped so a huge page still rasterises) and
  // capturing plainly is reliable.
  //
  // The app layout is `h-screen overflow-hidden` with the scrolling done by an
  // inner <main class="overflow-y-auto">, so documentElement.scrollHeight is
  // ALWAYS one viewport — every screenshot of a long screen was silently cut
  // off at the fold. Measure the tallest scrolling element instead, and fall
  // back to the document for pages (login, store) that scroll normally.
  // <main> specifically, not every element: walking the whole tree calling
  // getComputedStyle on each node takes minutes on a busy screen.
  //
  // A screen that FILLS the viewport rather than growing past it must be shot
  // at the viewport's own height. Stretching one of those to a 1000px floor
  // hands its panes height they never have in life, so the capture shows a
  // layout nobody can produce — which reads as a bug in the screen rather than
  // in the capture. The page builder is the first such screen; `main` there
  // reports a scrollHeight equal to its own height, which is how one is
  // recognised.
  const fullHeight = await evaluate(
    `(() => {
       let tallest = document.documentElement.scrollHeight
       let fills = false
       document.querySelectorAll('main').forEach((el) => {
         // Nothing to scroll to: the screen divides the height it is given
         // instead of extending past it.
         if (el.scrollHeight <= Math.ceil(el.getBoundingClientRect().height) + 1) fills = true
         // Its own content height, plus whatever sits above it on the page.
         const height = el.scrollHeight + el.getBoundingClientRect().top
         if (height > tallest) tallest = height
       })
       if (fills) return window.innerHeight
       return Math.min(Math.max(tallest, 1000), 12000)
     })()`,
  )
  await send(
    'Emulation.setDeviceMetricsOverride',
    { width: 1600, height: fullHeight, deviceScaleFactor: 1, mobile: false },
    sessionId,
  )
  await sleep(400)

  // SHOT_CLIP="Till tiles" crops to the CARD containing that text, so one
  // component can be looked at closely instead of hunting for it in a
  // 12,000px capture of the style guide. Silently falls back to the whole page
  // when nothing matches — a missing crop should not lose the screenshot.
  const CLIP = process.env.SHOT_CLIP
  const clip = CLIP
    ? await evaluate(
        `(() => {
           const wanted = ${JSON.stringify(CLIP)}.trim().toLowerCase()
           const el = [...document.querySelectorAll('section, article, div')]
             .filter((n) => (n.innerText || '').trim().toLowerCase().includes(wanted))
             // The smallest element still containing the text WOULD be the
             // obvious pick, but on a card whose heading repeats the name that
             // is the heading itself — a crop of the title and nothing under
             // it. Take the smallest that still contains a control instead,
             // which is the card rather than its header.
             .filter((n) => n.querySelector('button, input, table, img, a'))
             .sort((a, b) => a.getBoundingClientRect().height - b.getBoundingClientRect().height)[0]
           if (!el) return null
           const r = el.getBoundingClientRect()
           return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height, scale: 1 }
         })()`,
      )
    : null
  if (CLIP && !clip) console.warn(`  (nothing matching "${CLIP}" on ${p} — capturing the page)`)

  const { data } = await send(
    'Page.captureScreenshot',
    clip ? { format: 'png', clip } : { format: 'png' },
    sessionId,
  )
  await send('Emulation.clearDeviceMetricsOverride', {}, sessionId)
  const name = (p.replace(/^\//, '').replace(/[^\w.-]+/g, '-') || 'root') + '.png'
  const file = path.join(OUT, name)
  writeFileSync(file, Buffer.from(data, 'base64'))
  console.log(`${p} -> ${landedOn} -> ${file}`)
}

ws.close()
closeChrome()
