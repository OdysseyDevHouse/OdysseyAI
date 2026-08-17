// Clicks a branch in the storefront picker and checks the choice sticks.
//
//   node --env-file=.env.local scripts/verify-branch-pick.mjs <storeToken>
//
// Chrome over the DevTools protocol, same approach as screenshot.mjs — no
// browser toolchain to install, so it is a tool that actually gets run.
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const BASE = process.env.APP_URL || 'http://localhost:4100'
const TOKEN = process.argv[2]
const PORT = 9334

if (!TOKEN) {
  console.error('Pass the storefront token as the first argument.')
  process.exit(1)
}

const profile = path.join(tmpdir(), `ody-branch-${Date.now()}`)
mkdirSync(profile, { recursive: true })

const chrome = spawn(
  process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ],
  { stdio: 'ignore' },
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function target() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const list = await res.json()
      const page = list.find((t) => t.type === 'page')
      if (page) return page.webSocketDebuggerUrl
    } catch {
      /* not up yet */
    }
    await sleep(250)
  }
  throw new Error('Chrome did not start')
}

let id = 0
function rpc(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const mine = ++id
    const onMessage = (e) => {
      const msg = JSON.parse(e.data)
      if (msg.id !== mine) return
      ws.removeEventListener('message', onMessage)
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
    }
    ws.addEventListener('message', onMessage)
    ws.send(JSON.stringify({ id: mine, method, params }))
  })
}

async function evaluate(ws, expression) {
  const res = await rpc(ws, 'Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text)
  return res.result.value
}

let fails = 0
const ok = (label, cond, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

async function main() {
  const wsUrl = await target()
  const ws = new WebSocket(wsUrl)
  await new Promise((r) => ws.addEventListener('open', r, { once: true }))
  await rpc(ws, 'Page.enable')
  await rpc(ws, 'Runtime.enable')

  const url = `${BASE}/store/${TOKEN}`
  await rpc(ws, 'Page.navigate', { url })
  await sleep(3500)

  console.log('\n— The front door —')
  const first = await evaluate(ws, 'document.body.innerText')
  ok('the picker is up', /choose your store/i.test(first))
  ok('every branch is listed', /smash burger joint/i.test(first))
  ok('the location offer explains itself', /nothing is saved/i.test(first))

  console.log('\n— Choosing a branch —')
  // Submit the branch's own form, which is what the shopper's tap does.
  const clicked = await evaluate(
    ws,
    [
      '(() => {',
      '  const btns = [...document.querySelectorAll("form button[type=submit]")];',
      '  const target = btns.find(b => /smash burger/i.test(b.innerText));',
      '  if (!target) return "not-found";',
      '  target.click();',
      '  return "clicked";',
      '})()',
    ].join('\n'),
  )
  ok('the branch row submits', clicked === 'clicked', String(clicked))
  await sleep(4000)

  const after = await evaluate(ws, 'document.body.innerText')
  ok('the bar now names the branch', /shopping at/i.test(after), after.slice(0, 80).replace(/\n/g, ' | '))
  ok('and the picker has closed', !/choose your store/i.test(after))

  console.log('\n— Coming back later —')
  await rpc(ws, 'Page.navigate', { url })
  await sleep(3500)
  const revisit = await evaluate(ws, 'document.body.innerText')
  ok('the choice is remembered', /shopping at/i.test(revisit))
  ok('and nobody is asked again', !/which store\?/i.test(revisit))

  console.log('\n— Changing your mind —')
  // The auto-close watcher must not fight a shopper who deliberately reopens.
  const reopened = await evaluate(
    ws,
    [
      '(() => {',
      '  const b = [...document.querySelectorAll("button")].find(x => /^change$/i.test(x.innerText.trim()));',
      '  if (!b) return "no-change-button";',
      '  b.click();',
      '  return "clicked";',
      '})()',
    ].join('\n'),
  )
  ok('there is a way back to the picker', reopened === 'clicked', String(reopened))
  await sleep(600)
  const changing = await evaluate(ws, 'document.body.innerText')
  ok('and it opens', /choose your store/i.test(changing))

  ws.close()
  console.log(fails === 0 ? '\nAll branch pick checks passed.' : `\n${fails} FAILED.`)
  process.exitCode = fails === 0 ? 0 : 1
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => {
    chrome.kill()
    try {
      rmSync(profile, { recursive: true, force: true })
    } catch {
      /* the profile is in tmp; a leftover is harmless */
    }
  })
