// Put a cut release where the shops can reach it.
//
// ── THE ORDER OF THESE UPLOADS IS THE WHOLE POINT ───────────────────────────
//
// latest.yml is a promise: it names an installer, its size and its sha512, and
// every shop that reads it immediately tries to download that file. Upload it
// first and there is a window — minutes, on a 130MB installer over an ADSL
// line — in which a thousand machines are told about a release that is not
// there yet. They do not fail quietly either: electron-updater retries, and a
// checksum mismatch against a half-uploaded object is indistinguishable to it
// from a tampered download.
//
// So the manifest goes LAST, after the bytes it describes are complete. That
// single rule is what makes publishing safe to do in the middle of a trading
// day, which matters because the alternative is publishing at night and
// finding out at nine the next morning.
//
// ── AND WHY IT VERIFIES BEFORE IT UPLOADS ANYTHING ─────────────────────────
//
// electron-builder writes the SAFE artifact name into latest.yml — spaces
// collapsed to dashes — while writing the file to disk under the name in
// `artifactName`. When those disagree, which they did for every build cut
// before this script existed, the manifest points at a filename nothing ever
// created and the failure appears only on a customer's machine, as a 404 no
// human sees. Checking that the file named in the manifest exists, is the size
// it claims and hashes to the digest it claims costs a second here and cannot
// be discovered any later than a shop's counter.
//
// ── USAGE ───────────────────────────────────────────────────────────────────
//
//   npm run publish:release                 all three, whatever is in release/
//   npm run publish:release -- backoffice   just one
//   npm run publish:release -- --dry-run    say what it would do, touch nothing
//
// Needs the AWS CLI (R2 speaks S3) and, in the environment:
//
//   R2_BUCKET     the bucket name
//   R2_ENDPOINT   https://<account-id>.r2.cloudflarestorage.com
//   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY   an R2 API token with write
//
// The bucket must be readable at the public custom domain ODYSSEY_UPDATE_URL
// names — see docs/updates.md.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ROLES = ['backoffice', 'pos', 'database']

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const force = args.includes('--force')
const wanted = args.filter((a) => !a.startsWith('--'))
const roles = wanted.length ? wanted : ROLES

for (const role of roles) {
  if (!ROLES.includes(role)) fail(`unknown build "${role}" — expected one of ${ROLES.join(', ')}`)
}

const bucket = req('R2_BUCKET')
const endpoint = req('R2_ENDPOINT')

/* The version every artifact must agree on. A mismatch means release/ holds a
   stale build from before the version was bumped, and publishing it would
   advertise a release the installer does not identify itself as — so the shop
   installs it, still reports the old version, and downloads it again forever. */
const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version

console.log(`Publishing Odyssey ${version} to ${bucket} (${endpoint})`)
if (dryRun) console.log('DRY RUN — nothing will be uploaded.\n')

let published = 0
for (const role of roles) {
  const dir = join(ROOT, 'release', role)
  if (!existsSync(join(dir, 'latest.yml'))) {
    /* Skipped rather than fatal: `npm run dist:pos` legitimately leaves the
       other two folders untouched, and refusing to publish the one build that
       was cut would be perverse. */
    console.log(`· ${role}: no release/${role}/latest.yml — skipped`)
    continue
  }
  publishRole(role, dir)
  published += 1
}

if (!published) fail('nothing to publish. Run `npm run dist` first.')
console.log(`\nDone. ${published} build(s) at ${version}.`)

function publishRole(role, dir) {
  const manifestPath = join(dir, 'latest.yml')
  const manifest = readFileSync(manifestPath, 'utf8')

  const declaredVersion = value(manifest, 'version')
  if (declaredVersion !== version) {
    fail(
      `${role}: release/${role}/latest.yml says ${declaredVersion} but package.json says ${version}. ` +
        'Rebuild after bumping the version.',
    )
  }

  /* `path:` is the file the updater will ask for. Everything below is checked
     against THAT name, never against whatever happens to be in the folder. */
  const fileName = value(manifest, 'path')
  const exe = join(dir, fileName)
  if (!existsSync(exe)) {
    fail(
      `${role}: latest.yml points at "${fileName}", which is not in release/${role}/. ` +
        'That is the artifactName/safe-name mismatch — check build-config for a product name with a space in it.',
    )
  }

  /* Checked against the `files:` entry rather than the top-level sha512, even
     though on a single-artifact manifest they are the same string. `files:` is
     what electron-updater actually downloads from; the top-level pair is the
     older shape, kept for updaters too old to read the list. Verifying the one
     that is not used would be a check that cannot fail in the way it matters. */
  const entry = fileEntry(manifest, fileName)
  if (!entry) fail(`${role}: latest.yml has no files: entry for "${fileName}".`)

  const actualSize = statSync(exe).size
  if (entry.size && actualSize !== entry.size) {
    fail(`${role}: ${fileName} is ${actualSize} bytes, latest.yml claims ${entry.size}.`)
  }

  const actualSha = createHash('sha512').update(readFileSync(exe)).digest('base64')
  if (actualSha !== entry.sha512) {
    fail(`${role}: ${fileName} does not match the sha512 in latest.yml. Rebuild.`)
  }

  const blockmap = `${exe}.blockmap`
  if (!existsSync(blockmap)) {
    /* Not fatal — updates still work, they just cost a shop the whole installer
       instead of the changed blocks. Loud, because nobody would otherwise
       notice a 130MB download that should have been a few. */
    console.warn(`  ! ${role}: no .blockmap — every shop will re-download the full installer.`)
  }

  const key = (name) => `${role}/${name}`

  /* Republishing a version under the same name is the one genuinely dangerous
     thing this script can do: shops that already downloaded it hold a digest
     for the old bytes, and a differential download is computed against a
     blockmap that no longer describes the object. Bump the version instead. */
  if (!force && !dryRun && remoteExists(key(fileName))) {
    fail(
      `${role}: ${fileName} is already published. Bump the version rather than replacing it ` +
        '(--force overrides, and will break downloads already in flight).',
    )
  }

  console.log(`\n${role} → ${bucket}/${role}/`)

  /* Version-stamped names, so they can be cached for as long as the CDN likes. */
  const immutable = 'public, max-age=31536000, immutable'
  upload(exe, key(fileName), 'application/octet-stream', immutable)
  if (existsSync(blockmap)) {
    upload(blockmap, key(`${fileName}.blockmap`), 'application/octet-stream', immutable)
  }

  /* LAST, and never cached. See the note at the top of this file: this is the
     line that makes the release visible, and it must not become visible before
     the bytes above landed — nor stay visible for an hour after the next one. */
  upload(manifestPath, key('latest.yml'), 'text/yaml', 'no-cache, no-store, must-revalidate')
}

