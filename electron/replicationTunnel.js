// The outbound tunnel the cloud replica reads the binary log through.
//
// ── WHY A TUNNEL AND NOT A DIRECT CONNECTION ────────────────────────────────
//
// Replication is normally the replica dialling the master. That cannot work
// here: the master is a PC behind a shop's domestic router, on a dynamic
// address, with no port forwarding and often behind carrier-grade NAT. Nothing
// on the internet can reach it, and asking a shopkeeper to configure their
// router is not an installation step.
//
// So the direction is inverted. The shop dials OUT to us — which every router
// permits — and the replica reads back down that connection. The shop's server
// stays bound to 127.0.0.1 and is never exposed; the only thing reachable from
// outside is the tunnel, and the tunnel authenticates before it forwards
// anything.
//
// ── WHAT THIS FILE IS AND IS NOT ────────────────────────────────────────────
//
// It manages the LIFETIME of that connection: dial, authenticate, forward,
// notice when it drops, back off, dial again. It deliberately knows nothing
// about replication itself — no binlog positions, no SQL. Those belong to the
// two database servers, which is the whole reason for using their own
// replication rather than writing a sync engine.
//
// The transport is a WebSocket to our own endpoint rather than SSH: it needs no
// second binary in the installer, it survives the proxies and inspecting
// firewalls a business line may sit behind, and it is one protocol rather than
// a port-forward whose failure modes a support desk would have to learn.
const net = require('node:net')

/** Backoff between dial attempts. A shop's line comes back when it comes back. */
const RETRY_MIN_MS = 5_000
const RETRY_MAX_MS = 5 * 60_000
/** Silence after which the link is presumed dead even though the socket is open. */
const HEARTBEAT_MS = 30_000

let state = {
  socket: null,
  ws: null,
  timer: null,
  attempt: 0,
  stopped: false,
  lastError: null,
  connectedAt: null,
}

function backoffMs(attempt) {
  /* Exponential with a ceiling. A shop whose line is down for a day should not
     be dialling every five seconds all day, and our endpoint should not be
     taking a thundering herd from every shop in the country when it restarts. */
  const ms = Math.min(RETRY_MIN_MS * 2 ** Math.max(0, attempt - 1), RETRY_MAX_MS)

  /* Jitter, for the same reason: without it every shop that lost the link in
     the same outage redials in lockstep.
     Applied DOWNWARD only, and the cap re-applied after. Spreading either side
     of the target let a "capped" five minutes come out as six and a half — the
     ceiling has to be a ceiling, or it is only a suggestion. */
  const jittered = Math.floor(ms * (0.7 + Math.random() * 0.3))
  return Math.max(RETRY_MIN_MS / 2, Math.min(jittered, RETRY_MAX_MS))
}

/**
 * Open the tunnel and keep it open.
 *
 * Never throws and never rejects: a failure to reach us must not stop a shop
 * from trading, and the only correct response to "the line is down" is to try
 * again later. Everything it knows is reported through status() instead.
 */
function start({ url, token, siteId, deviceSerial, dbPort, onStatus }) {
  if (!url || !token) return // replication not configured for this install
  state.stopped = false

  const dial = () => {
    if (state.stopped) return
    state.attempt += 1

    let ws
    try {
      /* Node 22 has a global WebSocket. Guarded rather than assumed: a build
         on an older runtime should degrade to "no replication" instead of
         crashing the shell before the app has started. */
      if (typeof WebSocket !== 'function') {
        state.lastError = 'This build cannot open a replication tunnel (no WebSocket).'
        return
      }
      ws = new WebSocket(url, {
        headers: {
          authorization: `Bearer ${token}`,
          'x-odyssey-site': String(siteId ?? ''),
          'x-odyssey-device': deviceSerial ?? '',
        },
      })
    } catch (err) {
      state.lastError = String(err?.message || err)
      schedule()
      return
    }

    state.ws = ws
    ws.binaryType = 'arraybuffer'

    ws.onopen = () => {
      state.attempt = 0
      state.connectedAt = Date.now()
      state.lastError = null
      onStatus?.({ connected: true })

      /* One TCP connection to the local server per tunnel. The far end speaks
         the MySQL replication protocol through it; nothing here interprets a
         byte of that. */
      const socket = net.createConnection({ host: '127.0.0.1', port: dbPort })
      state.socket = socket

      socket.on('data', (chunk) => {
        if (ws.readyState === 1) ws.send(chunk)
      })
      socket.on('error', (err) => {
        state.lastError = `local database: ${err.message}`
        try {
          ws.close()
        } catch {
          /* already closing */
        }
      })
      socket.on('close', () => {
        try {
          ws.close()
        } catch {
          /* already closing */
        }
      })
    }

    ws.onmessage = (event) => {
      const data = event.data
      const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data)
      if (state.socket && !state.socket.destroyed) state.socket.write(buf)
    }

    ws.onerror = () => {
      /* The close handler does the work; an error without a close is not a
         state this needs to distinguish. */
      state.lastError = 'the replication tunnel could not be reached'
    }

    ws.onclose = () => {
      state.connectedAt = null
      if (state.socket && !state.socket.destroyed) state.socket.destroy()
      state.socket = null
      state.ws = null
      onStatus?.({ connected: false })
      schedule()
    }
  }

  const schedule = () => {
    if (state.stopped) return
    clearTimeout(state.timer)
    state.timer = setTimeout(dial, backoffMs(state.attempt))
  }

  dial()

  /* A socket that is open but silent is the failure mode a reconnect loop
     misses: the router dropped the flow, both ends still believe they are
     connected, and no data moves until something times out minutes later. */
  clearInterval(state.heartbeat)
  state.heartbeat = setInterval(() => {
    if (state.ws?.readyState === 1) {
      try {
        state.ws.send(new Uint8Array(0))
      } catch {
        try {
          state.ws.close()
        } catch {
          /* already going */
        }
      }
    }
  }, HEARTBEAT_MS)
}

/** Close the tunnel and stop redialling. */
function stop() {
  state.stopped = true
  clearTimeout(state.timer)
  clearInterval(state.heartbeat)
  try {
    state.ws?.close()
  } catch {
    /* already closed */
  }
  try {
    state.socket?.destroy()
  } catch {
    /* already gone */
  }
  state.ws = null
  state.socket = null
}

/** What to show on a support screen, and nothing more. */
function status() {
  return {
    connected: state.ws?.readyState === 1,
    connectedAt: state.connectedAt,
    attempts: state.attempt,
    lastError: state.lastError,
  }
}

module.exports = { start, stop, status, backoffMs }
