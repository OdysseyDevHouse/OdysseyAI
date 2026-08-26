// The control panel, over HTTPS, instead of a MySQL socket.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
//
// Until now a customer's machine opened a direct connection to the control
// database on port 3306, using credentials baked into the installer. That works
// in an office whose IP is whitelisted and nowhere else — which is exactly the
// wall the setup wizard hit — and it means every installer carries credentials
// that read every shop on the platform, plus the ENCRYPTION_KEY that decrypts
// their stored database passwords.
//
// The POS API replaces both. One POST, over TLS, through any firewall that
// allows ordinary web traffic. The answer carries only what this login may see,
// and the database passwords inside it are sealed to a key issued to this
// client alone.
//
// ── WHAT IS STILL TRUE, AND WORTH SAYING ────────────────────────────────────
//
// The client id, client secret and payload key are baked into the installer, so
// a determined customer can extract them — an asar unpacks in seconds. That is
// a real reduction from before rather than a solved problem: they are a SECOND
// lock, useless without a shop's own email and password, scoped to the Windows
// client alone, and revocable in a minute. Before, the installer held the keys
// to the platform.
//
// Revoking them means shipping a new build to every machine, which is why the
// updater matters. See electron/updater.js.
const crypto = require('node:crypto')

/** Baked at build time; a dev checkout falls back to its own environment. */
function config() {
  let baked = {}
  try {
    // eslint-disable-next-line global-require
    baked = require('./buildDefaults.json')
  } catch {
    /* Not packaged, or a build that predates the API. */
  }
  return {
    url: process.env.POS_API_URL || baked.POS_API_URL || '',
    clientId: process.env.POS_API_CLIENT_ID || baked.POS_API_CLIENT_ID || '',
    clientSecret: process.env.POS_API_CLIENT_SECRET || baked.POS_API_CLIENT_SECRET || '',
    payloadKey: process.env.POS_API_PAYLOAD_KEY || baked.POS_API_PAYLOAD_KEY || '',
  }
}

/**
 * Accept whatever form the URL was configured in.
 *
 * `portal.example.co.za`, `https://portal.example.co.za` and the full
 * `https://portal.example.co.za/api/pos/v1` all mean the same thing, and the
 * person setting it should not have to know which one this code wanted. A
 * missing scheme is https rather than http — there is no version of this call
 * that should travel in the clear.
 */
function baseUrl() {
  let url = config().url.trim().replace(/\/+$/, '')
  if (!url) return ''
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`
  if (!/\/api\/pos\/v\d+$/i.test(url)) url = `${url}/api/pos/v1`
  return url
}

/**
 * Open a `pos:v1:` envelope.
 *
 * AES-256-GCM, no key derivation — the payload key is 32 raw bytes given as
 * base64. The auth tag is VERIFIED rather than merely present: without that
 * check the ciphertext is malleable and a tampered value would come back as a
 * corrupted password instead of an error, which the caller would then hand to
 * MariaDB and blame on the customer.
 */
function openEnvelope(envelope) {
  if (typeof envelope !== 'string' || !envelope.startsWith('pos:v1:')) {
    throw new Error('Not a pos:v1 envelope.')
  }
  const key = Buffer.from(config().payloadKey, 'base64')
  if (key.length !== 32) {
    throw new Error('The payload key is missing or not 32 bytes. This build cannot read credentials.')
  }
  /* Split into exactly three, so a base64 value containing ':' cannot shift the
     parts along. The ciphertext may legitimately be empty. */
  const parts = envelope.slice('pos:v1:'.length).split(':')
  if (parts.length !== 3) throw new Error('Malformed pos:v1 envelope.')
  const [iv, tag, ct] = parts

  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'))
  d.setAuthTag(Buffer.from(tag, 'base64'))
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8')
}

/**
 * What to say when the API refuses.
 *
 * The `message` the server sends is written for a person and is safe to show —
 * but a few codes deserve better than a generic sentence, because the person
 * reading them is a technician who can act on the distinction. Which half of a
 * credential was wrong is deliberately never disclosed.
 */
function describe(status, body) {
  const code = body?.error
  const said = body?.message
  switch (code) {
    case 'invalid_client':
      /* Not the customer's problem, and saying so saves a support call spent
         resetting a password that was never wrong. */
      return 'This copy of Odyssey is not authorised. Contact Odyssey support — the shop’s login is not the problem.'
    case 'invalid_credentials': {
      const left = body?.attemptsRemaining
      return typeof left === 'number' && left <= 3
        ? `Incorrect email or password. ${left} attempt${left === 1 ? '' : 's'} left before the account locks.`
        : 'Incorrect email or password.'
    }
    case 'account_suspended':
      return said || 'This account is suspended. Contact Odyssey support.'
    case 'account_locked':
      return said || 'Too many failed attempts. Try again shortly.'
    case 'rate_limited':
      return 'Too many sign-in attempts from this network. Wait a few minutes and try again.'
    case 'server_misconfigured':
    case 'server_error':
      return `Odyssey’s server reported a problem: ${said || 'no detail given'}`
    default:
      return said || `The control panel returned ${status}.`
  }
}

async function call(path, { method = 'GET', body } = {}) {
  const base = baseUrl()
  if (!base) throw new Error('No control panel URL is configured for this build.')

  const { clientId, clientSecret } = config()
  if (!clientId || !clientSecret) {
    throw new Error('This build has no control panel credentials. It cannot sign in.')
  }

  let res
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'X-Api-Client-Id': clientId,
        'X-Api-Client-Secret': clientSecret,
      },
      body: body ? JSON.stringify(body) : undefined,
    })
  } catch (err) {
    /* No answer at all — a shop with no line, a proxy in the way, DNS. Named as
       a connection problem rather than a credential one, because the person
       will otherwise start retyping a password that was always right. */
    throw new Error(
      `Could not reach the Odyssey control panel. Check this machine’s internet connection. (${err?.message || err})`,
    )
  }

  const text = await res.text()
  let parsed = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    /* An HTML error page from a proxy, most likely. */
  }

  if (!res.ok) {
    const error = new Error(describe(res.status, parsed))
    error.code = parsed?.error || `http_${res.status}`
    error.status = res.status
    throw error
  }
  return parsed
}

/** Prove the build's own credentials, without needing a customer's. */
async function ping() {
  return call('/ping')
}

/**
 * Sign a person in and get everything their login may open.
 *
 * One call, no session and no token to keep — see the API's own notes. The
 * whole payload comes back, so the caller holds the stores, their databases,
 * their modules and their devices without asking again.
 */
async function login(email, password, deviceSerial) {
  const payload = await call('/login', {
    method: 'POST',
    body: { email, password, deviceSerial: deviceSerial || undefined },
  })
  return payload
}

/**
 * The database a store keeps its shop in.
 *
 * `master` is the one this product provisions and connects to. The API's
 * purpose vocabulary is wider — stock_file, customer_file and the rest — but
 * this installation has exactly one idea of a shop's database, and asking for
 * anything else here would be inventing a shape the app cannot use.
 *
 * A `hybrid` store keeps its in-store spool under a `hybrid` purpose and its
 * real shop in the cloud, so the caller says which it wants.
 */
function databaseFor(store, purpose = 'master') {
  const rows = Array.isArray(store?.databases) ? store.databases : []
  return rows.find((d) => d.purpose === purpose && d.status === 'active') || null
}

module.exports = { ping, login, openEnvelope, databaseFor, baseUrl, config }