function upload(from, key, contentType, cacheControl) {
  const target = `s3://${bucket}/${key}`
  const mb = (statSync(from).size / 1024 / 1024).toFixed(1)
  console.log(`  ${dryRun ? 'would upload' : 'uploading'} ${key} (${mb} MB)`)
  if (dryRun) return
  aws([
    's3',
    'cp',
    from,
    target,
    '--endpoint-url',
    endpoint,
    '--content-type',
    contentType,
    '--cache-control',
    cacheControl,
    '--only-show-errors',
  ])
}

function remoteExists(key) {
  const r = aws(['s3api', 'head-object', '--bucket', bucket, '--key', key, '--endpoint-url', endpoint], {
    allowFailure: true,
  })
  return r.status === 0
}

function aws(argv, { allowFailure = false } = {}) {
  /* R2 has no regions, but the AWS CLI refuses to run without one and will
     otherwise take whatever is in the caller's AWS config — which on a machine
     that also talks to real AWS is a region R2 has never heard of. `auto` is
     what Cloudflare asks for. Passed here rather than documented as a setup
     step, because a step that can be forgotten will be. */
  const quoted = [...argv, '--region', 'auto'].map((a) => (/[\s"]/.test(a) ? `"${a}"` : a))
  const r = spawnSync('aws', quoted, { stdio: allowFailure ? 'pipe' : 'inherit', shell: true })
  if (r.error && r.error.code === 'ENOENT') {
    fail('the AWS CLI is not installed. R2 speaks S3, so `aws` is what uploads here — see docs/updates.md.')
  }
  if (!allowFailure && r.status !== 0) fail(`aws ${argv[0]} ${argv[1]} failed (exit ${r.status}).`)
  return r
}

/**
 * One scalar out of the flat top level of latest.yml.
 *
 * Not a YAML parser and does not need to be: the file is generated, four keys
 * deep and never hand-edited. Anchored to the line start so the indented copies
 * of `sha512` and `size` nested under `files:` cannot be mistaken for the
 * top-level ones — which matters, because on a multi-file manifest they would
 * describe a different artifact entirely.
 */
function value(yaml, key) {
  const m = yaml.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))
  if (!m) fail(`latest.yml has no "${key}"`)
  return m[1].trim().replace(/^['"]|['"]$/g, '')
}

/**
 * The `files:` entry for one artifact.
 *
 * Hand-parsed for the same reason as value() above — the file is generated and
 * two levels deep — but as its own function because the nesting is exactly what
 * makes a line-anchored regex the wrong tool: `size:` and `sha512:` appear ONLY
 * inside this list, indented, and reading them as top-level keys finds nothing.
 */
function fileEntry(yaml, name) {
  const after = yaml.split(/^files:[ 	]*$/m)[1]
  if (after == null) return null
  /* Everything up to the next key at column zero. */
  const block = after.split(/^\S/m)[0]
  for (const chunk of block.split(/^[ 	]*-[ 	]+/m).slice(1)) {
    const url = /url:[ 	]*(.+)/.exec(chunk)?.[1].trim()
    if (url !== name) continue
    return {
      sha512: /sha512:[ 	]*(.+)/.exec(chunk)?.[1].trim(),
      size: Number(/size:[ 	]*(\d+)/.exec(chunk)?.[1]),
    }
  }
  return null
}

function req(name) {
  const v = process.env[name]
  if (!v) fail(`${name} is not set. See docs/updates.md.`)
  return v
}

function fail(message) {
  console.error(`publish-release: ${message}`)
  process.exit(1)
}
