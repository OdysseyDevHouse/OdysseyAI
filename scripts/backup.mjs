// Backs up every site database, the control database, and uploads/ — together.
//
//   node --env-file=.env scripts/backup.mjs [--dry-run] [--site <id>]
//
// TOGETHER is the word that matters: document bytes live in uploads/ while
// their rows live in the databases (see sql/site/031), so a backup of one
// without the other restores to a shop with attachments that 404 or rows
// that point at nothing. One stamped folder holds one consistent moment.
//
// Retention: folders older than BACKUP_RETENTION_DAYS (default 14) are
// deleted at the end of a SUCCESSFUL run. The manifest at backups/manifest.json
// is what a scheduler or a human checks — the exit code is 1 when anything
// failed, so a cron wrapper can alert.
//
// Restore: see docs/backup.md. The short version — the dumps are unreadable
// without .env's ENCRYPTION_KEY (the control dump holds enc:v1 passwords),
// so the .env file must be kept in a separate secure copy. A backup of the
// databases alone is not a backup of the system.
import { mkdir, readdir, rm, writeFile, cp, stat } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { spawn } from 'node:child_process'
import { createGzip } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createDecipheriv, scryptSync } from 'node:crypto'
import mysql from 'mysql2/promise'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dryRun = process.argv.includes('--dry-run')
const onlySite = process.argv.includes('--site')
  ? Number(process.argv[process.argv.indexOf('--site') + 1])
  : null

const BACKUP_DIR = process.env.BACKUP_DIR?.trim() || path.join(root, 'backups')
const UPLOADS_DIR = process.env.UPLOADS_DIR?.trim() || path.join(root, 'uploads')
const RETENTION_DAYS = Number(process.env.BACKUP_RETENTION_DAYS) || 14
const MYSQLDUMP = process.env.MYSQLDUMP_PATH?.trim() || 'mysqldump'

// Mirrors src/lib/crypto/secrets.ts, exactly as site-migrate.mjs does.
const PREFIX = 'enc:v1:'
function decryptSecret(stored) {
  if (!stored) return ''
  if (!stored.startsWith(PREFIX)) return stored
  const [iv, tag, ct] = stored
    .slice(PREFIX.length)
    .split(':')
    .map((s) => Buffer.from(s, 'base64'))
  const key = scryptSync(process.env.ENCRYPTION_KEY, 'odyssey-secret-v1', 32)
  const d = createDecipheriv('aes-256-gcm', key, iv)
  d.setAuthTag(tag)
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8')
}

