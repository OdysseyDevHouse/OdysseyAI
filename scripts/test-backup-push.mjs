/**
 * The nightly backup is encrypted on the shop's machine before it leaves, so
 * we store ciphertext we cannot read. That is only worth doing if it decrypts
 * again — a backup that cannot be restored is worse than no backup, because it
 * is the one somebody reaches for on the day it matters.
 *
 * Exercises the real script end to end via --dry-run, then decrypts what it
 * produced with an independent implementation.
 *
 *   node scripts/test-backup-push.mjs
 */
import { execFile } from 'node:child_process'
import { mkdtemp, writeFile, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { createDecipheriv, randomBytes, createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

let failures = 0
function check(name, ok, detail = '') {
  if (ok) console.log(`  PASS  ${name}`)
  else {
    failures++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/** The reader's half: [iv 12][ciphertext][tag 16]. */
function decrypt(buf, key) {
  const iv = buf.subarray(0, 12)
  const tag = buf.subarray(buf.length - 16)
  const ct = buf.subarray(12, buf.length - 16)
  const d = createDecipheriv('aes-256-gcm', key, iv)
  d.setAuthTag(tag)
  return Buffer.concat([d.update(ct), d.final()])
}

const script = path.resolve('scripts/backup-push.mjs')
const workDir = await mkdtemp(path.join(tmpdir(), 'odyssey-bp-'))
const backupDir = path.join(workDir, 'backups')
const runDir = path.join(backupDir, '2026-08-17T0200')
await mkdir(runDir, { recursive: true })

/* Something big enough to cross a stream chunk boundary, so the test exercises
   the streaming path rather than a single update() call. */
const dumpBody = randomBytes(300_000)
await writeFile(path.join(runDir, 'site-7.sql.gz'), dumpBody)
await writeFile(path.join(runDir, 'uploads.tar.gz'), Buffer.from('pretend tarball'))
await writeFile(
  path.join(runDir, 'manifest.json'),
  JSON.stringify({ ok: true, startedAt: 'a', finishedAt: 'b', targets: [] }),
)

const key = randomBytes(32)
const env = {
  ...process.env,
  BACKUP_DIR: backupDir,
  BACKUP_ENCRYPTION_KEY: key.toString('base64'),
  ODYSSEY_SITE_ID: '7',
  ODYSSEY_DEVICE_SERIAL: 'TILL-A',
}

console.log('\nA dry run encrypts the latest backup')
const { stdout } = await run('node', [script, '--dry-run'], { env, maxBuffer: 10 * 1024 * 1024 })
const staged = stdout.match(/encrypted into (.+)/)?.[1]?.trim()
check('it reports where it staged the files', Boolean(staged), stdout.slice(0, 200))

const files = await readdir(staged)
check('both backup files were encrypted', files.includes('site-7.sql.gz.enc') && files.includes('uploads.tar.gz.enc'))
check('an envelope was written', files.includes('envelope.json'))
check('the manifest itself is not uploaded as a payload', !files.includes('manifest.json.enc'))

console.log('\nThe ciphertext decrypts to exactly what was backed up')
const encrypted = await readFile(path.join(staged, 'site-7.sql.gz.enc'))
const plain = decrypt(encrypted, key)
check('the dump round-trips byte for byte', plain.equals(dumpBody))
check('the ciphertext is not the plaintext', !encrypted.subarray(12, 12 + 32).equals(dumpBody.subarray(0, 32)))
check('it grew by exactly iv + tag', encrypted.length === dumpBody.length + 28)

const small = decrypt(await readFile(path.join(staged, 'uploads.tar.gz.enc')), key)
check('a small file round-trips too', small.toString() === 'pretend tarball')

console.log('\nThe envelope describes what was sent')
const envelope = JSON.parse(await readFile(path.join(staged, 'envelope.json'), 'utf8'))
check('it names the site', envelope.siteId === 7)
check('it names the machine', envelope.deviceSerial === 'TILL-A')
check('it names the folder', envelope.folder === '2026-08-17T0200')
check('it records the algorithm', envelope.algorithm === 'aes-256-gcm')
check('it lists both files', envelope.files.length === 2)

const entry = envelope.files.find((f) => f.name === 'site-7.sql.gz')
const trueHash = createHash('sha256').update(dumpBody).digest('hex')
check('the recorded hash is of the PLAINTEXT, so a restore can be proved', entry.sha256 === trueHash)
check('the recorded size is of the ciphertext', entry.bytes === encrypted.length)

console.log('\nA wrong key cannot read it')
let refused = false
try {
  decrypt(encrypted, randomBytes(32))
} catch {
  refused = true
}
check('decryption with another key fails', refused)

console.log('\nTampering is detected, not silently passed on')
{
  const altered = Buffer.from(encrypted)
  altered[40] ^= 0xff
  let caught = false
  try {
    decrypt(altered, key)
  } catch {
    caught = true
  }
  check('a flipped byte fails authentication', caught)

  const truncated = encrypted.subarray(0, encrypted.length - 4)
  let caughtTrunc = false
  try {
    decrypt(truncated, key)
  } catch {
    caughtTrunc = true
  }
  check('a truncated upload fails authentication', caughtTrunc)
}

console.log('\nEach run uses a fresh IV')
{
  const { stdout: second } = await run('node', [script, '--dry-run'], { env, maxBuffer: 10 * 1024 * 1024 })
  const staged2 = second.match(/encrypted into (.+)/)?.[1]?.trim()
  const again = await readFile(path.join(staged2, 'site-7.sql.gz.enc'))
  check('the same file encrypts differently each time', !again.subarray(0, 12).equals(encrypted.subarray(0, 12)))
  check('and both still decrypt', decrypt(again, key).equals(dumpBody))
  await rm(staged2, { recursive: true, force: true })
}

console.log('\nIt refuses to send what it should not')
{
  const noKey = { ...env }
  delete noKey.BACKUP_ENCRYPTION_KEY
  let rejected = false
  try {
    await run('node', [script, '--dry-run'], { env: noKey })
  } catch (e) {
    rejected = /refusing to upload in the clear/.test(String(e.stderr))
  }
  check('no key means no upload, in the clear or otherwise', rejected)

  let shortRejected = false
  try {
    await run('node', [script, '--dry-run'], {
      env: { ...env, BACKUP_ENCRYPTION_KEY: randomBytes(16).toString('base64') },
    })
  } catch (e) {
    shortRejected = /must be 32 bytes/.test(String(e.stderr))
  }
  check('a short key is refused rather than stretched', shortRejected)

  // A backup that reported failures must never be uploaded as if it were good.
  const badRun = path.join(backupDir, '2026-08-18T0200')
  await mkdir(badRun, { recursive: true })
  await writeFile(path.join(badRun, 'site-7.sql.gz'), Buffer.from('partial'))
  await writeFile(path.join(badRun, 'manifest.json'), JSON.stringify({ ok: false, targets: [] }))
  let badRejected = false
  try {
    await run('node', [script, '--dry-run'], { env })
  } catch (e) {
    badRejected = /reported failures/.test(String(e.stderr))
  }
  check('a failed backup is not uploaded', badRejected)
}

await rm(staged, { recursive: true, force: true })
await rm(workDir, { recursive: true, force: true })

console.log(failures === 0 ? '\nBackup push holds.\n' : `\n${failures} FAILED\n`)
process.exit(failures === 0 ? 0 : 1)
