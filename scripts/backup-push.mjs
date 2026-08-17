// Send a local backend's nightly backup to the cloud, encrypted.
//
//   node --env-file=.env scripts/backup-push.mjs [--dir <backup folder>] [--dry-run]
//
// Runs AFTER backup.mjs, on whatever it most recently produced. Kept separate
// on purpose: making a backup and sending one away are different failures with
// different remedies, and a shop whose line is down should still be making
// local backups every night without a red line in the log about an upload.
//
// ── WHY THE MACHINE ENCRYPTS BEFORE IT UPLOADS ──────────────────────────────
//
// A local-backend customer chose local partly to keep their trading data on
// their own premises. Shipping it to us in the clear every night would quietly
// undo that, and it would make our storage a single target holding readable
// takings, margins and customer lists for every shop that runs one.
//
// So the machine encrypts with a key it generated itself, and we store
// ciphertext we cannot read. The key is escrowed to the control panel — the
// same escrow as the database password — so a shop that loses the machine
// entirely can still be restored by support. That escrow is what makes
// client-side encryption safe to insist on: without it, "only the shop holds
// the key" means "a dead hard drive is a dead shop".
//
// ── AES-256-GCM, PER FILE, WITH A RANDOM IV ─────────────────────────────────
//
// Streaming rather than in-memory: a dump is hundreds of megabytes and a till
// PC has no headroom to hold one twice. GCM gives authentication as well as
// secrecy, so a truncated or altered upload fails on restore rather than
// producing a database that is subtly wrong.
import { createReadStream, createWriteStream } from 'node:fs'
import { readdir, readFile, stat, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { createCipheriv, randomBytes, createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'

const BACKUP_DIR = path.resolve(process.env.BACKUP_DIR || 'backups')
const PUSH_URL = process.env.BACKUP_PUSH_URL || ''
const PUSH_TOKEN = process.env.BACKUP_PUSH_TOKEN || ''
const SITE_ID = process.env.ODYSSEY_SITE_ID || ''
const DEVICE_SERIAL = process.env.ODYSSEY_DEVICE_SERIAL || ''
/* The shop's own backup key, base64. Generated at provisioning and escrowed.
   Deliberately NOT ENCRYPTION_KEY: that one protects credentials in the control
   database and is shared with the v2 backend, and a key used for two unrelated
   purposes is a key that cannot be rotated for either. */
const BACKUP_KEY = process.env.BACKUP_ENCRYPTION_KEY || ''

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const dirArg = args.includes('--dir') ? args[args.indexOf('--dir') + 1] : null

function fail(message) {
  console.error(`backup-push: ${message}`)
  process.exit(1)
}

/** The most recent stamped run folder, or the one named on the command line. */
async function latestRun() {
  if (dirArg) return path.resolve(dirArg)
  const entries = await readdir(BACKUP_DIR).catch(() => [])
  const folders = []
  for (const e of entries) {
    if (e === 'manifest.json') continue
    const full = path.join(BACKUP_DIR, e)
    const info = await stat(full).catch(() => null)
    if (info?.isDirectory()) folders.push({ name: e, full, mtime: info.mtimeMs })
  }
  if (folders.length === 0) return null
  folders.sort((a, b) => b.mtime - a.mtime)
  return folders[0].full
}

/**
 * Encrypt one file to a temporary path.
 *
 * Layout: [12-byte IV][ciphertext][16-byte GCM tag]. The tag goes last because
 * it is not known until the stream ends, and putting it first would mean
 * buffering the whole file to find out what it is.
 *
 * Returns the plaintext SHA-256 as well, so a restore can prove it decrypted to
 * the bytes that were actually backed up rather than merely to something that
 * authenticated.
 */
async function encryptFile(source, destination, key) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const hash = createHash('sha256')

  const out = createWriteStream(destination)
  out.write(iv)

  await pipeline(
    createReadStream(source),
    async function* (chunks) {
      for await (const chunk of chunks) {
        hash.update(chunk)
        yield cipher.update(chunk)
      }
      yield cipher.final()
    },
    out,
    { end: false },
  )

  await new Promise((resolve, reject) => {
    out.end(cipher.getAuthTag(), (err) => (err ? reject(err) : resolve()))
  })

  const info = await stat(destination)
  return { bytes: info.size, sha256: hash.digest('hex') }
}

async function main() {
  if (!BACKUP_KEY) fail('BACKUP_ENCRYPTION_KEY is not set — refusing to upload in the clear.')
  const key = Buffer.from(BACKUP_KEY, 'base64')
  if (key.length !== 32) fail('BACKUP_ENCRYPTION_KEY must be 32 bytes, base64 encoded.')

  if (!dryRun) {
    if (!PUSH_URL) fail('BACKUP_PUSH_URL is not set.')
    if (!PUSH_TOKEN) fail('BACKUP_PUSH_TOKEN is not set.')
  }

  const runDir = await latestRun()
  if (!runDir) fail(`no backup folders found under ${BACKUP_DIR} — run backup.mjs first.`)

  /* Refuse to send a backup that reported a failure. A half-made backup that
     LOOKS like a good one on our side is worse than no backup at all: it is the
     one somebody reaches for on the day it matters. */
  const manifestRaw = await readFile(path.join(runDir, 'manifest.json'), 'utf8').catch(() => null)
  if (!manifestRaw) fail(`${runDir} has no manifest.json — it may still be being written.`)
  const manifest = JSON.parse(manifestRaw)
  if (!manifest.ok) fail(`the backup in ${runDir} reported failures — not uploading it.`)

  const files = (await readdir(runDir)).filter((f) => f !== 'manifest.json')
  if (files.length === 0) fail(`${runDir} is empty.`)

  const staging = await mkdtemp(path.join(tmpdir(), 'odyssey-push-'))
  const uploaded = []
  /* The staging copy is the shop's whole database, encrypted but still theirs.
     It is removed on every path except a dry run, which says where it went. */
  let keepStaging = false

  try {
    for (const name of files) {
      const source = path.join(runDir, name)
      const info = await stat(source)
      if (!info.isFile()) continue // the tar fallback writes a directory; skip it

      const target = path.join(staging, `${name}.enc`)
      const { bytes, sha256 } = await encryptFile(source, target, key)
      uploaded.push({ name, encrypted: `${name}.enc`, bytes, sha256, path: target })
      console.log(`  encrypted ${name} → ${bytes} bytes`)
    }

    const envelope = {
      siteId: SITE_ID ? Number(SITE_ID) : null,
      deviceSerial: DEVICE_SERIAL || null,
      folder: path.basename(runDir),
      startedAt: manifest.startedAt,
      finishedAt: manifest.finishedAt,
      /* What the ciphertext is, so the far end can verify a restore without
         being able to read anything. */
      files: uploaded.map(({ name, encrypted, bytes, sha256 }) => ({
        name,
        encrypted,
        bytes,
        sha256,
      })),
      algorithm: 'aes-256-gcm',
      layout: 'iv(12) || ciphertext || tag(16)',
    }
    await writeFile(path.join(staging, 'envelope.json'), JSON.stringify(envelope, null, 2))

    if (dryRun) {
      /* Left on disk deliberately, and the caller is told where. A dry run
         exists to be inspected — to prove the ciphertext decrypts before
         trusting a night's backup to it — and deleting the evidence would make
         it a test of nothing. */
      keepStaging = true
      console.log(`\ndry run — ${uploaded.length} file(s) encrypted into ${staging}`)
      console.log(JSON.stringify(envelope, null, 2))
      return
    }

    for (const file of uploaded) {
      const url = `${PUSH_URL.replace(/\/$/, '')}/${encodeURIComponent(envelope.folder)}/${encodeURIComponent(file.encrypted)}`
      const body = createReadStream(file.path)
      const res = await fetch(url, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${PUSH_TOKEN}`,
          'content-type': 'application/octet-stream',
          'content-length': String(file.bytes),
          'x-odyssey-site': String(envelope.siteId ?? ''),
          'x-odyssey-device': envelope.deviceSerial ?? '',
          'x-odyssey-sha256': file.sha256,
        },
        body,
        duplex: 'half', // required by undici when streaming a request body
      })
      if (!res.ok) fail(`upload of ${file.encrypted} failed with ${res.status} ${res.statusText}`)
      console.log(`  sent ${file.encrypted}`)
    }

    const envRes = await fetch(
      `${PUSH_URL.replace(/\/$/, '')}/${encodeURIComponent(envelope.folder)}/envelope.json`,
      {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${PUSH_TOKEN}`,
          'content-type': 'application/json',
          'x-odyssey-site': String(envelope.siteId ?? ''),
        },
        /* The envelope goes LAST. Its presence is what marks a backup complete
           at the far end, so a push interrupted halfway leaves an obviously
           partial folder rather than one that looks restorable. */
        body: JSON.stringify(envelope),
      },
    )
    if (!envRes.ok) fail(`upload of the envelope failed with ${envRes.status}`)

    console.log(`done — ${uploaded.length} file(s) sent for ${envelope.folder}`)
  } finally {
    if (!keepStaging) await rm(staging, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error('backup-push failed:', err?.message || err)
  process.exit(1)
})
