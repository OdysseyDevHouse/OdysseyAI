/**
 * Every print route, loaded into a hidden frame: does it print ITSELF?
 *
 * One line per route, so a route that quietly stops honouring ?auto=1 — the
 * Strict Mode guard bug did exactly that to all of them — is visible rather
 * than discovered on paper.
 *
 * Instrumented through Page.addScriptToEvaluateOnNewDocument: a print stub
 * installed from the parent never survives the frame's navigation, so every
 * in-page attempt reports a false negative.
 *
 *   node --env-file=.env.local scripts/probe-all-print-routes.mjs
 */
import { launchChrome } from './lib/cdp-chrome.mjs'

const EMAIL = process.env.DEV_LOGIN_EMAIL
const PASSWORD = process.env.DEV_LOGIN_PASSWORD
const BASE = process.env.APP_URL || 'http://localhost:4100'

const { wsUrl, close } = await launchChrome('all-print')
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

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
  return r.result.value
}

await send('Page.navigate', { url: BASE + '/dashboard' }, sessionId)
await sleep(3500)
for (let i = 0; i < 40; i++) {
  if (await evaluate(`!!document.querySelector('input[name="email"]') && !!document.querySelector('button[type="submit"]')`)) break
  await sleep(500)
}
/* Submitted ONCE.
 *
 * An earlier version retried until the form went away, on the theory that a
 * click can land before the submit handler hydrates. It does — but repeated
 * submits drove the sign-in into a server error ("This page couldn't load"),
 * which then looked like the print routes were broken. Waiting for hydration
 * and submitting once is what scripts/screenshot.mjs does, and it works. */
if (await evaluate(`!!document.querySelector('input[name="email"]')`)) {
  await evaluate(`(() => {
    const set = (el, v) => { Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value').set.call(el,v); el.dispatchEvent(new Event('input',{bubbles:true})) }
    const email = document.querySelector('input[name="email"]'); const pass = document.querySelector('input[name="password"]')
    set(email, ${JSON.stringify(EMAIL)}); set(pass, ${JSON.stringify(PASSWORD)})
    email.closest('form').querySelector('button[type="submit"]').click()
  })()`)
  await sleep(5000)
}
/* Two shapes of store picker, and this account has hit both: a DIALOG over '/'
   and a full /select-site PAGE. Choosing must handle either, or the frames
   below all render the picker and report a print that never happened. */
for (let i = 0; i < 25; i++) {
  const p = await evaluate('location.pathname')
  const onPicker = p.startsWith('/select-site')
  const chosen = await evaluate(`(() => {
    const dialog = document.querySelector('dialog[open]')
    const root = dialog && /choose a store|select which one/i.test(dialog.innerText||'')
      ? dialog
      : (location.pathname.startsWith('/select-site') ? document.body : null)
    if (!root) return null
    const rows = [...root.querySelectorAll('a[href],button')]
      .filter((el) => (el.textContent||'').trim() && !/sign out/i.test(el.textContent))
    if (!rows.length) return null
    rows[0].click()
    return rows[0].textContent.replace(/\\s+/g,' ').trim()
  })()`)
  if (chosen) { console.log('chose store:', chosen); await sleep(4000); break }
  if (!onPicker && p !== '/' && !p.includes('login')) break
  await sleep(500)
}
for (let i = 0; i < 30; i++) {
  const p = await evaluate('location.pathname')
  if (p !== '/' && !p.includes('login') && !p.startsWith('/select-site')) break
  await sleep(500)
}
const landed = await evaluate('location.pathname')
console.log('signed in at', landed)
if (landed === '/' || landed.includes('login') || landed.startsWith('/select-site')) {
  /* Say WHAT is on screen. "Sign-in failed" with no page text sent me looking
     at the print routes for a fault that was never there. */
  const what = await evaluate(`(() => ({
    text: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 300),
    dialog: (() => { const d = document.querySelector('dialog[open]'); return d ? (d.innerText||'').replace(/\\s+/g,' ').slice(0,200) : null })(),
    hasEmail: !!document.querySelector('input[name="email"]'),
  }))()`)
  console.error('**Sign-in failed — nothing below is meaningful.**')
  console.error('  page:', JSON.stringify(what.text))
  console.error('  dialog:', JSON.stringify(what.dialog))
  console.error('  login form still present:', what.hasEmail)
  close(); process.exit(1)
}

await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `window.print = function () { console.log('__AUTOPRINT__ ' + location.pathname) }`,
}, sessionId)

/* ── Ids are DISCOVERED, from inside the signed-in session ────────────────
 *
 * Not hardcoded, and not read from the database either. Reading the DB picks a
 * site by number, and the browser's session may be on a different one — that
 * mismatch had every route below reporting a confident 404 for code that was
 * fine. Asking the app which ids it will actually render is the only source
 * that cannot disagree with the app.
 *
 * A route with no id on this site is SKIPped and said out loud, because a
 * silent pass over nothing proves nothing. */
/* Status 200 AND a marker that only the real page carries.
 *
 * Neither alone is enough. A notFound() does answer 404, so the status filters
 * most of it — but the bill route answered 200 for a finalised sale and then
 * rendered the 404 page anyway. And the body cannot be tested for the 404 TEXT,
 * because Next ships its error component in every page's payload, so "this page
 * could not be found" is present in a perfectly good invoice too. So: the
 * status, plus something the working page actually renders. */
