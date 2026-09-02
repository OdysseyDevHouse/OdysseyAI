/**
 * Every POS API endpoint, against the real control panel.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * scripts/test-pos-api.mjs proves the CLIENT agrees with itself — URL shapes,
 * envelope round-trips, the signing string. It calls exactly one endpoint that
 * reads nothing (`/ping`), which is the right default for a suite that runs on
 * every checkout.
 *
 * This one answers the other question: does each endpoint the app actually
 * calls exist on the deployed portal, accept a signature this build produces,
 * and answer in the shape lib/control/*Portal.ts destructures? A client that
 * signs perfectly and asks for a route that 404s fails silently here — every
 * read path returns null on a refusal and falls back to MySQL, so a missing
 * endpoint looks exactly like a cloud install until somebody is on a counter
 * with no line.
 *
 * ── WHAT IT WILL NOT DO ─────────────────────────────────────────────────────
 *
 * Only reads, unless --writes is passed. /licence/claim, /licence/register and
 * everything under /billing/modules create rows and cost the shop money; a
 * probe is not a reason to buy a module. The write endpoints are still LISTED
 * so the inventory is honest about what went unchecked.
 *
 * Run — the site key comes from a real sign-in, so give one:
 *   node --env-file=.env scripts/probe-portal-endpoints.mjs --login you@x.co.za 'pw'
 *
 * Or, if ODYSSEY_SITE_API_KEY / _KEY_ID / ODYSSEY_SITE_ID are already set
 * (a provisioned desktop install):
 *   node --env-file=.env scripts/probe-portal-endpoints.mjs
 */
import crypto from 'node:crypto'

/* ── Configuration, read exactly as portalApi.ts reads it ─────────────────── */

