/**
 * The replica host's HTTP surface: authentication, path safety, and taking a
 * backup without buffering it.
 *
 * The control database is stubbed, so this runs anywhere and tests the
 * decisions rather than the schema. What it deliberately does exercise for
 * real is the streaming write path and the path-traversal guards — the two
 * places where a mistake is a breach or an outage rather than a wrong answer.
 *
 *   node scripts/test-replica-host.mjs
 */
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { createWriteStream } from 'node:fs'
import { mkdir, rename } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'

let failures = 0
function check(name, ok, detail = '') {
  if (ok) console.log(`  PASS  ${name}`)
  else {
    failures++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const ARCHIVE_DIR = mkdtempSync(path.join(tmpdir(), 'odyssey-arch-'))
const TOKEN = 'the-machines-replication-password'
const SITE = 7
const SERIAL = 'TILL-A'

/* The host's own logic, with the control-database lookup stubbed. Reproduced
   rather than imported because replicaHost.mjs opens a pool at module load —
   importing it would need a live database, which is exactly what this avoids.
   The behaviour under test is the request handling, and it is identical. */
function safeEqual(a, b) {
  const l = Buffer.from(String(a))
  const r = Buffer.from(String(b))
  if (l.length !== r.length) return false
  return timingSafeEqual(l, r)
}

function authenticate(headers) {
  const auth = String(headers.authorization || '')
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  const siteId = Number(headers['x-odyssey-site'])
  const serial = String(headers['x-odyssey-device'] || '').trim()
  if (!token || !Number.isFinite(siteId) || siteId <= 0 || !serial) return null
  if (siteId !== SITE || serial !== SERIAL) return null // the stubbed lookup
  if (!safeEqual(token, TOKEN)) return null
  return { siteId, serial }
}

/* Kept identical to replicaHost.mjs — see the note there. In production this
   sits behind nginx at a location like /replica/, so the prefix arrives with
   the request and matching on the bare path would 404 everything in production
   while passing every test here. */
function ownPath(pathname) {
  for (const known of ['/backup/', '/health']) {
    const at = pathname.indexOf(known)
    if (at >= 0) return pathname.slice(at)
  }
  return pathname
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const pathname = ownPath(url.pathname)

  if (pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, tunnels: 0 }))
    return
  }

  if (req.method !== 'PUT' || !pathname.startsWith('/backup/')) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'Not found' }))
    return
  }

  const who = authenticate(req.headers)
  if (!who) {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'Not allowed' }))
    return
  }

  const parts = pathname.split('/').filter(Boolean)
  if (parts.length !== 3) {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'Expected /backup/{folder}/{file}' }))
    return
  }
  const folder = decodeURIComponent(parts[1])
  const file = decodeURIComponent(parts[2])
  if (!/^[A-Za-z0-9._-]+$/.test(folder) || !/^[A-Za-z0-9._-]+$/.test(file)) {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'Bad folder or file name' }))
    return
  }

  const dir = path.join(ARCHIVE_DIR, String(who.siteId), who.serial, folder)
  const target = path.join(dir, file)
  if (!target.startsWith(ARCHIVE_DIR + path.sep)) {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'Bad path' }))
    return
  }

  await mkdir(dir, { recursive: true })
  const tmp = `${target}.part`
  const hash = createHash('sha256')
  let bytes = 0
  await pipeline(
    req,
    async function* (chunks) {
      for await (const c of chunks) {
        bytes += c.length
        hash.update(c)
        yield c
      }
    },
    createWriteStream(tmp),
  )
  await rename(tmp, target)

  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true, bytes, ciphertextSha256: hash.digest('hex'), complete: file === 'envelope.json' }))
})

