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
//   npm run publish:release -- --no-promote leave beta.yml alone on a stable cut
//
// ── STABLE AND BETA, IN ONE FOLDER ──────────────────────────────────────────
//
// electron-updater asks for `<channel>.yml`, and `latest` is simply the default
// channel name — so a beta release is beta.yml sitting beside latest.yml, each
// naming its own installer. Which one a machine follows is set per device in
// Control Panel v2 → Releases.
//
// This script does not choose. electron-builder writes the manifest name from
// the version's prerelease tag (0.2.0-beta.1 -> beta.yml, 0.2.0 -> latest.yml)
// and this reads the same version and uploads the file under the same name. You
// pick a channel by naming the version, which means you cannot publish to beta
// by accident and cannot publish a beta to stable at all.
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

const AWS_FALLBACKS = [
  'C:\\Program Files\\Amazon\\AWSCLIV2\\aws.exe',
  'C:\\Program Files (x86)\\Amazon\\AWSCLIV2\\aws.exe',
]

let awsCommand = null

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const force = args.includes('--force')
const noPromote = args.includes('--no-promote')
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

/**
 * Which channel a version publishes to.
 *
 * A DELIBERATE COPY of app-builder-lib's appInfo.channel — the prerelease tag,
 * or 'latest' when there is none. It has to be a copy rather than a shared
 * constant because the two run in different processes at different times, and
 * this side's job is to CHECK the other rather than to agree with it by
 * construction: if electron-builder ever stops naming the file this way, the
 * manifest is simply not where this looks and the build is skipped with a
 * sentence — instead of a stable installer being uploaded as beta.yml.
 *
 * `detectUpdateChannel` defaults to true and nothing in build-config sets
 * `publish.channel`, so the prerelease tag is the whole rule today.
 */
function channelFor(v) {
  const tag = /^\d+\.\d+\.\d+-([0-9A-Za-z]+)/.exec(String(v))
  return tag ? tag[1].toLowerCase() : 'latest'
}

const channel = channelFor(version)
const manifestName = `${channel}.yml`

console.log(`Publishing Odyssey ${version} to ${bucket} (${endpoint})`)
console.log(
  channel === 'latest'
    ? `Channel: stable (${manifestName}) — every machine not assigned to a test channel.`
    : `Channel: ${channel} (${manifestName}) — ONLY devices assigned to it in Control Panel → Releases.`,
)
if (dryRun) console.log('DRY RUN — nothing will be uploaded.\n')

let published = 0
for (const role of roles) {
  const dir = join(ROOT, 'release', role)
  if (!existsSync(join(dir, manifestName))) {
    /* Skipped rather than fatal: `npm run dist:pos` legitimately leaves the
       other two folders untouched, and refusing to publish the one build that
       was cut would be perverse.
       It is ALSO what catches a release/ folder holding the PREVIOUS channel's
       build — a stable latest.yml still sitting there when package.json has
       moved on to a beta. Looking for the file this version implies means the
       stale one is invisible here rather than published as if it were current. */
    console.log(`· ${role}: no release/${role}/${manifestName} — skipped`)
    continue
  }
  publishRole(role, dir)
  published += 1
}

if (!published) fail(`nothing to publish at ${version}. Run \`npm run dist\` first.`)
console.log(`\nDone. ${published} build(s) at ${version} on ${channel === 'latest' ? 'stable' : channel}.`)