function normaliseUrl(value) {
  let url = String(value || '').replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`
  if (!/\/api\/pos\/v\d+$/i.test(url)) url = `${url}/api/pos/v1`
  return url
}

const BASE = normaliseUrl(process.env.POS_API_URL)
const CLIENT_ID = (process.env.POS_API_CLIENT_ID || '').trim()
const CLIENT_SECRET = (process.env.POS_API_CLIENT_SECRET || '').trim()
const PAYLOAD_KEY = (process.env.POS_API_PAYLOAD_KEY || '').trim()
const TIMEOUT_MS = Number(process.env.PORTAL_API_TIMEOUT_MS || 8000)

let siteId = Number(process.env.ODYSSEY_SITE_ID) || 0
let siteKey = (process.env.ODYSSEY_SITE_API_KEY || '').trim()
let keyId = (process.env.ODYSSEY_SITE_API_KEY_ID || '').trim()

const args = process.argv.slice(2)
const loginAt = args.indexOf('--login')
const DO_WRITES = args.includes('--writes')

/* ── The signature, character for character as portalApi.ts builds it ─────── */

function signingString(method, path, timestamp, rawBody) {
  const digest = crypto.createHash('sha256').update(rawBody ?? '', 'utf8').digest('hex')
  return [method.toUpperCase(), path, timestamp, digest].join('\n')
}

function signatureFor(keyB64, method, path, timestamp, rawBody) {
  return crypto
    .createHmac('sha256', Buffer.from(keyB64, 'base64'))
    .update(signingString(method, path, timestamp, rawBody), 'utf8')
    .digest('base64')
}

/**
 * One signed call, returning the transport facts rather than a verdict.
 *
 * Deliberately does NOT collapse a refusal into an error the way the app's
 * clients do: here the status code and the error code are the finding.
 */
async function send(method, path, body) {
  const raw = body === undefined ? '' : JSON.stringify(body)
  const url = `${BASE}${path}`
  const timestamp = new Date().toISOString()
  const signedPath = new URL(url).pathname

  const headers = {
    'Content-Type': 'application/json',
    'X-Api-Client-Id': CLIENT_ID,
    'X-Api-Client-Secret': CLIENT_SECRET,
    'X-Site-Id': String(siteId),
    'X-Key-Id': keyId,
    'X-Timestamp': timestamp,
    'X-Signature': signatureFor(siteKey, method, signedPath, timestamp, raw),
  }

  const started = Date.now()
  try {
    const response = await fetch(url, {
      method,
      headers,
      body: method === 'GET' ? undefined : raw,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    })
    let payload = null
    let parseError = null
    try {
      payload = await response.json()
    } catch (e) {
      parseError = e instanceof Error ? e.message : String(e)
    }
    return {
      status: response.status,
      ok: response.ok,
      ms: Date.now() - started,
      payload,
      parseError,
    }
  } catch (err) {
    return {
      status: 0,
      ok: false,
      ms: Date.now() - started,
      payload: null,
      transportError: err instanceof Error ? err.message : String(err),
    }
  }
}

/* ── Reporting ────────────────────────────────────────────────────────────── */

let failures = 0
const rows = []

function record(name, method, path, res, shapeCheck) {
  let verdict
  let detail = ''

  if (res.status === 0) {
    verdict = 'FAIL'
    detail = `unreachable — ${res.transportError}`
  } else if (res.status === 404) {
    verdict = 'FAIL'
    detail = 'endpoint does not exist on the deployed portal (404)'
  } else if (res.status === 401 || res.status === 403) {
    verdict = 'FAIL'
    const code = res.payload?.error ? ` [${res.payload.error}]` : ''
    detail = `auth refused (${res.status})${code} ${res.payload?.message || ''}`.trim()
  } else if (!res.ok) {
    /* A 4xx that is not auth is the portal DECIDING something — a real answer,
       and for a probe sending placeholder ids it is often the correct one. */
    const code = res.payload?.error ? ` [${res.payload.error}]` : ''
    verdict = 'WARN'
    detail = `${res.status}${code} ${res.payload?.message || ''}`.trim()
  } else if (res.parseError) {
    verdict = 'FAIL'
    detail = `200 but the body is not JSON — ${res.parseError}`
  } else {
    const shape = shapeCheck ? shapeCheck(res.payload) : null
    if (shape) {
      verdict = 'FAIL'
      detail = `200 but ${shape}`
    } else {
      verdict = 'PASS'
      detail = summarise(res.payload)
    }
  }

  if (verdict === 'FAIL') failures++
  rows.push({ verdict, name, method, path, ms: res.ms, detail })
  const tag = verdict.padEnd(4)
  console.log(`  ${tag}  ${method.padEnd(4)} ${path.padEnd(34)} ${String(res.ms).padStart(5)}ms  ${detail}`)
}

/** A one-line gist of a payload, so a PASS still shows what came back. */
function summarise(payload) {
  if (payload === null || payload === undefined) return 'empty body'
  if (Array.isArray(payload)) return `array(${payload.length})`
  if (typeof payload !== 'object') return String(payload)
  const parts = []
  for (const [k, v] of Object.entries(payload)) {
    if (Array.isArray(v)) parts.push(`${k}[${v.length}]`)
    else if (v && typeof v === 'object') parts.push(`${k}{}`)
    else parts.push(`${k}=${String(v).slice(0, 28)}`)
  }
  return parts.slice(0, 6).join(' ')
}

/* ── Preconditions ────────────────────────────────────────────────────────── */

console.log('\nPOS API — every endpoint lib/control/*Portal.ts calls\n')
console.log(`  base   ${BASE}`)

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('\n  POS_API_CLIENT_ID / POS_API_CLIENT_SECRET are not set. Nothing to probe.\n')
  process.exit(1)
}

const key = Buffer.from(PAYLOAD_KEY, 'base64')
if (key.length !== 32) {
  console.error(`\n  POS_API_PAYLOAD_KEY is ${key.length} bytes, not 32. Envelopes cannot be opened.\n`)
  process.exit(1)
}

/* ── The build's own credentials ─────────────────────────────────────────────
 *
 * Checked FIRST and separately, because the portal checks them first: an
 * `invalid_client` means nothing else in this file can be interpreted.
 *
 * Probed three ways on purpose. An unknown client id and a wrong client secret
 * produce the SAME answer — deliberately, so the API never discloses which half
 * was wrong — so the only way to prove this build's credentials are good is to
 * watch the real pair get PAST this check while a tampered pair does not.
 */

console.log('\n  Build credentials\n')

async function ping(headers) {
  const started = Date.now()
  try {
    const response = await fetch(`${BASE}/ping`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
    let payload = null
    try {
      payload = await response.json()
    } catch {}
    return { status: response.status, ok: response.ok, ms: Date.now() - started, payload }
  } catch (err) {
    return { status: 0, ok: false, ms: Date.now() - started, transportError: String(err?.message || err) }
  }
}

const CLIENT_HEADERS = { 'X-Api-Client-Id': CLIENT_ID, 'X-Api-Client-Secret': CLIENT_SECRET }

function note(verdict, name, ms, detail) {
  if (verdict === 'FAIL') failures++
  rows.push({ verdict, name, method: 'GET', path: '/ping', ms, detail })
  console.log(`  ${verdict.padEnd(4)}  ${name.padEnd(45)} ${String(ms).padStart(5)}ms  ${detail}`)
}

{
  const wrong = await ping({ 'X-Api-Client-Id': CLIENT_ID, 'X-Api-Client-Secret': 'deadbeef' })
  if (wrong.payload?.error === 'invalid_client') {
    note('PASS', 'a wrong client secret is refused', wrong.ms, 'invalid_client')
  } else {
    note('FAIL', 'a wrong client secret is refused', wrong.ms, `got ${wrong.status} ${JSON.stringify(wrong.payload)}`)
  }

  const real = await ping(CLIENT_HEADERS)
  if (real.payload?.error === 'invalid_client') {
    note(
      'FAIL',
      "this build's credentials are accepted",
      real.ms,
      'invalid_client — the client row is unknown or DISABLED on the portal',
    )
  } else {
    note('PASS', "this build's credentials are accepted", real.ms, 'past the client check')
  }

  /* ── /ping ITSELF ────────────────────────────────────────────────────────
   *
   * electron/posApi.js sends NO signature here. ping() exists so an integrator
   * — or the setup wizard, before a shop has signed in — can prove the build's
   * keys with no site key in hand. If this demands a site signature, that
   * contract is broken and the wizard cannot check its own credentials. */
  record('ping (unsigned, as posApi.js calls it)', 'GET', '/ping', real, (p) =>
    p && typeof p === 'object' ? null : 'the body is not an object',
  )
}

/* ── Sign in, if asked, to obtain the site key the rest of this needs ─────── */

if (loginAt !== -1) {
  const email = args[loginAt + 1]
  const password = args[loginAt + 2]
  if (!email || !password) {
    console.error('\n  --login needs an email and a password.\n')
    process.exit(1)
  }

  console.log('\n  Sign-in\n')
  const started = Date.now()
  let res
  try {
    const response = await fetch(`${BASE}/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Client-Id': CLIENT_ID,
        'X-Api-Client-Secret': CLIENT_SECRET,
      },
      body: JSON.stringify({ email, password, deviceSerial: 'probe-portal-endpoints' }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    let payload = null
    try {
      payload = await response.json()
    } catch {}
    res = { status: response.status, ok: response.ok, ms: Date.now() - started, payload }
  } catch (err) {
    res = { status: 0, ok: false, ms: Date.now() - started, transportError: String(err?.message || err) }
  }
  record('login', 'POST', '/login', res, (p) => {
    if (!p || typeof p !== 'object') return 'the body is not an object'
    const stores = p.stores || p.sites
    if (!Array.isArray(stores)) return 'no stores[] in the payload'
    if (!stores.length) return 'the sign-in opened no stores'
    return null
  })

  if (res.ok && res.payload) {
    const stores = res.payload.stores || res.payload.sites || []
    /* Prefer a store the probe was pointed at; otherwise the first one the
       login opened. A two-store account is the norm in dev. */
    const wanted = Number(process.env.PROBE_SITE_ID) || 0
    const store = stores.find((s) => Number(s.siteId ?? s.id) === wanted) || stores[0]
    if (store) {
      siteId = Number(store.siteId ?? store.id) || siteId
      siteKey = String(store.apiKey ?? store.key ?? res.payload.apiKey ?? siteKey)
      keyId = String(store.apiKeyId ?? store.keyId ?? res.payload.keyId ?? keyId)
      /* The key may itself arrive sealed. */
      if (siteKey.startsWith('pos:v1:')) {
        const [iv, tag, ct] = siteKey.slice('pos:v1:'.length).split(':')
        const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'))
        d.setAuthTag(Buffer.from(tag, 'base64'))
        siteKey = Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8')
      }
      console.log(`\n  signed in as site ${siteId} (${store.name || store.tradingName || '?'})`)
      console.log(`  stores opened: ${stores.map((s) => `${s.siteId ?? s.id}:${s.name ?? ''}`).join(', ')}`)
    }
  }
}