await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`

const goodHeaders = {
  authorization: `Bearer ${TOKEN}`,
  'x-odyssey-site': String(SITE),
  'x-odyssey-device': SERIAL,
  'content-type': 'application/octet-stream',
}

console.log('\nHealth is open, and says nothing')
{
  const res = await fetch(`${base}/health`)
  const body = await res.json()
  check('it answers without a token', res.status === 200 && body.ok === true)
  check('and names no site', !JSON.stringify(body).includes(String(SITE)))
}

console.log('\nAuthentication')
{
  const put = (headers) =>
    fetch(`${base}/backup/2026-08-17T0200/site-7.sql.gz.enc`, { method: 'PUT', headers, body: 'x' })

  check('no token is refused', (await put({})).status === 401)
  check(
    'a wrong token is refused',
    (await put({ ...goodHeaders, authorization: 'Bearer wrong' })).status === 401,
  )
  check(
    'the right token for the wrong site is refused',
    (await put({ ...goodHeaders, 'x-odyssey-site': '8' })).status === 401,
  )
  check(
    'the right token for the wrong machine is refused',
    (await put({ ...goodHeaders, 'x-odyssey-device': 'TILL-B' })).status === 401,
  )
  check('a missing device header is refused', (await put({ ...goodHeaders, 'x-odyssey-device': '' })).status === 401)
  check('the right credentials are accepted', (await put(goodHeaders)).status === 200)
}

console.log('\nPath traversal cannot escape the archive')
{
  const attempts = [
    '/backup/..%2F..%2Fetc/passwd',
    '/backup/2026-08-17/..%2F..%2F..%2Fescaped.txt',
    '/backup/%2e%2e/%2e%2e/evil.sql',
    '/backup/ok/sub%2Fdir.enc',
  ]
  let allRefused = true
  for (const p of attempts) {
    const res = await fetch(base + p, { method: 'PUT', headers: goodHeaders, body: 'x' })
    if (res.status === 200) {
      allRefused = false
      check(`  refused ${p}`, false)
    }
  }
  if (allRefused) check('every traversal attempt was refused', true)
  check('nothing was written outside the archive', !existsSync(path.join(ARCHIVE_DIR, '..', 'escaped.txt')))
}

console.log('\nA real archive upload')
{
  /* Big enough to cross many chunks, so the streaming path is what runs. */
  const payload = randomBytes(3_000_000)
  const res = await fetch(`${base}/backup/2026-08-17T0200/site-7.sql.gz.enc`, {
    method: 'PUT',
    headers: goodHeaders,
    body: payload,
  })
  const body = await res.json()

  check('it was accepted', res.status === 200)
  check('every byte arrived', body.bytes === payload.length, `${body.bytes} of ${payload.length}`)
  check(
    'the stored ciphertext hash matches',
    body.ciphertextSha256 === createHash('sha256').update(payload).digest('hex'),
  )

  const stored = path.join(ARCHIVE_DIR, String(SITE), SERIAL, '2026-08-17T0200', 'site-7.sql.gz.enc')
  check('it landed under its own site and machine', existsSync(stored))
  check('byte for byte', readFileSync(stored).equals(payload))
  check('no .part file was left behind', !existsSync(`${stored}.part`))
}

console.log('\nThe envelope marks a folder complete')
{
  const before = await fetch(`${base}/backup/2026-08-17T0200/uploads.tar.gz.enc`, {
    method: 'PUT', headers: goodHeaders, body: 'tarball',
  }).then((r) => r.json())
  check('an ordinary file is not "complete"', before.complete === false)

  const env = await fetch(`${base}/backup/2026-08-17T0200/envelope.json`, {
    method: 'PUT', headers: goodHeaders, body: JSON.stringify({ files: [] }),
  }).then((r) => r.json())
  check('the envelope is', env.complete === true)
}

console.log('\nSites cannot reach each other')
{
  /* Even with valid credentials, the path is derived from the AUTHENTICATED
     identity rather than anything the client sent — so there is no request
     that writes into another site's folder. */
  await fetch(`${base}/backup/folder-x/f.enc`, { method: 'PUT', headers: goodHeaders, body: 'x' })
  check(
    'the file landed under the authenticated site, not a requested one',
    existsSync(path.join(ARCHIVE_DIR, String(SITE), SERIAL, 'folder-x', 'f.enc')),
  )
  check('and site 8 has no directory at all', !existsSync(path.join(ARCHIVE_DIR, '8')))
}

console.log('\nBehind a reverse proxy, which is how it actually runs')
{
  /* nginx at `location /replica/` passes the prefix through. Matching on the
     bare path would 404 every request in production while every other test
     here still passed — the worst shape of bug, because it only appears once
     it is deployed. */
  const res = await fetch(`${base}/replica/backup/2026-08-18T0200/site-7.sql.gz.enc`, {
    method: 'PUT',
    headers: goodHeaders,
    body: 'proxied',
  })
  check('a prefixed upload is accepted', res.status === 200)
  check(
    'and lands in the same place as an unprefixed one',
    existsSync(path.join(ARCHIVE_DIR, String(SITE), SERIAL, '2026-08-18T0200', 'site-7.sql.gz.enc')),
  )
  check(
    'the prefix does not become part of the stored path',
    !existsSync(path.join(ARCHIVE_DIR, String(SITE), SERIAL, 'replica')),
  )

  const health = await fetch(`${base}/replica/health`)
  check('health answers through the proxy too', health.status === 200)

  /* A deeper mount, because /replica/ is a convention rather than a rule. */
  const deep = await fetch(`${base}/services/odyssey/replica/backup/2026-08-18T0200/x.enc`, {
    method: 'PUT',
    headers: goodHeaders,
    body: 'deep',
  })
  check('any mount point works', deep.status === 200)
}

console.log('\nUnknown routes say nothing useful')
{
  const res = await fetch(`${base}/admin`, { method: 'GET' })
  check('a stray GET is a plain 404', res.status === 404)
  const traversalish = await fetch(`${base}/backup/`, { method: 'PUT', headers: goodHeaders, body: 'x' })
  check('a bare /backup/ is refused', traversalish.status === 400)
}

server.close()
rmSync(ARCHIVE_DIR, { recursive: true, force: true })

console.log(failures === 0 ? '\nReplica host holds.\n' : `\n${failures} FAILED\n`)
process.exit(failures === 0 ? 0 : 1)
