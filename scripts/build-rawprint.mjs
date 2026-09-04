// Builds build/rawprint/odyssey-rawprint.exe from RawPrint.cs.
//
//   npm run build:rawprint
//
// ── WHY THE IN-BOX COMPILER ─────────────────────────────────────────────────
//
// csc.exe ships with the .NET Framework, which is a Windows COMPONENT — it is on
// every Windows 10 and 11 machine, including a fresh one. So this needs no SDK,
// no MSBuild, no toolchain install and no CI step. The alternative (dotnet
// build) would make a ~10KB helper depend on a 200MB SDK.
//
// ── AND WHY THE OUTPUT IS COMMITTED ─────────────────────────────────────────
//
// Deliberately NOT wired into `npm run dist`. A build that silently regenerates
// a binary is a build whose output nobody reviewed, and this one is spawned as a
// child process of a signed app. It is committed the same way build/icon.ico is,
// and this script is run by hand when RawPrint.cs changes.
import { spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = path.join(root, 'build', 'rawprint', 'RawPrint.cs')
const out = path.join(root, 'build', 'rawprint', 'odyssey-rawprint.exe')

if (process.platform !== 'win32') {
  console.error('The raw-print helper is a Windows binary; build it on Windows.')
  process.exit(1)
}

/* 64-bit first. A 32-bit helper works, but a mismatch against a 64-bit-only
   printer driver is a failure that reads as "the printer refused the job". */
const candidates = [
  path.join(process.env.WINDIR ?? 'C:\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
  path.join(process.env.WINDIR ?? 'C:\Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
]
const csc = candidates.find((p) => existsSync(p))
if (!csc) {
  console.error('Could not find csc.exe. Looked in:\n  ' + candidates.join('\n  '))
  process.exit(1)
}

/* /platform:anycpu so one binary serves both, and /nologo /optimize+ so the
   committed artefact is small and its bytes are stable between builds. */
const result = spawnSync(
  csc,
  ['/nologo', '/optimize+', '/platform:anycpu', '/target:exe', `/out:${out}`, src],
  { stdio: 'inherit' },
)

if (result.status !== 0) {
  console.error(`csc.exe exited ${result.status}.`)
  process.exit(result.status ?? 1)
}

console.log(`Built ${path.relative(root, out)} (${statSync(out).size} bytes).`)
console.log('Commit it — electron-builder ships it from extraResources, it is not built by `npm run dist`.')
