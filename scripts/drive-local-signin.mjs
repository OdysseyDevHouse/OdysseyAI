/**
 * Sign in to a LOCAL install the way a person does, and report what happens.
 *
 * ── WHY DRIVE A BROWSER RATHER THAN CALL THE FUNCTION ───────────────────────
 *
 * Because the failures worth finding are the ones between the pieces. Calling
 * signInLocal() directly would prove the verifier works and nothing else — it
 * would skip the form, the server action, the session cookie, the middleware,
 * requireSession's new stale-session guard, and every redirect after. That gap
 * is exactly where a day of this went.
 *
 * Chrome against the dev server rather than Electron: the pages are identical
 * — the shell only frames them — and a browser can be driven, screenshotted and
 * closed without a window manager.
 *
 *   npm run dev:desktop:next          (in another terminal)
 *   node scripts/drive-local-signin.mjs "Tiaan" 1122
 */
import { launchChrome } from './lib/cdp-chrome.mjs'

const NAME = process.argv[2]
const PIN = process.argv[3]
const BASE = process.env.BASE_URL || 'http://127.0.0.1:4100'

if (!NAME || !PIN) {
  console.error('Usage: node scripts/drive-local-signin.mjs "<name>" <pin>')
  process.exit(1)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const { wsUrl, close } = await launchChrome('signin')
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
    const msgId = ++id
    pending.set(msgId, { resolve, reject })
    ws.send(JSON.stringify({ id: msgId, method, params, sessionId }))
  })

const { targetInfos } = await send('Target.getTargets')
const page = targetInfos.find((t) => t.type === 'page')
const { sessionId } = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true })

const evaluate = async (expression) => {
  const { result } = await send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    sessionId,
  )
  return result?.value
}

const goto = async (url) => {
  await send('Page.navigate', { url }, sessionId)
  await sleep(2500)
}

async function report(label) {
  const state = await evaluate(`(() => ({
    url: location.pathname + location.search,
    title: document.querySelector('h1')?.innerText || '',
    heading: document.querySelector('h1,h2')?.innerText || '',
    fields: [...document.querySelectorAll('input')].map(i => i.name || i.type).filter(Boolean),
    error: [...document.querySelectorAll('[role="alert"]')].map(e => e.innerText).join(' | '),
    nav: [...document.querySelectorAll('nav a')].slice(0, 8).map(a => a.innerText.trim()).filter(Boolean),
    body: document.body.innerText.slice(0, 180).replace(/\\s+/g, ' '),
  }))()`)
  console.log(`\n── ${label}`)
  console.log(`   url    : ${state.url}`)
  if (state.heading) console.log(`   heading: ${state.heading}`)
  if (state.fields?.length) console.log(`   fields : ${state.fields.join(', ')}`)
  if (state.error) console.log(`   error  : ${state.error}`)
  if (state.nav?.length) console.log(`   menu   : ${state.nav.join(' · ')}`)
  if (!state.heading && !state.fields?.length) console.log(`   body   : ${state.body}`)
  return state
}

try {
  await send('Page.enable', {}, sessionId)

  await goto(BASE)
  await report('the front door')

  /* Typed through the DOM setter React listens to, rather than assigning
     .value — React tracks its own value and ignores a plain assignment, so the
     form would submit empty and this would "fail" for a reason that has nothing
     to do with the app. */
  await evaluate(`(() => {
    const set = (sel, v) => {
      const el = document.querySelector(sel)
      if (!el) return false
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(el, v)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    }
    return set('input[name="name"]', ${JSON.stringify(NAME)}) && set('input[name="pin"]', ${JSON.stringify(PIN)})
  })()`)

  await evaluate(`document.querySelector('form')?.requestSubmit()`)
  await sleep(4000)
  const after = await report('after signing in')

  /* The thing this whole exercise is for: did it land on the shop's own site,
     or bounce to a picker for somebody else's? */
  if (after.url.startsWith('/select-site')) {
    console.log('\n   >> WRONG: sent to the site picker, so the session is not site-scoped.')
  } else if (after.url.startsWith('/') && after.fields?.includes('pin')) {
    /* Matched on the PATH, not the whole string: the first version compared
       against '/' and missed '/?kicked=1', so a rejected sign-in was reported
       as a successful one. */
    console.log('\n   >> REFUSED: still on the login form.')
  } else {
    console.log('\n   >> Signed in.')
  }

  for (const path of ['/dashboard', '/products', '/setup/users']) {
    await goto(BASE + path)
    await report(path)
  }
} finally {
  ws.close()
  await close()
}
