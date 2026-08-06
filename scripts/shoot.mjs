/**
 * Screenshot any screen in the app, so a layout can be LOOKED at rather than
 * inferred from HTML.
 *
 *   node --env-file=.env scripts/shoot.mjs /dashboard
 *   node --env-file=.env scripts/shoot.mjs /products/2 --dark
 *   node --env-file=.env scripts/shoot.mjs /online-store/builder --width=1440
 *   node --env-file=.env scripts/shoot.mjs /store/TOKEN --public --width=390
 *
 * ── WHY IT MINTS ITS OWN SESSION ─────────────────────────────────────────
 *
 * Back-office screens need a signed-in browser, and driving the login form
 * would mean keeping a real password somewhere. Instead this signs a session
 * cookie with SESSION_SECRET exactly as lib/session.ts does — the same secret
 * the app verifies against, so nothing is bypassed and no credential is
 * stored. `--public` skips the cookie entirely, which is how the storefront
 * gets shot as an anonymous shopper actually sees it.
 *
 * Uses the Chrome already on this machine (`channel: 'chrome'`) rather than
 * downloading Playwright's own build — a 150MB download for a browser that is
 * already installed is a poor trade.
 */
import { chromium } from 'playwright'
import { SignJWT } from 'jose'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'

const args = process.argv.slice(2)
const routes = args.filter((a) => !a.startsWith('--'))
const flag = (name) => args.some((a) => a === `--${name}`)
const value = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

if (routes.length === 0) {
  console.error('Usage: node --env-file=.env scripts/shoot.mjs <route> [more routes] [--dark] [--public] [--width=1280] [--full]')
  process.exit(1)
}

const BASE = value('base', 'http://localhost:4100')
const WIDTH = Number(value('width', 1280))
const HEIGHT = Number(value('height', 900))
const OUT = path.resolve('.screenshots')

/** A session cookie the app will accept, signed the way lib/session.ts signs it. */
async function sessionCookie() {
  const secret = process.env.SESSION_SECRET
  if (!secret) throw new Error('SESSION_SECRET is not set — run with --env-file=.env')

  const token = await new SignJWT({
    userId: Number(value('user', 1)),
    email: value('email', 'tiaan@point-of-sale.co.za'),
    name: 'Screenshot',
    siteId: Number(value('site', 1)),
    mustChangePassword: false,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(secret))

  return { name: 'odyssey_session', value: token, url: BASE }
}

const browser = await chromium.launch({ channel: 'chrome' })
const context = await browser.newContext({
  viewport: { width: WIDTH, height: HEIGHT },
  // The app replays a saved choice onto <html> before first paint; setting the
  // OS preference is what makes an unset app follow dark mode.
  colorScheme: flag('dark') ? 'dark' : 'light',
  deviceScaleFactor: 2,
})

if (!flag('public')) await context.addCookies([await sessionCookie()])

await mkdir(OUT, { recursive: true })
const page = await context.newPage()

// Surface anything the browser complains about — a hydration mismatch or a
// failed request is exactly the class of bug a screenshot alone would hide.
const problems = []
page.on('console', (m) => {
  if (m.type() === 'error') problems.push(`console: ${m.text().slice(0, 160)}`)
})
page.on('pageerror', (e) => problems.push(`page error: ${String(e).slice(0, 160)}`))
page.on('requestfailed', (r) => problems.push(`request failed: ${r.url().slice(0, 120)}`))

/**
 * Undo Git Bash's path mangling.
 *
 * MSYS rewrites a leading-slash argument into a Windows path, so `/dashboard`
 * arrives as `C:/Program Files/Git/dashboard`. Recovering the route here beats
 * making every caller remember to write `//dashboard` or set MSYS_NO_PATHCONV.
 */
function unmangle(route) {
  if (route.startsWith('http') || route.startsWith('/')) return route
  const match = route.match(/[/\\]Git[/\\](.*)$/i)
  return match ? `/${match[1].replace(/\\/g, '/')}` : route
}

for (const raw of routes) {
  problems.length = 0
  const route = unmangle(raw)
  const url = route.startsWith('http') ? route : `${BASE}${route}`
  const response = await page.goto(url, { waitUntil: 'networkidle', timeout: 45_000 })

  // `networkidle` means the requests stopped, not that the page settled.
  // Charts measure their own box and re-render on the frame AFTER mount, so a
  // screenshot taken at network-idle catches them mid-draw — which is exactly
  // how an empty donut looked like a rendering bug for three rounds.
  await page.waitForTimeout(Number(value('settle', 600)))

  const name =
    (route.replace(/^https?:\/\/[^/]+/, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') ||
      'root') + (flag('dark') ? '-dark' : '')
  const file = path.join(OUT, `${name}.png`)

  await page.screenshot({ path: file, fullPage: flag('full') })

  const status = response?.status() ?? 0
  console.log(`${status === 200 ? 'ok ' : '!! '} ${String(status)}  ${route}  ->  ${file}`)
  for (const p of problems.slice(0, 5)) console.log(`      ${p}`)
}

await browser.close()