if (!siteKey || !keyId || !siteId) {
  console.error(
    '\n  No site key. Pass --login <email> <password>, or set ODYSSEY_SITE_ID,' +
      ' ODYSSEY_SITE_API_KEY and ODYSSEY_SITE_API_KEY_ID.\n',
  )
  process.exit(1)
}

/* ── The signed reads ─────────────────────────────────────────────────────── */

console.log('\n  Signed reads\n')

/* entitlementsPortal.ts:68 — modules() destructures data.modules */
record(
  'entitlements',
  'GET',
  '/entitlements',
  await send('GET', '/entitlements'),
  /* entitlementsPortal.ts reads data.held and IGNORES everything else. Asserting
     any other key here would fail a portal that is answering correctly. */
  (p) => (p && Array.isArray(p.held) ? null : 'no held[] in the payload — entitlementsForSite() would return null'),
)

/* billingPortal.ts:85 — the Plan & billing screen */
record(
  'billing summary',
  'GET',
  '/billing/summary',
  await send('GET', '/billing/summary'),
  (p) => (p && typeof p === 'object' ? null : 'the body is not an object'),
)

/* devicesPortal.ts:89 — listLicences / freeSpots / paidSlots / billableDeviceCount
   all read this ONE payload, so a shape fault here breaks four callers. */
