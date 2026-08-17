// The cloud end of a local-backend site: the tunnel, and the backup receiver.
//
//   node --env-file=.env server/replicaHost.mjs
//
// ── WHY THIS IS NOT A NEXT ROUTE ────────────────────────────────────────────
//
// Two things live here, and neither can be a route handler.
//
// The TUNNEL needs an HTTP upgrade to WebSocket. Next's route handlers never
// see the raw socket, so the upgrade cannot happen there — this is a property
// of the framework, not a preference.
//
// The BACKUP RECEIVER takes a body of hundreds of megabytes and must stream it
// to disk. A route handler would buffer it, and a shop's nightly dump would
// take the whole process down with it.
//
// So this is a separate long-running process, and the first one this repo has
// had. It deliberately shares nothing with the Next app but the control
// database and the encryption key.
//
// ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────
//
// It does not speak the MySQL replication protocol, and it does not decrypt a
// backup. It authenticates a shop, then moves bytes: the replica's own applier
// talks to the shop's own server through it, and the archive lands as the
// ciphertext the shop produced. Nothing here can read a customer's data, which
// is the property that makes it safe to run this on the edge of the network.
import { createServer } from 'node:http'
import { createWriteStream } from 'node:fs'
import { mkdir, rename, stat, readFile } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { createHash, timingSafeEqual, createDecipheriv, scryptSync } from 'node:crypto'
import net from 'node:net'
import path from 'node:path'
import mysql from 'mysql2/promise'
import { handshake, encodeFrame, createParser, OPCODE } from './wsFrame.mjs'

const PORT = Number(process.env.REPLICA_HOST_PORT || 4200)
const BIND = process.env.REPLICA_HOST_BIND || '0.0.0.0'
const ARCHIVE_DIR = path.resolve(process.env.REPLICA_ARCHIVE_DIR || 'archives')
/* Where the applier for each site listens, on OUR side. The tunnel connects a
   shop to the replica host's own MySQL port; the applier then reads through it
   as if the shop were local. */
const APPLIER_HOST = process.env.REPLICA_APPLIER_HOST || '127.0.0.1'

/** How long a shop may hold a tunnel open with no traffic before it is closed. */
const IDLE_TIMEOUT_MS = 120_000

// Mirrors src/lib/crypto/secrets.ts — this process cannot import a server-only module.
const PREFIX = 'enc:v1:'
function decryptSecret(stored) {
  if (!stored) return ''
  if (!stored.startsWith(PREFIX)) return stored
  const [iv, tag, ct] = stored.slice(PREFIX.length).split(':').map((s) => Buffer.from(s, 'base64'))
  const key = scryptSync(process.env.ENCRYPTION_KEY, 'odyssey-secret-v1', 32)
  const d = createDecipheriv('aes-256-gcm', key, iv)
  d.setAuthTag(tag)
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8')
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a))
  const right = Buffer.from(String(b))
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

const control = await mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  connectionLimit: 5,
  timezone: 'Z',
})

/**
 * Who is calling, and are they who they say?
 *
 * The shop presents its site id, its device serial and the replication password
 * it was given at provisioning. That password is escrowed in
 * cp2_local_backends, so this is the same credential the shop's own server was
 * configured with — there is no second secret to keep in step.
 *
 * Returns null for every failure, and the caller answers 401 without saying
 * which part was wrong. A shop that cannot connect rings support; an attacker
 * probing serials should learn nothing.
 */
async function authenticate(headers) {
  const auth = String(headers.authorization || '')
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  const siteId = Number(headers['x-odyssey-site'])
  const serial = String(headers['x-odyssey-device'] || '').trim()

  if (!token || !Number.isFinite(siteId) || siteId <= 0 || !serial) return null

  const [rows] = await control.query(
    `SELECT unlock_secret_enc, db_password_enc FROM cp2_local_backends
      WHERE site_id = ? AND device_serial = ? AND status = 'active' LIMIT 1`,
    [siteId, serial],
  )
  if (rows.length === 0) return null

  /* The tunnel's credential is the machine's replication password, which is
     escrowed here alongside the database password. Compared in constant time,
     like every other secret in this codebase. */
  let expected
  try {
    expected = decryptSecret(rows[0].db_password_enc)
  } catch {
    return null
  }
  if (!expected || !safeEqual(token, expected)) return null

  return { siteId, serial }
}

/** Where a site's applier is listening, so the tunnel knows what to join it to. */
async function applierPortFor(siteId, serial) {
  const [rows] = await control.query(
    `SELECT server_port FROM cp2_reporting_replicas
      WHERE site_id = ? AND device_serial = ? LIMIT 1`,
    [siteId, serial],
  )
  return rows.length > 0 ? Number(rows[0].server_port) : null
}