function publishRole(role, dir) {
  const manifestPath = join(dir, manifestName)
  const manifest = readFileSync(manifestPath, 'utf8')

  const declaredVersion = value(manifest, 'version')
  if (declaredVersion !== version) {
    fail(
      `${role}: release/${role}/${manifestName} says ${declaredVersion} but package.json says ${version}. ` +
        'Rebuild after bumping the version.',
    )
  }

  /* `path:` is the file the updater will ask for. Everything below is checked
     against THAT name, never against whatever happens to be in the folder. */
  const fileName = value(manifest, 'path')
  const exe = join(dir, fileName)
  if (!existsSync(exe)) {
    fail(
      `${role}: ${manifestName} points at "${fileName}", which is not in release/${role}/. ` +
        'That is the artifactName/safe-name mismatch — check build-config for a product name with a space in it.',
    )
  }

  /* Checked against the `files:` entry rather than the top-level sha512, even
     though on a single-artifact manifest they are the same string. `files:` is
     what electron-updater actually downloads from; the top-level pair is the
     older shape, kept for updaters too old to read the list. Verifying the one
     that is not used would be a check that cannot fail in the way it matters. */
  const entry = fileEntry(manifest, fileName)
  if (!entry) fail(`${role}: ${manifestName} has no files: entry for "${fileName}".`)

  const actualSize = statSync(exe).size
  if (entry.size && actualSize !== entry.size) {
    fail(`${role}: ${fileName} is ${actualSize} bytes, ${manifestName} claims ${entry.size}.`)
  }

  const actualSha = createHash('sha512').update(readFileSync(exe)).digest('base64')
  if (actualSha !== entry.sha512) {
    fail(`${role}: ${fileName} does not match the sha512 in ${manifestName}. Rebuild.`)
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
  upload(manifestPath, key(manifestName), 'text/yaml', 'no-cache, no-store, must-revalidate')

  promoteToBeta(role, manifestPath, key)
}

/**
 * A stable release also becomes the beta channel's newest build.
 *
 * ── WITHOUT THIS, BETA TESTERS ARE STRANDED ─────────────────────────────────
 *
 * A machine on beta compares its own version against beta.yml and nothing else.
 * Publish 0.2.0-beta.1 to beta, then ship 0.2.0 to stable, and beta.yml still
 * says 0.2.0-beta.1 — which is the version that machine is already running. It
 * therefore sees no update, and keeps seeing no update, for as long as it stays
 * on the channel. Every shop moves on to 0.2.0 and the tester silently does
 * not.
 *
 * The symptom is the worst kind: nothing is broken, nothing is logged, and the
 * one machine you deliberately gave to a customer to test on is the one running
 * the oldest software on the estate.
 *
 * So stable is copied onto beta.yml as well. It is the same bytes and the same
 * installer — only a second pointer to it — and it means beta always names the
 * newest build in existence, which is what the word promises. A tester then
 * rolls onto the stable release automatically (0.2.0 > 0.2.0-beta.1 in semver,
 * so it is an UPGRADE and needs no downgrade permission) and waits there for
 * the next beta.
 *
 * ── ONLY EVER FORWARD ───────────────────────────────────────────────────────
 *
 * Guarded on the version already published to beta, because the two channels do
 * not have to move in step: 0.3.0-beta.1 can be out with testers while 0.2.1 is
 * being shipped to everybody as a fix. Overwriting beta.yml with 0.2.1 there
 * would be a downgrade for those machines — refused by the app (allowDowngrade
 * stays off, see electron/updater.js) but wrong on the shelf, and the next
 * person to read the bucket would have to work out which of the two was really
 * the newer. So it is skipped, loudly.
 *
 * `--no-promote` opts out for the case this cannot know about: a stable release
 * that testers must NOT receive because the beta they are on is testing
 * something the release deliberately leaves out.
 */
function promoteToBeta(role, manifestPath, key) {
  if (channel !== 'latest' || noPromote) return

  const current = remoteText(key('beta.yml'))
  const currentVersion = current ? tryValue(current, 'version') : null

  if (currentVersion && !isNewer(version, currentVersion)) {
    console.log(
      `  · beta.yml left at ${currentVersion} — newer than this release, so testers stay ahead.`,
    )
    return
  }

  /* The same file, under a second name. Not a rebuild and not a re-upload of
     the installer: both channels point at the one set of bytes already in the
     bucket, so this costs a 400-byte PUT. */
  console.log(`  ${dryRun ? 'would promote' : 'promoting'} ${version} to beta.yml${currentVersion ? ` (was ${currentVersion})` : ''}`)
  upload(manifestPath, key('beta.yml'), 'text/yaml', 'no-cache, no-store, must-revalidate')
}

/**
 * Is `a` a later release than `b`?
 *
 * Enough semver for the one comparison this script makes, and no more: numeric
 * major/minor/patch, then the rule that decides everything here — a release
 * with NO prerelease tag outranks the same numbers with one, so 0.2.0 beats
 * 0.2.0-beta.9. Prerelease tags of the same version are compared as strings,
 * which orders beta.2 after beta.1 and is the only case that ever arises.
 *
 * Not `semver` from npm: this script is run from a checkout that may not have
 * installed anything, and a release tool that cannot run without node_modules
 * is one more thing between a fix and the shops.
 */
function isNewer(a, b) {
  const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(String(v).trim())
    if (!m) return null
    return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null }
  }
  const x = parse(a)
  const y = parse(b)
  /* An unparseable version on either side means "do not touch it" — the caller
     treats false as "leave beta.yml alone", which is the safe direction. */
  if (!x || !y) return false
  for (let i = 0; i < 3; i += 1) {
    if (x.nums[i] !== y.nums[i]) return x.nums[i] > y.nums[i]
  }
  if (x.pre === y.pre) return false
  if (x.pre === null) return true
  if (y.pre === null) return false
  return x.pre > y.pre
}

