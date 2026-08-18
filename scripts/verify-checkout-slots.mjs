// Puts a product in the basket and checks what the checkout offers.
//
//   node --env-file=.env.local scripts/verify-checkout-slots.mjs <storeToken> <productId>
//
// The basket lives in localStorage, so the server-rendered HTML is empty until
// the client hydrates — which is why this needs a real browser rather than curl.
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { launchChrome } from './lib/cdp-chrome.mjs'

const BASE = process.env.APP_URL || 'http://localhost:4100'
const TOKEN = process.argv[2]
const PRODUCT_ID = Number(process.argv[3])

if (!TOKEN || !Number.isInteger(PRODUCT_ID)) {
  console.error('Usage: verify-checkout-slots.mjs <storeToken> <productId>')
  process.exit(1)
}


const { pageTarget, wsUrl, close: closeChrome } = await launchChrome('checkout')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))


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
  const ws = new WebSocket(await pageTarget())
  await new Promise((r) => ws.addEventListener('open', r, { once: true }))
  await rpc(ws, 'Page.enable')
  await rpc(ws, 'Runtime.enable')

  const shop = `${BASE}/store/${TOKEN}`

  // Land on the shop first so localStorage is same-origin, then seed the cart
  // in the shape CartContext writes.
  await rpc(ws, 'Page.navigate', { url: shop })
  await sleep(3000)
  await evaluate(
    ws,
    [
      '(() => {',
      `  const key = "odyssey.cart." + ${JSON.stringify(TOKEN)};`,
      `  const line = { productId: ${PRODUCT_ID}, qty: 1 };`,
      '  localStorage.setItem(key, JSON.stringify([line]));',
      '  return localStorage.getItem(key);',
      '})()',
    ].join('\n'),
  )

  await rpc(ws, 'Page.navigate', { url: `${shop}/checkout` })
  await sleep(4000)
  const text = await evaluate(ws, 'document.body.innerText')

  console.log('\n— The checkout —')
  ok('it renders the basket', /collect|deliver/i.test(text), text.slice(0, 70).replace(/\n/g, ' | '))
  ok('and offers a collection time', /when would you like it/i.test(text))
  ok('with as-soon-as-possible first', /as soon as possible/i.test(text))
  ok('naming how long the shop needs', /needs about \d+ minutes/i.test(text))

  const options = await evaluate(
    ws,
    '(() => { const s=[...document.querySelectorAll("select")].find(x=>x.innerText.match(/as soon as/i)); return s ? s.options.length : 0 })()',
  )
  ok('the picker has real times in it', Number(options) > 1, `${options} options`)

  ws.close()
  console.log(fails === 0 ? '\nAll checkout slot checks passed.' : `\n${fails} FAILED.`)
  process.exitCode = fails === 0 ? 0 : 1
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => {
    closeChrome()
    try {
    } catch {
      /* tmp profile; a leftover is harmless */
    }
  })