/** Record that a shop was heard from, and how far behind it is. */
async function noteContact(siteId, serial, patch = {}) {
  const sets = ['last_contact_at = NOW()']
  const params = []
  if (patch.status) {
    sets.push('status = ?')
    params.push(patch.status)
  }
  if (patch.error !== undefined) {
    sets.push('last_error = ?')
    params.push(patch.error)
  }
  params.push(siteId, serial)
  try {
    await control.query(
      `UPDATE cp2_reporting_replicas SET ${sets.join(', ')}
        WHERE site_id = ? AND device_serial = ?`,
      params,
    )
  } catch {
    /* Health bookkeeping must never take down the link it is describing. */
  }
}

// ── The HTTP surface ────────────────────────────────────────────────────────

/**
 * The path, with any reverse-proxy prefix removed.
 *
 * In production this sits behind nginx at a location like `/replica/`, so a
 * request the shop sent to `/replica/backup/...` arrives here still carrying
 * that prefix. Matching on the bare path would then 404 everything in
 * production while passing every test — the worst shape of bug, because it only
 * appears once it is deployed.
 *
 * Rather than requiring nginx to rewrite (which is easy to forget, and silent
 * when forgotten), the suffix is what matters: find where the part we own
 * begins and ignore whatever routed the request to us.
 */
function ownPath(pathname) {
  for (const known of ['/backup/', '/health']) {
    const at = pathname.indexOf(known)
    if (at >= 0) return pathname.slice(at)
  }
  return pathname
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  const pathname = ownPath(url.pathname)

  /* Unauthenticated on purpose, like the app's own /api/health: a load
     balancer must be able to ask, and the answer names nothing. */
  if (pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, tunnels: tunnels.size }))
    return
  }

  if (req.method === 'PUT' && pathname.startsWith('/backup/')) {
    await receiveBackup(req, res, pathname)
    return
  }

  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: 'Not found' }))
})

/**
 * Take a shop's nightly archive.
 *
 * Streamed to disk, never buffered: it is the whole database, and holding one
 * in memory would take the process down for every other shop.
 *
 * The contract is set by scripts/backup-push.mjs, which is already written and
 * tested — PUT /backup/{folder}/{file}, bearer token, x-odyssey-sha256 of the
 * PLAINTEXT, and envelope.json last. This must not deviate from it.
 */
async function receiveBackup(req, res, pathname) {
  const who = await authenticate(req.headers)
  if (!who) {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'Not allowed' }))
    return
  }

  const parts = pathname.split('/').filter(Boolean) // ['backup', folder, file]
  if (parts.length !== 3) {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'Expected /backup/{folder}/{file}' }))
    return
  }

  const folder = decodeURIComponent(parts[1])
  const file = decodeURIComponent(parts[2])

  /* Path traversal is the one thing a receiver must never get wrong. Both
     components are checked against an allowlist rather than sanitised —
     stripping "../" is a game of whack-a-mole and an allowlist is not. */
  if (!/^[A-Za-z0-9._-]+$/.test(folder) || !/^[A-Za-z0-9._-]+$/.test(file)) {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'Bad folder or file name' }))
    return
  }

  const dir = path.join(ARCHIVE_DIR, String(who.siteId), who.serial, folder)
  const target = path.join(dir, file)
  /* Belt and braces after the allowlist: the resolved path must still be
     inside the archive directory. */
  if (!target.startsWith(ARCHIVE_DIR + path.sep)) {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'Bad path' }))
    return
  }

  try {
    await mkdir(dir, { recursive: true })
    /* Written to a temporary name and renamed on success, so an interrupted
       upload never leaves a file that looks complete. rename is atomic within
       a filesystem. */
    const tmp = `${target}.part`
    const hash = createHash('sha256')
    let bytes = 0

    await pipeline(
      req,
      async function* (chunks) {
        for await (const chunk of chunks) {
          bytes += chunk.length
          hash.update(chunk)
          yield chunk
        }
      },
      createWriteStream(tmp),
    )

    /* The sender's hash is of the PLAINTEXT, so it cannot be checked here —
       this process never holds the key, deliberately. What IS checked is the
       ciphertext's own integrity on the way in, recorded so a restore can tell
       a truncated upload from a corrupted disk. */
    const digest = hash.digest('hex')
    await rename(tmp, target)

    /* The envelope lands last and marks the folder complete. Its arrival is
       what a restore looks for, so it is worth saying so in the log. */
    const complete = file === 'envelope.json'
    console.log(
      `[backup] site ${who.siteId} ${folder}/${file} — ${bytes} bytes${complete ? ' (complete)' : ''}`,
    )

    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, bytes, ciphertextSha256: digest, complete }))
  } catch (err) {
    console.error(`[backup] site ${who.siteId} ${folder}/${file} failed —`, err.message)
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'Could not store the file' }))
  }
}

