// The network transport, against a real loopback listener.
//
//   npm run test:print-tcp
//
// No Electron and no hardware: electron/printTransports.js requires only
// node:net, node:fs and node:child_process, which is exactly why it was split
// out of printing.js. The bytes that reach the socket here are the same bytes
// that would reach a printer.
//
// The decisions under test are the ones that fail intermittently on a counter
// and never on a desk:
//
//   · BYTES ARRIVE WHOLE. `end(bytes, cb)` rather than write-then-end, so a
//     300KB slip with a logo in it is not truncated at a chunk boundary.
//   · THE TIMEOUT COVERS CONNECTING. A printer switched off on a live LAN sends
//     no RST at all — Windows holds the SYN retry for ~21 seconds, and a till
//     that freezes for 21 seconds at a counter is the actual bug.
//   · REFUSED AND UNREACHABLE ARE DIFFERENT. They send a technician to
//     different places, so they must not collapse into one message.
//   · ONE JOB AT A TIME, PER PRINTER. Most 80mm heads accept exactly one TCP
//     connection; without the queue the second job's failure is unreproducible.
import net from 'node:net'
import { sendTcp, probeTcp } from '../electron/printTransports.js'

let fails = 0
const ok = (label, cond, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

/** A listener that collects whole connections. */
function listener({ read = true } = {}) {
  const received = []
  const server = net.createServer((socket) => {
    if (!read) return // Accepts and never reads — the wedged-printer case.
    const chunks = []
    socket.on('data', (c) => chunks.push(c))
    socket.on('end', () => received.push(Buffer.concat(chunks)))
    socket.on('error', () => {})
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, received, port: server.address().port }))
  })
}

const INIT = [0x1b, 0x40, 0x1b, 0x74, 0x13] // ESC @ + ESC t 19 — pinned by test-escpos
const CUT = [0x1d, 0x56, 0x42, 0x00]

console.log('\n── Fidelity ────────────────────────────────────────────────\n')
{
  const { server, received, port } = await listener()
  const job = new Uint8Array([...INIT, 0x48, 0x69, 0x0a, ...CUT])
  const result = await sendTcp('127.0.0.1', port, job)
  ok('a job is sent', result.ok, result.ok ? '' : result.error)
  await new Promise((r) => setTimeout(r, 50))
  const got = received[0]
  ok('*** the bytes arrive unchanged ***', got !== undefined && Buffer.from(job).equals(got))
  ok('…starting with the ESC/POS init sequence', got !== undefined && got.subarray(0, 5).equals(Buffer.from(INIT)))
  ok('…and ending with the cut', got !== undefined && got.subarray(-4).equals(Buffer.from(CUT)))
  server.close()
}

console.log('\n── A large job ─────────────────────────────────────────────\n')
{
  const { server, received, port } = await listener()
  /* 300KB — a slip with a raster logo is 50-100KB, so this is comfortably past
     any single chunk. The bug this catches is write-then-end without waiting
     for drain, which silently truncates. */
  const big = new Uint8Array(300 * 1024).fill(0x41)
  const result = await sendTcp('127.0.0.1', port, big)
  await new Promise((r) => setTimeout(r, 150))
  ok('*** a 300KB job arrives complete, not truncated ***',
     result.ok && received[0]?.length === big.length,
     `${received[0]?.length ?? 0} of ${big.length}`)
  server.close()
}

console.log('\n── Failure, told apart ─────────────────────────────────────\n')
{
  /* A printer that accepts the connection and never reads a byte.
   *
   * This SUCCEEDS, and pinning that is the point. Port 9100 has no
   * acknowledgement, and printTargets caps a job at 2MB — which fits in the
   * socket buffers of any modern OS — so `ok` here means "the bytes left for the
   * kernel" and nothing more. Every message the UI shows has to respect that:
   * "sent to the printer", never "printed". A cashier told "printed" stops
   * looking at the printer, which is exactly when the paper has run out. */
  const { server, port } = await listener({ read: false })
  const result = await sendTcp('127.0.0.1', port, new Uint8Array(2048).fill(0x41), { timeoutMs: 500 })
  ok('*** "ok" means SENT, not printed — a printer that never reads still succeeds ***', result.ok)
  server.close()
}
{
  const { server, port } = await listener()
  await new Promise((r) => server.close(r))
  const result = await sendTcp('127.0.0.1', port, new Uint8Array([1]), { timeoutMs: 500 })
  ok('*** a refused connection names the host and the errno ***',
     !result.ok && result.error.includes(`127.0.0.1:${port}`) && /ECONNREFUSED/.test(result.error),
     result.error)
}
{
  /* TEST-NET-1 (RFC 5737) is guaranteed unroutable, so this is the
     powered-off-printer case: no RST, just silence. It must take the TIMEOUT
     branch, which is the branch that exists so a till does not freeze. */
  const started = Date.now()
  const result = await sendTcp('192.0.2.1', 9100, new Uint8Array([1]), { timeoutMs: 300 })
  const elapsed = Date.now() - started
  ok('*** an unreachable address times out, and quickly ***', !result.ok && elapsed < 3000, `${elapsed}ms`)
  ok('…via the timeout branch, not the error branch', !result.ok && /did not answer/.test(result.error), result.error)
}

console.log('\n── One at a time, per printer ──────────────────────────────\n')
{
  const { server, received, port } = await listener()
  const jobs = [1, 2, 3].map((n) => new Uint8Array(1000).fill(0x40 + n))
  const results = await Promise.all(jobs.map((j) => sendTcp('127.0.0.1', port, j)))
  await new Promise((r) => setTimeout(r, 200))

  ok('every job reports success', results.every((r) => r.ok))
  ok('*** three simultaneous jobs arrive as three whole payloads ***',
     received.length === 3 && received.every((b) => b.length === 1000),
     `${received.length} payloads`)
  ok('*** none of them is interleaved with another ***',
     received.every((b) => new Set(b).size === 1))
  ok('*** and they arrive in the order they were submitted ***',
     received.map((b) => b[0] - 0x40).join(',') === '1,2,3',
     received.map((b) => b[0] - 0x40).join(','))
  server.close()
}

console.log('\n── Probe ───────────────────────────────────────────────────\n')
{
  const { server, port } = await listener()
  ok('a probe finds a listening printer', (await probeTcp('127.0.0.1', port)).ok)
  await new Promise((r) => server.close(r))
  const gone = await probeTcp('127.0.0.1', port, { timeoutMs: 500 })
  ok('*** and reports one that is not there ***', !gone.ok, gone.error)
}

console.log(fails === 0 ? '\nEvery network transport rule holds.\n' : `\n${fails} check(s) failed.\n`)
process.exit(fails === 0 ? 0 : 1)
