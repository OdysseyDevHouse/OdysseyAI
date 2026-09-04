/**
 * Click "Try again" on ControlUnreachable and time what actually happens.
 *
 * Points at localhost by default; give it --base to aim at a deployed server,
 * which is the case worth measuring — a Server Action's `await` does not settle
 * until Next has re-rendered the failing route and streamed it back, so a proxy
 * that never answers shows up here as a button that never returns.
 *
 *   node --env-file=.env scratch/probe-retry-button.mjs
 *   node --env-file=.env scratch/probe-retry-button.mjs --base=https://vm.example --user=4 --site=5
 *
 * Mints its own session cookie the way scripts/shoot.mjs does — same
 * SESSION_SECRET the app verifies against, so nothing is bypassed. The user and
 * site must be a real pair in cp2_user_sites, and the site's database host has
 * to be one that fails, or the screen never appears.
 */
import { chromium } from 'playwright'
import { SignJWT } from 'jose'

const arg = (n, d) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`))
  return hit ? hit.slice(n.length + 3) : d
}
const BASE = arg('base', 'http://localhost:4100')
const SITE = Number(arg('site', 5))
const USER = Number(arg('user', 4))
const DOMAIN = new URL(BASE).hostname

const token = await new SignJWT({
  userId: USER,
  email: arg('email', 'tiaan@pos.co.za'),
  name: 'Probe',
  siteId: SITE,
  mustChangePassword: false,
})
  .setProtectedHeader({ alg: 'HS256' })
  .setIssuedAt()
  .setExpirationTime('1h')
  .sign(new TextEncoder().encode(process.env.SESSION_SECRET))

const browser = await chromium.launch({ channel: 'chrome' })
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
await ctx.addCookies([
  { name: 'odyssey_session', value: token, domain: DOMAIN, path: '/', httpOnly: true },
])
const page = await ctx.newPage()

page.on('console', (m) => console.log(`  [console.${m.type()}] ${m.text()}`))
page.on('requestfailed', (r) => console.log(`  [requestfailed] ${r.method()} ${r.url()} — ${r.failure()?.errorText}`))
page.on('response', (r) => {
  if (r.request().method() === 'POST') console.log(`  [POST ${r.status()}] ${r.url()}`)
})

const t0 = Date.now()
await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' })
console.log(`first load: ${Date.now() - t0}ms`)

const heading = await page.locator('h1').first().textContent().catch(() => null)
console.log(`heading: ${JSON.stringify(heading)}`)

const btn = page.getByRole('button', { name: /try again/i })
if ((await btn.count()) === 0) {
  console.log('No "Try again" button — not on ControlUnreachable. Body starts:')
  console.log((await page.locator('body').innerText()).slice(0, 400))
  await browser.close()
  process.exit(1)
}

console.log('\nclicking Try again…')
const t1 = Date.now()
await btn.click()

// Watch the label until the page navigates (reload) or 45s elapse.
let reloaded = false
page.once('load', () => {
  reloaded = true
  console.log(`  page reloaded at ${Date.now() - t1}ms`)
})

for (let i = 0; i < 45 && !reloaded; i++) {
  const label = await page.locator('button', { hasText: /reconnect|try again/i }).first().textContent().catch(() => '(gone)')
  console.log(`  t+${Date.now() - t1}ms  button reads ${JSON.stringify((label || '').trim())}`)
  await page.waitForTimeout(1000)
}

console.log(reloaded ? `\nRELOADED after ${Date.now() - t1}ms` : `\nSTILL STUCK after ${Date.now() - t1}ms — never reloaded`)
await browser.close()
