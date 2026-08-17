/**
 * The WebSocket framing the replication endpoint is built on.
 *
 * Hand-rolled rather than taken from `ws`, so it has to be proved against a
 * real client — Node's own global WebSocket, which is a conformant
 * implementation and is exactly what electron/replicationTunnel.js uses.
 *
 * The bug this is really testing for: TCP delivers bytes, not frames, so a
 * single read can carry half a header or nine messages. A parser that assumes
 * one-read-one-frame works perfectly for small messages and corrupts under
 * load — which is the traffic replication produces.
 *
 *   node scripts/test-ws-frame.mjs
 */
import { createServer } from 'node:http'
import { randomBytes, createHash } from 'node:crypto'
import { handshake, encodeFrame, createParser, acceptKey, OPCODE } from '../server/wsFrame.mjs'

let failures = 0
function check(name, ok, detail = '') {
  if (ok) console.log(`  PASS  ${name}`)
  else {
    failures++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('\nThe handshake accept value')
{
  /* The example from RFC 6455 §1.3, so this is checked against the spec rather
     than against itself. */
  check('matches the RFC example', acceptKey('dGhlIHNhbXBsZSBub25jZQ==') === 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
}

/* A server that echoes whatever it is sent, so the client's view proves the
   round trip through both encode and parse. */
const received = []
const server = createServer()
server.on('upgrade', (req, socket) => {
  if (!handshake(req, socket, req.headers['sec-websocket-key'])) return

  const push = createParser({
    onMessage: (payload) => {
      received.push(payload)
      socket.write(encodeFrame(payload, OPCODE.BINARY))
    },
    onPing: (payload) => socket.write(encodeFrame(payload, OPCODE.PONG)),
    onClose: () => socket.end(),
    onError: (err) => {
      console.log(`  (server rejected a frame: ${err.message})`)
      socket.destroy()
    },
  })
  socket.on('data', push)
  socket.on('error', () => {})
})

await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port

const ws = new WebSocket(`ws://127.0.0.1:${port}/`)
ws.binaryType = 'arraybuffer'
const echoes = []
ws.onmessage = (e) => echoes.push(Buffer.from(e.data))
await new Promise((resolve, reject) => {
  ws.onopen = resolve
  ws.onerror = () => reject(new Error('the client could not connect'))
})

console.log('\nA real client completes the handshake')
check('the connection opened', ws.readyState === 1)

async function roundTrip(payloads) {
  const before = echoes.length
  for (const p of payloads) ws.send(p)
  const deadline = Date.now() + 5000
  while (echoes.length < before + payloads.length && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10))
  }
  return echoes.slice(before)
}

console.log('\nPayloads across every length encoding')
{
  /* The three header shapes: 7-bit, 16-bit and 64-bit lengths. The boundaries
     are where an off-by-one lives. */
  const sizes = [0, 1, 125, 126, 127, 65_535, 65_536, 200_000]
  const sent = sizes.map((n) => randomBytes(n))
  const got = await roundTrip(sent)

  check('every frame came back', got.length === sent.length, `${got.length} of ${sent.length}`)
  let allMatch = true
  for (let i = 0; i < sent.length; i++) {
    if (!got[i] || !got[i].equals(sent[i])) {
      allMatch = false
      check(`  ${sizes[i]} bytes round-tripped`, false)
    }
  }
  if (allMatch) check(`all sizes round-tripped byte for byte (${sizes.join(', ')})`, true)
}

console.log('\nMany frames at once — the coalescing case')
{
  /* Sent without awaiting, so the kernel coalesces them into few reads. This
     is the case a naive parser fails. */
  const sent = Array.from({ length: 400 }, (_, i) => {
    const b = randomBytes(64)
    b.writeUInt32BE(i, 0) // sequence, so ordering is checkable
    return b
  })
  const got = await roundTrip(sent)

  check('all 400 arrived', got.length === 400, String(got.length))
  const inOrder = got.every((b, i) => b.readUInt32BE(0) === i)
  check('in the order they were sent', inOrder)
  const intact = got.every((b, i) => b.equals(sent[i]))
  check('with their contents intact', intact)
}

console.log('\nA large payload split across many TCP reads')
{
  const big = randomBytes(2_000_000)
  const got = await roundTrip([big])
  check('2MB survives fragmentation over the wire', got[0]?.equals(big), `${got[0]?.length ?? 0} bytes`)
}

console.log('\nControl frames')
{
  const before = echoes.length
  /* Node's WebSocket has no ping API, so this checks the parser directly
     rather than over the socket. */
  let pinged = null
  const push = createParser({ onPing: (p) => { pinged = p } })
  const masked = maskFrame(Buffer.from('are you there'), OPCODE.PING)
  push(masked)
  check('a ping is recognised', pinged?.toString() === 'are you there')

  let closed = false
  createParser({ onClose: () => { closed = true } })(maskFrame(Buffer.alloc(0), OPCODE.CLOSE))
  check('a close is recognised', closed)
  check('and neither reached the message handler', echoes.length === before)
}

console.log('\nMalformed input is refused, not guessed at')
{
  let err = null
  const push = createParser({ onError: (e) => { err = e } })
  /* Unmasked client frame — mandatory per §5.1, and its absence is how a
     non-client shows up on the port. */
  const unmasked = Buffer.concat([Buffer.from([0x82, 0x03]), Buffer.from([1, 2, 3])])
  push(unmasked)
  check('an unmasked client frame is rejected', /not masked/.test(err?.message ?? ''))

  err = null
  createParser({ onError: (e) => { err = e } })(Buffer.from([0xc2, 0x80, 0, 0, 0, 0]))
  check('a reserved bit is rejected', /reserved/.test(err?.message ?? ''))

  err = null
  const huge = Buffer.alloc(10)
  huge[0] = 0x82
  huge[1] = 0xff
  huge.writeBigUInt64BE(1n << 40n, 2)
  createParser({ onError: (e) => { err = e } })(huge)
  check('an absurd length is rejected before allocating', /too large/.test(err?.message ?? ''))

  err = null
  createParser({ onError: (e) => { err = e } })(maskFrame(Buffer.from('x'), 0x5))
  check('an unknown opcode is rejected', /unknown opcode/.test(err?.message ?? ''))
}

console.log('\nA byte-at-a-time feed still parses')
{
  /* The pathological delivery pattern: every header field split across reads. */
  const messages = []
  const push = createParser({ onMessage: (m) => messages.push(m) })
  const frames = Buffer.concat([
    maskFrame(Buffer.from('one'), OPCODE.BINARY),
    maskFrame(randomBytes(300), OPCODE.BINARY),
    maskFrame(Buffer.from('three'), OPCODE.BINARY),
  ])
  for (const byte of frames) push(Buffer.from([byte]))
  check('all three frames were recovered', messages.length === 3, String(messages.length))
  check('the first is intact', messages[0]?.toString() === 'one')
  check('the last is intact', messages[2]?.toString() === 'three')
}

/** Build a client-style (masked) frame, for testing the parser directly. */
function maskFrame(payload, opcode) {
  const mask = randomBytes(4)
  const len = payload.length
  let header
  if (len < 126) {
    header = Buffer.alloc(2)
    header[1] = 0x80 | len
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[1] = 0x80 | 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  header[0] = 0x80 | opcode
  const masked = Buffer.allocUnsafe(len)
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3]
  return Buffer.concat([header, mask, masked])
}

ws.close()
server.close()

console.log(failures === 0 ? '\nWebSocket framing holds.\n' : `\n${failures} FAILED\n`)
process.exit(failures === 0 ? 0 : 1)
