// Moving bytes to a printer. Nothing here knows what a receipt is.
//
// ── NO ELECTRON, ON PURPOSE ─────────────────────────────────────────────────
//
// node:net, node:fs, node:os, node:child_process and nothing else. That is what
// lets scripts/test-print-tcp.mjs run the real network transport against a
// loopback listener, and scripts/test-print-queue.mjs run the real spooler
// transport against a stub helper — no display, no Electron, no hardware.
//
// ── "ok" MEANS SENT, NEVER PRINTED ──────────────────────────────────────────
//
// Port 9100 is a one-way pipe with no acknowledgement; a spooler write returns
// when the job is queued. NOTHING in any transport can tell you that paper
// moved. Every caller's wording has to respect that — "sent to the printer",
// not "printed" — because a cashier told "printed" stops looking at the printer.
const net = require('node:net')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')

/* ── One job at a time, per printer ────────────────────────────────────────
 *
 * Most 80mm thermal heads accept exactly ONE TCP connection and refuse or
 * silently drop a second. The till genuinely fires two jobs milliseconds apart:
 * the drawer kick when a sale is finalised, the receipt when Print is tapped,
 * and `fireKitchenTickets` looping several dockets at once.
 *
 * Without this queue the second job's ECONNREFUSED is intermittent, hardware-
 * dependent and impossible to reproduce on a desk. With it they are simply
 * ordered.
 *
 * Per PROCESS. Two tills sharing one kitchen printer still race, exactly as
 * they do today — and the print-then-mark ordering in kitchenActions already
 * makes a refused job safe, because an unmarked ticket is retried.
 */
const chains = new Map()
const depths = new Map()
const MAX_QUEUE = 8

function enqueue(key, fn) {
  const waiting = depths.get(key) ?? 0
  if (waiting >= MAX_QUEUE) {
    /* Refusing beats accumulating. A backlog that clears when the printer comes
       back prints ten minutes of stale tickets at a confused kitchen. */
    return Promise.resolve({ ok: false, error: 'The printer is not keeping up.' })
  }
  depths.set(key, waiting + 1)

  const previous = chains.get(key) ?? Promise.resolve()
  const run = previous.then(fn, fn).then(
    (result) => {
      depths.set(key, (depths.get(key) ?? 1) - 1)
      return result
    },
    (err) => {
      depths.set(key, (depths.get(key) ?? 1) - 1)
      return { ok: false, error: String(err && err.message ? err.message : err) }
    },
  )
  /* The CHAIN swallows failures so one bad job cannot poison the queue behind
     it; the returned promise still carries the real result to its own caller. */
  chains.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  )
  return run
}

/* ── Network: raw ESC/POS over TCP ─────────────────────────────────────────── */

/**
 * Writes bytes to a printer listening on a raw port.
 *
 * The timeout covers CONNECTING, not just idling, and that is the whole reason
 * it exists. A printer that is switched off on a live LAN sends no RST at all —
 * Windows holds the SYN retry for about twenty-one seconds, and a till that
 * freezes for twenty-one seconds at a counter is worse than one that says it
 * could not reach the printer.
 *
 * The error names the host AND the errno, because they send a technician to
 * different places: ECONNREFUSED means something answered at that address but
 * nothing is listening on that port (usually the wrong port, or a printer not
 * in network mode), while ETIMEDOUT and EHOSTUNREACH mean the wrong address or
 * a dead machine.
 */