record(
  'licence spots',
  'GET',
  '/licence/spots',
  await send('GET', '/licence/spots'),
  /* One payload, four callers: listLicences, freeSpots, paidSlots and
     billableDeviceCount all destructure this. Each key is checked because a
     missing one breaks a different caller. */
  (p) => {
    if (!p || typeof p !== 'object') return 'the body is not an object'
    if (!Array.isArray(p.licences)) return 'no licences[] — listLicences() breaks'
    if (!Array.isArray(p.free)) return 'no free[] — freeSpots() breaks'
    if (!p.slots || typeof p.slots !== 'object') return 'no slots{} — paidSlots() breaks'
    if (typeof p.billableDeviceCount !== 'number') return 'no billableDeviceCount — billableDeviceCount() breaks'
    return null
  },
)

/* siteDatabasesPortal.ts:101 — both the narrowed and the unnarrowed form,
   because the query parameter is the part that could break the signature. */
const dbShape = (p) => (p && Array.isArray(p.databases) ? null : 'no databases[] in the payload')
record('site databases (all)', 'GET', '/site-databases', await send('GET', '/site-databases'), dbShape)
record(
  'site databases (master)',
  'GET',
  '/site-databases?purpose=master',
  await send('GET', '/site-databases?purpose=master'),
  dbShape,
)
record(
  'site databases (hybrid)',
  'GET',
  '/site-databases?purpose=hybrid',
  await send('GET', '/site-databases?purpose=hybrid'),
  dbShape,
)