/**
 * One small object's contents, or null when it is not there.
 *
 * `s3 cp <key> -` writes to stdout. Failure is expected and ordinary — the
 * first stable release ever published finds no beta.yml — so it is swallowed
 * rather than reported.
 */
function remoteText(key) {
  const r = aws(['s3', 'cp', `s3://${bucket}/${key}`, '-', '--endpoint-url', endpoint], {
    allowFailure: true,
  })
  if (r.status !== 0) return null
  return String(r.stdout || '')
}

/** value(), but null instead of fatal when the key is absent. */
function tryValue(yaml, key) {
  const m = yaml.match(new RegExp(`^${key}:\s*(.+)$`, 'm'))
  return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : null
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

/**
 * How to invoke the AWS CLI on this machine.
 *
 * ── PATH IS NOT ENOUGH, AND THE REASON IS ANNOYING ──────────────────────────
 *
 * Windows hands a process its environment when it STARTS. Install the CLI and
 * every terminal, editor and shell already open keeps the PATH it was born
 * with — so `aws` is installed, on the machine PATH, and still "not recognized
 * as an internal or external command" in the window you are typing in. The fix
 * is to open a new terminal, which is unguessable from the error and has to be
 * rediscovered by whoever hits it next.
 *
 * It bites exactly once per machine, on the first release after setup, which is
 * the worst possible moment: the first time anybody publishes is the time they
 * are least sure whether the thing is broken or they are.
 *
 * So the PATH is tried first — right on macOS, Linux, and any shell opened
 * after the install — and the default Windows location is checked before
 * giving up.
 */
function awsBin() {
  if (awsCommand) return awsCommand

  /* `--version` rather than a lighter probe because there is no lighter probe:
     the question is whether the shell can RESOLVE the name, and only running it
     answers that. Once per publish, and it costs a fraction of a second against
     an upload measured in minutes. */
  const onPath = spawnSync('aws', ['--version'], { stdio: 'ignore', shell: true })
  if (!onPath.error && onPath.status === 0) {
    awsCommand = 'aws'
    return awsCommand
  }

  for (const candidate of AWS_FALLBACKS) {
    if (!existsSync(candidate)) continue
    awsCommand = candidate
    /* Said out loud. The publish works either way, but a machine relying on the
       fallback has a stale environment somewhere, and a person who knows that
       can open a new terminal and stop paying for it. */
    console.log(`  (using ${candidate} — 'aws' is not on this shell's PATH)`)
    return awsCommand
  }

  fail(
    'the AWS CLI is not installed, or this shell cannot see it. R2 speaks S3, so `aws` is what ' +
      'uploads here — `winget install Amazon.AWSCLI`, then open a NEW terminal, because an ' +
      'already-running one keeps the PATH it started with. See docs/updates.md.',
  )
  return null
}

function aws(argv, { allowFailure = false } = {}) {
  /* R2 has no regions, but the AWS CLI refuses to run without one and will
     otherwise take whatever is in the caller's AWS config — which on a machine
     that also talks to real AWS is a region R2 has never heard of. `auto` is
     what Cloudflare asks for. Passed here rather than documented as a setup
     step, because a step that can be forgotten will be. */
  const quoted = [...argv, '--region', 'auto'].map((a) => (/[\s"]/.test(a) ? `"${a}"` : a))
  const bin = awsBin()
  /* shell:true concatenates rather than escaping, so a resolved path with a
     space in it — which "C:\Program Files\…" always has — has to be quoted
     here, or cmd runs "C:\Program" and reports something unrelated. */
  const command = /\s/.test(bin) ? `"${bin}"` : bin
  const r = spawnSync(command, quoted, { stdio: allowFailure ? 'pipe' : 'inherit', shell: true })
  if (r.error && r.error.code === 'ENOENT') {
    fail(`the AWS CLI could not be run (${bin}). See docs/updates.md.`)
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