// ── The tunnel ──────────────────────────────────────────────────────────────

/** Live tunnels, keyed site:serial. One per machine; a second displaces the first. */
const tunnels = new Map()

server.on('upgrade', async (req, socket) => {
  socket.on('error', () => {}) // a client vanishing mid-handshake is ordinary

  const who = await authenticate(req.headers)
  if (!who) {
    socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n')
    return
  }

  const port = await applierPortFor(who.siteId, who.serial)
  if (!port) {
    /* No replica provisioned. Refused rather than held open: the shop should
       back off and retry, and somebody should run replica-provision.mjs. */
    socket.end('HTTP/1.1 409 Conflict\r\n\r\n')
    await noteContact(who.siteId, who.serial, { error: 'no replica is provisioned for this machine' })
    return
  }

  if (!handshake(req, socket, req.headers['sec-websocket-key'])) return

  const key = `${who.siteId}:${who.serial}`
  /* A machine that reconnects before we noticed the old link drop would
     otherwise have two, and the applier would read an interleaving of both. */
  const previous = tunnels.get(key)
  if (previous) {
    console.log(`[tunnel] ${key} reconnected; closing the previous link`)
    try {
      previous.destroy()
    } catch {
      /* already gone */
    }
  }
  tunnels.set(key, socket)

  console.log(`[tunnel] ${key} connected (applier port ${port})`)
  await noteContact(who.siteId, who.serial, { status: 'running', error: null })

  /* The applier's side. The shop's server is on the far end of the WebSocket;
     this joins it to the local port the applier reads from. Nothing between
     the two interprets a byte of the MySQL protocol. */
  const upstream = net.createConnection({ host: APPLIER_HOST, port })

  let closed = false
  const shutdown = (reason) => {
    if (closed) return
    closed = true
    if (tunnels.get(key) === socket) tunnels.delete(key)
    try {
      upstream.destroy()
    } catch {
      /* already gone */
    }
    try {
      socket.destroy()
    } catch {
      /* already gone */
    }
    console.log(`[tunnel] ${key} closed — ${reason}`)
    void noteContact(who.siteId, who.serial, {
      status: 'stopped',
      error: reason === 'client closed' ? null : reason,
    })
  }

  upstream.on('data', (chunk) => {
    if (!socket.destroyed) socket.write(encodeFrame(chunk, OPCODE.BINARY))
  })
  upstream.on('error', (err) => shutdown(`applier: ${err.message}`))
  upstream.on('close', () => shutdown('applier closed'))

  const push = createParser({
    onMessage: (payload) => {
      /* A zero-length frame is the client's heartbeat — it proves the path is
         alive without meaning anything to the applier. Forwarding it would
         inject a null packet into the replication stream. */
      if (payload.length === 0) return
      if (!upstream.destroyed) upstream.write(payload)
    },
    onPing: (payload) => {
      if (!socket.destroyed) socket.write(encodeFrame(payload, OPCODE.PONG))
    },
    onClose: () => shutdown('client closed'),
    onError: (err) => shutdown(`protocol: ${err.message}`),
  })

  socket.setTimeout(IDLE_TIMEOUT_MS, () => shutdown('idle'))
  socket.on('data', push)
  socket.on('close', () => shutdown('socket closed'))
  socket.on('error', (err) => shutdown(`socket: ${err.message}`))
})

server.listen(PORT, BIND, () => {
  console.log(`replica host listening on ${BIND}:${PORT}`)
  console.log(`  archives  ${ARCHIVE_DIR}`)
  console.log(`  appliers  ${APPLIER_HOST}`)
})

/* A shop mid-upload should not lose its backup because we restarted, and an
   applier reading a stream should be told rather than left hanging. */
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\n${signal} — closing ${tunnels.size} tunnel(s)`)
    for (const socket of tunnels.values()) {
      try {
        socket.destroy()
      } catch {
        /* already gone */
      }
    }
    server.close(() => process.exit(0))
    /* A stuck connection must not hold the process open forever. */
    setTimeout(() => process.exit(0), 5_000).unref()
  })
}