function sendTcp(host, port, bytes, { timeoutMs = 3000 } = {}) {
  return enqueue(`tcp:${host}:${port}`, () => {
    return new Promise((resolve) => {
      let settled = false
      const finish = (result) => {
        if (settled) return
        settled = true
        try {
          socket.destroy()
        } catch {
          /* Already gone. */
        }
        resolve(result)
      }

      const socket = net.createConnection({ host, port })
      socket.setTimeout(timeoutMs, () =>
        finish({
          ok: false,
          /* Seconds when it is seconds, milliseconds when it is not. Rounding a
             300ms timeout to "0 seconds" reads as a bug in the message rather
             than a fact about the printer. */
          error:
            `The printer at ${host}:${port} did not answer within ` +
            (timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} seconds.` : `${timeoutMs}ms.`),
        }),
      )
      socket.on('error', (err) =>
        finish({
          ok: false,
          error: `Could not reach the printer at ${host}:${port} — ${err.code || err.message}.`,
        }),
      )
      /* `end(bytes, cb)` rather than `write` then `end`: the callback fires once
         the whole buffer has been flushed, so a 300KB job with a logo in it
         cannot be truncated at a chunk boundary. */
      socket.on('connect', () => socket.end(bytes, () => finish({ ok: true })))
    })
  })
}

/* ── OS queue: raw ESC/POS through the spooler ─────────────────────────────── */

/**
 * Writes raw bytes to a print queue on this machine.
 *
 * ── WHY A HELPER EXECUTABLE ───────────────────────────────────────────────
 *
 * Node cannot hand RAW data to the Windows spooler on its own, and every
 * alternative is worse:
 *
 *   PowerShell Out-Printer     renders through the GDI driver, so ESC/POS comes
 *                              out as literal garbage characters.
 *   Add-Type + P/Invoke        correct, but compiles C# on EVERY call (1-2s at a
 *                              counter), is blocked by Constrained Language Mode
 *                              and AppLocker, and csc.exe writing an assembly is
 *                              flagged by several EDR products.
 *   \\localhost\<Share>        works, but only if the printer is SHARED, and the
 *                              share name is a different string from the printer
 *                              name — a typo gives an ENOENT that names nothing.
 *
 * So: a ~10KB signed helper that calls OpenPrinter/WritePrinter directly. It is
 * NOT a native node module — no binding.gyp, no node-gyp, nothing to rebuild
 * when Electron moves. The UNC path stays as an explicit fallback for machines
 * where policy blocks spawning it, and only when a share name was configured on
 * purpose — never guessed from the printer's name.
 *
 * `helperPath` is INJECTED rather than resolved here so the test can point it at
 * a stub and assert what actually reaches the process.
 */
function sendQueueRaw(queueName, bytes, { helperPath, shareName = '' } = {}) {
  return enqueue(`queue:${queueName}`, async () => {
    if (process.platform === 'win32') {
      if (helperPath && fs.existsSync(helperPath)) {
        return spawnHelper(helperPath, queueName, bytes)
      }
      if (shareName) return writeShare(shareName, bytes)
      return {
        ok: false,
        error:
          `Odyssey could not send raw data to “${queueName}”. The raw-print helper is ` +
          `missing from this installation — reinstall Odyssey, or set a share name for ` +
          `this printer in Setup → Printing.`,
      }
    }
    return sendLp(queueName, bytes)
  })
}

/**
 * Windows: the helper, fed through a temp FILE.
 *
 * Not the command line — a slip with a raster logo blows the 32KB argv limit.
 * Not stdin either: on Windows that is one more layer between here and the
 * spooler that can mangle a 0x1a or a lone 0x0d, and a mangled ESC/POS stream
 * is a till printing confetti.
 *
 * `spawn` with an argv ARRAY and never `shell: true`. Windows printer names
 * legitimately contain spaces, `&`, `(` and non-ASCII; as an argv element that
 * is opaque, and through a shell it is syntax.
 */
function spawnHelper(helperPath, queueName, bytes) {
  return new Promise((resolve) => {
    const jobFile = path.join(os.tmpdir(), `odyssey-print-${crypto.randomUUID()}.bin`)
    const done = (result) => {
      try {
        fs.unlinkSync(jobFile)
      } catch {
        /* Already gone, or never written. Never let cleanup mask the result. */
      }
      resolve(result)
    }

    try {
      fs.writeFileSync(jobFile, Buffer.from(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength))
    } catch (err) {
      resolve({ ok: false, error: `Could not stage the print job — ${err.code || err.message}.` })
      return
    }

    /* `spawn` can fail SYNCHRONOUSLY — an EINVAL on Windows for an executable it
       refuses to launch is the case that found this. Thrown out of here, it
       escapes to enqueue's catch, `done()` never runs, and the staged job file
       is left in temp forever. One try/catch, and the file is always reclaimed. */
    let child
    try {
      child = spawn(helperPath, [queueName, jobFile], { windowsHide: true })
    } catch (err) {
      done({ ok: false, error: `Could not run the raw-print helper — ${err.code || err.message}.` })
      return
    }

    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', (err) =>
      done({ ok: false, error: `Could not run the raw-print helper — ${err.code || err.message}.` }),
    )
    child.on('close', (code) =>
      done(
        code === 0
          ? { ok: true }
          : { ok: false, error: stderr.trim() || `The printer “${queueName}” refused the job.` },
      ),
    )
  })
}

/**
 * Windows fallback: the LanMan redirector hands a shared queue's stream to the
 * spooler as a RAW job. Only ever used when a share name was set deliberately.
 */
function writeShare(shareName, bytes) {
  return new Promise((resolve) => {
    const unc = `\\\\localhost\\${shareName}`
    fs.writeFile(unc, Buffer.from(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength), (err) => {
      if (!err) return resolve({ ok: true })
      resolve({
        ok: false,
        error:
          `Could not write to the shared printer “${shareName}” — ${err.code || err.message}. ` +
          `Check the printer is shared under that exact name and that File and Printer Sharing is on.`,
      })
    })
  })
}

/** macOS and Linux. Six lines, so this file is not Windows-shaped. */
function sendLp(queueName, bytes) {
  return new Promise((resolve) => {
    const child = spawn('lp', ['-d', queueName, '-o', 'raw'])
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', (err) => resolve({ ok: false, error: `Could not run lp — ${err.code || err.message}.` }))
    child.on('close', (code) =>
      resolve(code === 0 ? { ok: true } : { ok: false, error: stderr.trim() || 'The print queue refused the job.' }),
    )
    child.stdin.end(Buffer.from(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength))
  })
}

/** Can this machine open that target at all? Behind the setup screen's test. */
function probeTcp(host, port, { timeoutMs = 3000 } = {}) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      try {
        socket.destroy()
      } catch {
        /* Already gone. */
      }
      resolve(result)
    }
    const socket = net.createConnection({ host, port })
    socket.setTimeout(timeoutMs, () =>
      finish({ ok: false, error: `Nothing answered at ${host}:${port}.` }),
    )
    socket.on('error', (err) =>
      finish({ ok: false, error: `Could not reach ${host}:${port} — ${err.code || err.message}.` }),
    )
    socket.on('connect', () => finish({ ok: true }))
  })
}

module.exports = { enqueue, sendTcp, sendQueueRaw, probeTcp, MAX_QUEUE }
