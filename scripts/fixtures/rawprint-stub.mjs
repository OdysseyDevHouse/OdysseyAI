// Stands in for build/rawprint/odyssey-rawprint.exe so the queue transport can
// be tested with no printer and no spooler.
//
// Prints one JSON line to stdout describing exactly what reached it: the argv
// it was given, and the SHA-256 of the job file. That is what lets the test
// assert the two things that actually break in the real thing — a printer name
// mangled by a shell, and a job file corrupted on the way to disk.
//
// Exits non-zero when the queue name starts with 'FAIL', so the failure path is
// exercised by the same stub.
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const [queue, jobFile] = process.argv.slice(2)
const bytes = readFileSync(jobFile)
process.stdout.write(
  JSON.stringify({ queue, jobFile, sha256: createHash('sha256').update(bytes).digest('hex'), length: bytes.length }) + '\n',
)
if (String(queue).startsWith('FAIL')) {
  process.stderr.write('The printer refused the job.\n')
  process.exit(9)
}