const stampOf = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`

/** One dump, gzipped, password via env so it never appears in a process list. */
function dumpDatabase({ host, port, user, password, database }, outFile) {
  return new Promise((resolve) => {
    const args = [
      `--host=${host}`,
      `--port=${port}`,
      `--user=${user}`,
      '--single-transaction',
      '--routines',
      '--triggers',
      '--no-tablespaces',
      database,
    ]
    const child = spawn(MYSQLDUMP, args, {
      env: { ...process.env, MYSQL_PWD: password },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('error', (e) => resolve({ ok: false, error: `${MYSQLDUMP} could not start: ${e.message}` }))

    const gzip = createGzip()
    const sink = createWriteStream(outFile)
    pipeline(child.stdout, gzip, sink).catch(() => undefined)

    child.on('close', async (code) => {
      if (code !== 0) {
        resolve({ ok: false, error: stderr.trim().split('\n').at(-1) || `exit ${code}` })
        return
      }
      const info = await stat(outFile).catch(() => null)
      if (!info || info.size < 200) {
        resolve({ ok: false, error: 'the dump came out empty' })
        return
      }
      resolve({ ok: true, bytes: info.size })
    })
  })
}

function archiveUploads(outFile) {
  return new Promise((resolve) => {
    const child = spawn('tar', ['-czf', outFile, '-C', UPLOADS_DIR, '.'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('error', () => resolve({ ok: false, error: 'tar unavailable' }))
    child.on('close', async (code) => {
      if (code !== 0) {
        resolve({ ok: false, error: stderr.trim() || `tar exit ${code}` })
        return
      }
      const info = await stat(outFile).catch(() => null)
      resolve(info ? { ok: true, bytes: info.size } : { ok: false, error: 'no archive written' })
    })
  })
}

const started = new Date()
const stamp = stampOf(started)
const runDir = path.join(BACKUP_DIR, stamp)

const control = await mysql.createConnection({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
})

// Suspended sites still deserve backups — only truly closed ones are skipped.
const [sites] = await control.query(
  `SELECT d.site_id, d.server_host, d.server_port, d.database_name, d.db_username, d.db_password_enc
     FROM cp2_site_databases d
     JOIN cp2_sites s ON s.id = d.site_id
    WHERE d.status = 'active' AND s.status IN ('active', 'suspended')
    ORDER BY d.site_id`,
)
await control.end()

const targets = []
for (const site of sites) {
  if (onlySite && Number(site.site_id) !== onlySite) continue
  targets.push({
    name: `site-${site.site_id}-${site.database_name}`,
    host: process.env.SITE_DB_HOST_OVERRIDE?.trim() || site.server_host,
    port: site.server_port || 3306,
    user: site.db_username,
    password: decryptSecret(site.db_password_enc),
    database: site.database_name,
  })
}
if (!onlySite) {
  targets.push({
    name: `control-${process.env.DB_NAME}`,
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  })
}

console.log(`backing up ${targets.length} database(s) + uploads -> ${runDir}${dryRun ? ' (dry run)' : ''}`)
if (dryRun) {
  for (const t of targets) console.log(`  would dump ${t.name} from ${t.host}:${t.port}`)
  process.exit(0)
}

await mkdir(runDir, { recursive: true })
const results = []

for (const target of targets) {
  const outFile = path.join(runDir, `${target.name}.sql.gz`)
  const result = await dumpDatabase(target, outFile)
  results.push({ name: target.name, ...result })
  console.log(`  ${result.ok ? 'ok  ' : 'FAIL'} ${target.name}${result.ok ? ` (${result.bytes} bytes)` : ` — ${result.error}`}`)
}

// Uploads, tar first and a plain copy as the fallback.
const uploadsExist = await stat(UPLOADS_DIR).catch(() => null)
if (uploadsExist?.isDirectory()) {
  const tarred = await archiveUploads(path.join(runDir, 'uploads.tar.gz'))
  if (tarred.ok) {
    results.push({ name: 'uploads', ...tarred })
    console.log(`  ok   uploads (${tarred.bytes} bytes)`)
  } else {
    try {
      await cp(UPLOADS_DIR, path.join(runDir, 'uploads'), { recursive: true })
      results.push({ name: 'uploads', ok: true, bytes: null, note: 'copied, tar unavailable' })
      console.log('  ok   uploads (copied — tar unavailable)')
    } catch (e) {
      results.push({ name: 'uploads', ok: false, error: e.message })
      console.log(`  FAIL uploads — ${e.message}`)
    }
  }
} else {
  results.push({ name: 'uploads', ok: true, bytes: 0, note: 'no uploads directory yet' })
}

// Retention — only after a run, and never the folder just written.
const removed = []
const cutoff = Date.now() - RETENTION_DAYS * 86_400_000
for (const entry of await readdir(BACKUP_DIR).catch(() => [])) {
  if (entry === stamp || entry === 'manifest.json') continue
  const full = path.join(BACKUP_DIR, entry)
  const info = await stat(full).catch(() => null)
  if (info?.isDirectory() && info.mtimeMs < cutoff) {
    await rm(full, { recursive: true, force: true })
    removed.push(entry)
  }
}

const failed = results.filter((r) => !r.ok)
const manifest = {
  startedAt: started.toISOString(),
  finishedAt: new Date().toISOString(),
  folder: stamp,
  ok: failed.length === 0,
  targets: results,
  removed,
  retentionDays: RETENTION_DAYS,
}
await writeFile(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
await writeFile(path.join(BACKUP_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2))

console.log(
  failed.length === 0
    ? `done — ${results.length} target(s), ${removed.length} old folder(s) removed`
    : `FINISHED WITH ${failed.length} FAILURE(S) — see ${path.join(runDir, 'manifest.json')}`,
)
process.exit(failed.length === 0 ? 0 : 1)
