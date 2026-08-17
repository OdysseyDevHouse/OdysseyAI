// The slice of RFC 6455 this server actually needs.
//
// ── WHY NOT `ws` ────────────────────────────────────────────────────────────
//
// `ws` is the right library for a general WebSocket server and this is not a
// general WebSocket server: it accepts binary frames from one known client
// (electron/replicationTunnel.js) and forwards the bytes. It never negotiates
// an extension, never speaks to a browser, and never handles a subprotocol.
//
// Against that, adding a dependency costs a package.json change — a file two
// sessions may be editing — and a supply-chain surface on the one process that
// terminates connections from every shop. The framing below is a few dozen
// lines of a well-specified protocol, and it is a smaller thing to own than the
// alternative is to trust.
//
// What is deliberately NOT implemented, because the client never sends it:
// extensions (permessage-deflate), subprotocols, and fragmented CONTINUATION
// frames. A frame arriving with a reserved bit or an unknown opcode is closed
// rather than guessed at.
import { createHash } from 'node:crypto'

/** The fixed GUID from RFC 6455 §1.3. Not a secret; it defeats caching proxies. */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export const OPCODE = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
}

/** The `Sec-WebSocket-Accept` value for a client's key. */
export function acceptKey(clientKey) {
  return createHash('sha1').update(clientKey + GUID).digest('base64')
}

/**
 * Complete the upgrade on a raw socket.
 *
 * Returns false and closes the socket if this is not a WebSocket handshake we
 * can complete — a plain HTTP request that wandered onto the port, or a client
 * asking for an extension we do not implement.
 */
export function handshake(req, socket, key) {
  if (!key) {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    return false
  }
  /* No extension is negotiated, so none may be used. Answering an offer with
     silence is correct per §9.1 — the client must then not apply it. */
  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey(key)}`,
      '',
      '',
    ].join('\r\n'),
  )
  socket.setNoDelay(true)
  return true
}

/**
 * Build a frame to send to the client.
 *
 * Server-to-client frames are never masked (§5.1), which is why this is much
 * shorter than the parser.
 */
export function encodeFrame(payload, opcode = OPCODE.BINARY) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  const len = body.length

  let header
  if (len < 126) {
    header = Buffer.alloc(2)
    header[1] = len
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 127
    /* 64-bit length. Written as a BigInt because a dump can exceed 2^32 and
       writeUInt32BE would silently wrap. */
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  header[0] = 0x80 | opcode // FIN set: this server never fragments

  return Buffer.concat([header, body])
}

/**
 * Incremental frame parser.
 *
 * A stateful reader rather than a pure function, because TCP does not deliver
 * frames — it delivers bytes, and a single read can carry half a header or
 * nine frames. Getting this wrong is the classic WebSocket bug: it works for
 * small messages and corrupts under load, which is exactly the traffic
 * replication produces.
 */
export function createParser({ onMessage, onClose, onPing, onError }) {
  let buffer = Buffer.alloc(0)

  return function push(chunk) {
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])

    for (;;) {
      if (buffer.length < 2) return

      const first = buffer[0]
      const second = buffer[1]

      /* Reserved bits must be zero when no extension was negotiated, and this
         server negotiates none. A set bit means the client is applying
         something we did not agree to, so the frame cannot be read. */
      if ((first & 0x70) !== 0) {
        onError?.(new Error('reserved bits set'))
        return
      }

      const fin = (first & 0x80) !== 0
      const opcode = first & 0x0f
      const masked = (second & 0x80) !== 0
      let length = second & 0x7f
      let offset = 2

      if (length === 126) {
        if (buffer.length < offset + 2) return
        length = buffer.readUInt16BE(offset)
        offset += 2
      } else if (length === 127) {
        if (buffer.length < offset + 8) return
        const big = buffer.readBigUInt64BE(offset)
        /* A frame larger than this is either a bug or an attempt to make us
           allocate. Replication frames are bounded by the MySQL packet size,
           orders of magnitude below it. */
        if (big > 64n * 1024n * 1024n) {
          onError?.(new Error('frame too large'))
          return
        }
        length = Number(big)
        offset += 8
      }

      /* Client-to-server frames MUST be masked (§5.1). An unmasked one is a
         non-conformant client or something that is not a client at all. */
      if (!masked) {
        onError?.(new Error('client frame was not masked'))
        return
      }
      if (buffer.length < offset + 4) return
      const mask = buffer.subarray(offset, offset + 4)
      offset += 4

      if (buffer.length < offset + length) return // wait for the rest

      const payload = Buffer.allocUnsafe(length)
      for (let i = 0; i < length; i++) payload[i] = buffer[offset + i] ^ mask[i & 3]

      buffer = buffer.subarray(offset + length)

      switch (opcode) {
        case OPCODE.BINARY:
        case OPCODE.TEXT:
          /* The client is our own tunnel and never fragments. A CONTINUATION
             would mean it changed; refusing is better than reassembling
             something we have not tested. */
          if (!fin) {
            onError?.(new Error('fragmented frames are not supported'))
            return
          }
          onMessage?.(payload)
          break
        case OPCODE.PING:
          onPing?.(payload)
          break
        case OPCODE.PONG:
          break // liveness is tracked by the caller's own timer
        case OPCODE.CLOSE:
          onClose?.()
          return
        default:
          onError?.(new Error(`unknown opcode ${opcode}`))
          return
      }
    }
  }
}