/* ── The signed posts that read rather than write ─────────────────────────── */

console.log('\n  Signed posts (read-only)\n')

const PROBE_SERIAL = process.env.PROBE_DEVICE_SERIAL || 'probe-portal-endpoints'

/* devicesPortal.ts:97 — asks about a serial; registers nothing. */
record(
  'licence check',
  'POST',
  '/licence/check',
  await send('POST', '/licence/check', { serial: PROBE_SERIAL }),
  (p) => (p && typeof p === 'object' ? null : 'the body is not an object'),
)

/* devicesPortal.ts:129 — what this machine WOULD be offered. Still a read. */
record(
  'licence offer',
  'POST',
  '/licence/offer',
  await send('POST', '/licence/offer', { serial: PROBE_SERIAL }),
  (p) => (p && typeof p === 'object' ? null : 'the body is not an object'),
)

/* ── Signature negatives — proves the portal is CHECKING, not just answering ── */

console.log('\n  Signature enforcement\n')
{
  const realKey = siteKey
  siteKey = Buffer.from(crypto.randomBytes(32)).toString('base64')
  const res = await send('GET', '/entitlements')
  siteKey = realKey
  const rejected = res.status === 401 || res.status === 403
  if (rejected) {
    console.log(`  PASS  GET  /entitlements (bad signature)     ${String(res.ms).padStart(5)}ms  rejected ${res.status}`)
    rows.push({ verdict: 'PASS', name: 'bad signature rejected', method: 'GET', path: '/entitlements', ms: res.ms, detail: `rejected ${res.status}` })
  } else {
    failures++
    console.log(`  FAIL  GET  /entitlements (bad signature)     ${String(res.ms).padStart(5)}ms  answered ${res.status} — the portal is NOT verifying the HMAC`)
    rows.push({ verdict: 'FAIL', name: 'bad signature rejected', method: 'GET', path: '/entitlements', ms: res.ms, detail: `answered ${res.status}` })
  }
}

/* ── The writes ───────────────────────────────────────────────────────────── */

const WRITES = [
  ['POST', '/licence/claim', 'devicesPortal.claimSpot — licences a till'],
  ['POST', '/licence/release', 'devicesPortal.releaseSpot — frees a licence'],
  ['POST', '/licence/heartbeat', 'devicesPortal.touchDevice — stamps last-seen'],
  ['POST', '/licence/register', 'devicesPortal.selfRegister — creates a device row'],
  ['POST', '/billing/modules/add', 'billingWritePortal.addModule — buys a module'],
  ['POST', '/billing/modules/remove', 'billingWritePortal.scheduleRemoval'],
  ['POST', '/billing/modules/cancel-removal', 'billingWritePortal.cancelRemoval'],
  ['POST', '/billing/devices', 'billingWritePortal.setRequestedDevices — orders tills'],
]

