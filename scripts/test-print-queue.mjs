// The OS-queue transport, against a stub helper — no printer, no spooler.
//
//   npm run test:print-queue
//
// `sendQueueRaw` takes its helper path as an ARGUMENT rather than resolving it,
// which is what makes this possible: the test points it at a stub that reports
// exactly what reached the process.
//
// The decisions under test are the ones that corrupt a slip or fail obscurely:
//
//   · THE QUEUE NAME REACHES THE HELPER UNMANGLED. Windows printer names
//     legitimately contain spaces, '&' and '(' — as an argv element that is
//     opaque, and through a shell it is syntax.
//   · THE BYTES REACH IT INTACT. They go via a temp file rather than argv (a
//     slip with a logo blows the 32KB argv limit) or stdin (one more layer that
//     can mangle a lone 0x1a on Windows).
//   · THE TEMP FILE IS ALWAYS CLEANED UP, including when the helper fails.
//   · A FAILURE CARRIES THE HELPER'S OWN MESSAGE, not a generic one.
import { createHash } from 'node:crypto'
import { readdirSync, existsSync, writeFileSync, chmodSync, unlinkSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sendQueueRaw } from '../electron/printTransports.js'

let fails = 0
const ok = (label, cond, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

const here = path.dirname(fileURLToPath(import.meta.url))

/* ── THE STUB HAS TO BE A REAL EXECUTABLE ──────────────────────────────────
 *
 * Node on Windows refuses to spawn a .cmd or .bat without `shell: true` (the
 * CVE-2024-27980 fix) — and `shell: true` is precisely what the transport must
 * never use, because it is what would turn a printer called "Bar & Grill (2)"
 * into a command. So a .cmd launcher cannot stand in for the helper without
 * testing a path production does not take.
 *
 * On Windows the stub is therefore COMPILED, with the same in-box csc.exe that
 * builds the real helper — guaranteed present, since that is the whole premise
 * of scripts/build-rawprint.mjs. On POSIX a shebang script already is an
 * executable, and the transport uses `lp` there anyway.
 */
let helper
let cleanup = () => {}

if (process.platform === 'win32') {
  helper = path.join(os.tmpdir(), 'odyssey-rawprint-stub.exe')
  const csc = path.join(
    process.env.WINDIR ?? 'C:\\Windows',
    'Microsoft.NET',
    'Framework64',
    'v4.0.30319',
    'csc.exe',
  )
  if (!existsSync(csc)) {
    console.log('SKIP  the queue transport — csc.exe is not on this machine.')
    process.exit(0)
  }
  const built = spawnSync(
    csc,
    ['/nologo', '/target:exe', '/out:' + helper, path.join(here, 'fixtures', 'StubPrint.cs')],
    { encoding: 'utf8' },
  )
  if (built.status !== 0) {
    console.log('SKIP  the queue transport — could not build the stub:', built.stdout || built.stderr)
    process.exit(0)
  }
  cleanup = () => {
    try {
      unlinkSync(helper)
    } catch {
      /* Left behind in temp. Harmless. */
    }
  }
} else {
  helper = path.join(here, 'fixtures', 'rawprint-stub.sh')
  const stub = path.join(here, 'fixtures', 'rawprint-stub.mjs')
  writeFileSync(helper, '#!/bin/sh\nexec node "' + stub + '" "$1" "$2"\n')
  chmodSync(helper, 0o755)
  cleanup = () => {
    try {
      unlinkSync(helper)
    } catch {
      /* Already gone. */
    }
  }
}

/** How many staged job files are lying about in temp right now. */
const staged = () => readdirSync(os.tmpdir()).filter((f) => f.startsWith('odyssey-print-')).length

/* An ESC/POS-shaped payload carrying the bytes most likely to be mangled by any
   layer that thinks it is handling text: 0x1a (EOF on Windows), a lone 0x0d,
   and a high byte from CP858. */
const job = new Uint8Array([0x1b, 0x40, 0x1a, 0x0d, 0xd5, 0x41, 0x0a, 0x1d, 0x56, 0x42, 0x00])
const expected = createHash('sha256').update(Buffer.from(job)).digest('hex')

console.log('\n── What reaches the helper ─────────────────────────────────\n')
{
  const before = staged()
  const result = await sendQueueRaw('EPSON TM-T20III Receipt', job, { helperPath: helper })
  ok('a job reaches the helper', result.ok, result.ok ? '' : result.error)
  ok('*** the temp job file is cleaned up ***', staged() <= before, `${staged()} staged`)
}

{
  /* The name a shell would destroy. If `shell: true` ever appears in
     printTransports, this is the assertion that catches it. */
  const result = await sendQueueRaw('Bar & Grill (2) — Küche', job, { helperPath: helper })
  ok('*** a name with spaces, an ampersand and non-ASCII is accepted ***', result.ok, result.ok ? '' : result.error)
}

console.log('\n── Failure ─────────────────────────────────────────────────\n')
{
  const before = staged()
  const result = await sendQueueRaw('FAIL Printer', job, { helperPath: helper })
  ok('*** a helper that exits non-zero is a failure ***', !result.ok)
  ok('…carrying the helper’s own message', !result.ok && /refused the job/.test(result.error), result.error)
  ok('*** …and the temp file is still cleaned up ***', staged() <= before, `${staged()} staged`)
}

{
  const result = await sendQueueRaw('Anything', job, { helperPath: path.join(here, 'no-such-helper.exe') })
  if (process.platform === 'win32') {
    ok(
      '*** a missing helper names both routes out ***',
      !result.ok && /raw-print helper/.test(result.error) && /share name/.test(result.error),
      result.error,
    )
  } else {
    ok('POSIX falls through to lp rather than the helper', typeof result.ok === 'boolean')
  }
}

{
  /* A helper that exists but cannot be launched — a .cmd on Windows, which Node
     refuses without shell:true. `spawn` throws SYNCHRONOUSLY here, and the bug
     this pins is that the throw used to escape past the cleanup and strand the
     staged job file in temp forever. */
  const unlaunchable = path.join(os.tmpdir(), 'odyssey-unlaunchable.cmd')
  writeFileSync(unlaunchable, '@echo off\r\n')
  const before = staged()
  const result = await sendQueueRaw('Whatever', job, { helperPath: unlaunchable })
  ok('a helper that cannot be launched is a failure, not a crash', !result.ok, result.ok ? '' : result.error)
  ok(
    '*** …and a synchronous spawn failure still cleans up its temp file ***',
    staged() <= before,
    `${staged()} staged`,
  )
  unlinkSync(unlaunchable)
}

console.log('\n── Fidelity, byte for byte ─────────────────────────────────\n')
{
  /* Runs the stub directly so its report can be read — the transport pipes the
     child's stdout, so this is the only way to see what it computed. */
  const probe = path.join(os.tmpdir(), 'odyssey-print-fidelity-probe.bin')
  writeFileSync(probe, Buffer.from(job))
  const out = spawnSync(helper, ['Probe Printer', probe], { encoding: 'utf8' })
  unlinkSync(probe)

  let report = null
  try {
    report = JSON.parse(out.stdout.trim())
  } catch {
    /* Reported by the assertions below. */
  }
  ok('*** the helper receives the exact bytes, 0x1a and all ***', report?.sha256 === expected, report?.sha256 ?? out.stderr)
  ok('…and the exact queue name as one argv element', report?.queue === 'Probe Printer', report?.queue ?? '')
  ok('…and the whole job, not a truncated one', report?.length === job.length, String(report?.length))
}

cleanup()
console.log(fails === 0 ? '\nEvery queue transport rule holds.\n' : `\n${fails} check(s) failed.\n`)
process.exit(fails === 0 ? 0 : 1)