const probeIds = async (path, marker, limit) => {
  const found = await evaluate(`(async () => {
    const hits = []
    for (let id = 1; id <= ${limit} && hits.length < 4; id++) {
      const res = await fetch(${JSON.stringify(path)}.replace('{id}', id), { credentials: 'include' })
      if (res.status !== 200) continue
      const body = await res.text()
      if (!${JSON.stringify(marker)}.split('|').some((m) => body.toUpperCase().includes(m))) continue
      hits.push(id)
    }
    return hits
  })()`)
  return found
}

/* Each route is asked for its OWN id, never a shared one.
 *
 * The routes disagree about what they will render: /document and /slip want a
 * finalised sale, /bill wants a SAVED one, /delivery wants a document with a
 * delivery to show. Discovering one "sale id" and reusing it made three routes
 * 404 and look broken when only the fixture was wrong. */
const [docIds, slipIds, deliveryIds, billIds, orderIds, labelIds] = [
  await probeIds('/sales/{id}/document?auto=0', 'TAX INVOICE|QUOTE|SALES ORDER|CREDIT NOTE', 40),
  await probeIds('/sales/{id}/slip?auto=0', 'TAX INVOICE|GIFT RECEIPT', 40),
  await probeIds('/sales/{id}/delivery?auto=0', 'DELIVERY', 120),
  await probeIds('/sales/{id}/bill?auto=0', 'PRINT THE BILL', 120),
  await probeIds('/purchasing/{id}/order?auto=0', 'PURCHASE ORDER|BACK TO THE ORDER', 60),
  await probeIds('/labels/a4?ids={id}', 'LABEL', 140),
]
console.log('discovered ids:', JSON.stringify({ docIds, slipIds, deliveryIds, billIds, orderIds, labelIds }))

const labels = labelIds.length ? labelIds.join(',') : null

const ROUTES = [
  ['sales document (A4)', docIds[0] ? `/sales/${docIds[0]}/document` : null],
  ['sales slip (80mm)',   slipIds[0] ? `/sales/${slipIds[0]}/slip` : null],
  ['delivery note',       deliveryIds[0] ? `/sales/${deliveryIds[0]}/delivery` : null],
  ['bill (open tab)',     billIds[0] ? `/sales/${billIds[0]}/bill` : null],
  ['purchase order',      orderIds[0] ? `/purchasing/${orderIds[0]}/order` : null],
  ['shelf labels (A4)',   labels ? `/labels/a4?ids=${labels}` : null],
  ['talker labels',       labels ? `/labels/talker?ids=${labels}` : null],
]

let fails = 0
const rows = []
for (const [name, href] of ROUTES) {
  if (!href) { rows.push([name, 'SKIP', 'no id on this site — unverified']); continue }

  const before = events.filter((e) => e.method === 'Runtime.consoleAPICalled').length
  await evaluate(`(() => {
    document.querySelectorAll('iframe').forEach((f) => f.remove())
    const f = document.createElement('iframe')
    f.setAttribute('style','position:fixed;left:-10000px;top:0;width:210mm;height:297mm;border:0;')
    document.body.appendChild(f)
    const u = new URL(${JSON.stringify(href)}, location.origin)
    u.searchParams.set('auto','1')
    f.src = u.pathname + u.search
  })()`)
  await sleep(7000)

  const printed = events
    .slice(before)
    .filter((e) => e.method === 'Runtime.consoleAPICalled')
    .flatMap((e) => (e.params.args || []).map((a) => a.value))
    .filter((v) => typeof v === 'string' && v.startsWith('__AUTOPRINT__'))

  const rendered = await evaluate(`(() => {
    const f = document.querySelector('iframe')
    const d = f && f.contentDocument
    if (!d) return { ok: false, why: 'no document' }
    const t = (d.body.innerText || '').trim()
    /* "could not be found" only — matching a bare 404 also matched the shop's
       phone number on a perfectly good invoice and failed two real passes. */
    return {
      ok: t.length > 40,
      chars: t.length,
      notFound: /this page could not be found/i.test(t),
      text: t.slice(0, 200),
      url: f.contentWindow.location.pathname + f.contentWindow.location.search,
    }
  })()`)

  if (!rendered.ok || rendered.notFound) {
    fails++
    rows.push([
      name,
      '**FAIL**',
      `did not render at ${rendered.url}: "${(rendered.text || '').replace(/\s+/g, ' ')}"`,
    ])
  } else if (printed.length === 0) {
    fails++
    rows.push([name, '**FAIL**', `rendered ${rendered.chars} chars but never called print()`])
  } else {
    rows.push([name, 'PASS', `rendered ${rendered.chars} chars, printed itself`])
  }
}

console.log()
for (const [name, verdict, note] of rows) {
  console.log(`${verdict.padEnd(9)} ${name.padEnd(22)} ${note}`)
}
console.log(`\n${rows.filter((r) => r[1] === 'PASS').length} passed, ${fails} failed, ${rows.filter((r) => r[1] === 'SKIP').length} skipped`)

close()
process.exit(fails ? 1 : 0)