console.log('\n  Writes\n')
if (!DO_WRITES) {
  for (const [method, path, why] of WRITES) {
    console.log(`  SKIP  ${method.padEnd(4)} ${path.padEnd(34)}         ${why}`)
  }
  console.log('\n  Not called: each one changes the account. Pass --writes to include the')
  console.log('  reversible ones (heartbeat, and a claim the probe releases again).')
} else {
  /* ── ONLY WHAT CAN BE PUT BACK ────────────────────────────────────────────
   *
   * `heartbeat` stamps a last-seen column the till overwrites every few minutes
   * anyway. `claim` takes a licence spot and `release` gives it back — the pair
   * is reversible ONLY as a pair, so the release runs in a finally: a probe that
   * dies between them would otherwise leave a shop one spot short with nothing
   * on screen to explain it.
   *
   * Nothing here buys anything. /billing/* and /licence/register are not
   * reachable from this script at all. */

  /* A real device row, read from the spots payload rather than guessed. A made
     up id gets `not_found`, which says nothing about whether the endpoint works. */
  const spots = await send('GET', '/licence/spots')
  /* .payload, NOT .data — this script's send() is not the app's. Reading the
     wrong one yields undefined, both lists come back empty, and every write
     below SKIPS while reporting a clean run: a vacuous pass that hides exactly
     what --writes was asked to test. */
  const existing = spots.ok && Array.isArray(spots.payload?.licences) ? spots.payload.licences : []
  const freeSpots = spots.ok && Array.isArray(spots.payload?.free) ? spots.payload.free : []
  if (!spots.ok) {
    failures++
    console.log(`  FAIL  GET  /licence/spots (for the writes below)      ${String(spots.ms).padStart(5)}ms  could not read the device list; writes cannot be attempted`)
  }

  if (existing.length) {
    const target = existing[0]
    record(
      `licence heartbeat (device ${target.deviceRowId}, "${target.name}")`,
      'POST',
      '/licence/heartbeat',
      await send('POST', '/licence/heartbeat', { deviceRowId: target.deviceRowId }),
      (p) => (p && typeof p === 'object' ? null : 'the body is not an object'),
    )
  } else {
    console.log('  SKIP  POST /licence/heartbeat                        no device rows on this site to stamp')
  }

  /* ── The claim/release pair ───────────────────────────────────────────────
   *
   * Skipped rather than forced when the account has no free spot. Claiming
   * would then either fail — telling us nothing — or, worse, succeed by
   * consuming a spot the shop is paying for. */
  if (!freeSpots.length) {
    console.log('  SKIP  POST /licence/claim                            no free spot on this site; claiming would consume a paid one')
    console.log('  SKIP  POST /licence/release                          nothing was claimed')
  } else {
    const serial = `probe-${crypto.randomUUID()}`
    const claim = await send('POST', '/licence/claim', {
      deviceRowId: freeSpots[0].deviceRowId,
      serial,
      label: 'Odyssey probe (temporary)',
    })
    record('licence claim', 'POST', '/licence/claim', claim, (p) =>
      p && typeof p === 'object' ? null : 'the body is not an object',
    )

    /* Always, even if the claim reported a failure: a partial success that
       still took the spot is exactly the case this has to clean up. */
    const claimedRow = claim.payload?.deviceRowId ?? freeSpots[0].deviceRowId
    const release = await send('POST', '/licence/release', { deviceRowId: claimedRow })
    record('licence release (undoing the claim)', 'POST', '/licence/release', release, (p) =>
      p && typeof p === 'object' ? null : 'the body is not an object',
    )
    if (!release.ok) {
      console.log(`\n  ATTENTION: the claim was not released. Free spot ${claimedRow} on site ${siteId}`)
      console.log('  may still be held by this probe. Release it from the tills screen.')
    }
  }

  for (const [method, path, why] of WRITES) {
    if (path === '/licence/heartbeat' || path === '/licence/claim' || path === '/licence/release') continue
    console.log(`  SKIP  ${method.padEnd(4)} ${path.padEnd(34)}         ${why} (never automated)`)
  }
}

/* ── Tally ────────────────────────────────────────────────────────────────── */

const pass = rows.filter((r) => r.verdict === 'PASS').length
const warn = rows.filter((r) => r.verdict === 'WARN').length
console.log(`\n  ${pass} passed, ${warn} answered-but-refused, ${failures} failed\n`)
if (warn) {
  console.log('  A WARN is the portal deciding something — often correct for a probe')
  console.log('  sending a placeholder serial or row id. Read the code before treating')
  console.log('  it as a fault.\n')
}
process.exit(failures ? 1 : 0)
