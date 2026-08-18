// Runs every test suite and reports ALL of them.
//
//   npm test           every suite, keep going after a failure
//   npm test -- --bail stop at the first one that fails
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────
//
// `npm test` used to be forty-five `npm run test:x` calls chained with `&&`,
// which stops at the first failure. A suite failing at position ten meant the
// other thirty-five never ran and nobody knew whether they would have passed —
// so one piece of stale test litter could hide a real regression for as long as
// it took somebody to notice.
//
// Worse, it hid HOW MANY things were wrong. "One suite failed" and "eleven
// suites failed" are different mornings, and the chained form reported both as
// the same red line.
//
// ── AND WHY IT CHECKS THE OUTPUT, NOT JUST THE EXIT CODE ───────────────────
//
// Several suites in this repo print `**FAIL**` and still exit 0. A runner that
// trusted the exit code would call those green. So a suite counts as failed if
// it exits non-zero OR prints a failure line — and a suite that CRASHES prints
// no FAIL at all, which is why the exit code still matters too.
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

const bail = process.argv.includes('--bail')
const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7)

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

/* The suite list comes from package.json itself — every `test:*` script except
   the ones that are not suites. Derived rather than hand-listed so a new suite
   is picked up by adding its script, which is the only place anybody thinks to
   add it. */
const SKIP = new Set([
  'test',
  /*
   * Needs `npm run dev` on :4100 and a real browser, so it fails on a machine
   * that simply has not started the server — a red line that says nothing about
   * the code, which is how everyone learns to ignore the output.
   *
   * Its own docblock asks to be left out of the chain for exactly this reason,
   * and the first version of this runner swept it in anyway by taking every
   * `test:*` script. Run it alongside when a change touches the builder:
   *
   *   npm run test:builder-ui
   */
  'test:builder-ui',
  /*
   * Needs a running server AND `ALLOW_UNVERIFIED_ITN=1`, because the PayFast
   * post-back is the one verification step a test cannot simulate — PayFast
   * has never seen the payment and correctly refuses to vouch for it.
   *
   * In the chain it would fail on any machine that has not started a server
   * that way, which is a red line saying nothing about the code. The state
   * machine underneath it IS covered by `test:billing-subscription`, which
   * needs nothing but the database. Run this one when a change touches the
   * callback:
   *
   *   ALLOW_UNVERIFIED_ITN=1 npm run dev
   *   npm run test:billing-itn-route
   */
  'test:billing-itn-route',
  /*
   * CLAIMS AND RELEASES REAL TILLS on two real sites, to prove one machine may
   * be a till in several shops. It snapshots every row it touches and writes
   * them back in a `finally`, but it is still a mutation against live shop data
   * and it needs two active sites to mean anything at all.
   *
   * Out of the chain for both reasons: a machine with one site would fail it
   * for saying nothing about the code, and a suite that edits terminals is not
   * something to run by reflex. Run it when a change touches device claims or
   * the unlock path:
   *
   *   npm run test:multi-store-device
   */
  'test:multi-store-device',
])
const suites = Object.keys(pkg.scripts)
  .filter((k) => k.startsWith('test:') && !SKIP.has(k))
  .filter((k) => (only ? k.includes(only) : true))
  .sort()

const run = (script) =>
  new Promise((resolve) => {
    /* The command is built into the string rather than passed as args, because
       `shell: true` with an args array warns about unescaped concatenation —
       and every one of these is a fixed script name from package.json, not
       anything a caller supplies. */
    const child = spawn(`npm run ${script}`, {
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('close', (code) => resolve({ code, out }))
  })

const results = []
const started = Date.now()

for (const script of suites) {
  process.stdout.write(`  ${script.padEnd(34)}`)
  const { code, out } = await run(script)

  /* Both signals. A suite can print failures and still exit 0, and a suite that
     throws prints nothing but exits non-zero. */
  const printed = (out.match(/\*\*FAIL\*\*/g) ?? []).length
  const failed = code !== 0 || printed > 0

  results.push({ script, code, printed, failed, out })
  console.log(failed ? `FAIL  (${printed} assertion${printed === 1 ? '' : 's'}, exit ${code})` : 'ok')

  if (failed && bail) {
    console.log('\n--- stopped at the first failure (--bail) ---')
    break
  }
}

const failures = results.filter((r) => r.failed)
const seconds = Math.round((Date.now() - started) / 1000)

console.log(
  `\n${results.length - failures.length}/${results.length} suites passed in ${seconds}s`,
)

if (failures.length) {
  console.log('\n── what failed ──')
  for (const f of failures) {
    console.log(`\n### ${f.script}`)
    /* The failing lines only. A whole suite's output per failure buries the
       thing somebody opened this log to find. */
    const lines = f.out.split('\n').filter((l) => /\*\*FAIL\*\*|Error|FAILURE/.test(l))
    console.log(lines.length ? lines.slice(0, 6).join('\n') : f.out.trim().split('\n').slice(-6).join('\n'))
  }
  process.exit(1)
}
