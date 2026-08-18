/**
 * Launch a headless Chrome for CDP driving — and make sure it is OUR Chrome.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────
 *
 * Every verify/probe/smoke script used to hard-code its own debugging port,
 * and a dozen ports were claimed by two or three scripts each. Run two of
 * them at once — routine in this repo — and the second Chrome fails to bind
 * the port, so the old `devtoolsUrl()` poll found the FIRST script's Chrome
 * still listening there, attached to it, drove it, and killed it on exit.
 *
 * The visible symptom was a browser closing "at random" mid-use, because a
 * script-launched Chrome is a perfectly usable browser window and one of
 * them had been adopted for real browsing.
 *
 * Two guarantees fix that class of bug:
 *
 *   1. Ports are allocated from the OS, not hard-coded, so two concurrent
 *      runs cannot collide in the first place.
 *   2. Before attaching, the DevTools endpoint is checked against the
 *      process we actually spawned. If some other Chrome answers, we fail
 *      loudly instead of hijacking it.
 *
 * Nothing here kills by process name, and nothing kills a process tree —
 * only the exact child pid this module spawned.
 */
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const CHROME =
  process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * A port the OS just told us is free.
 *
 * Binding port 0 and reading back the assigned port leaves a small race —
 * something else could take it between close and Chrome's bind — but it beats
 * a hard-coded number that is GUARANTEED to collide with a sibling script.
 * Chrome failing to bind is caught below by the ownership check rather than
 * silently adopting whatever else is listening.
 */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

/**
 * Start a headless Chrome and return a connected-ready DevTools URL.
 *
 * `name` only labels the temp profile directory, which makes a leaked one
 * traceable back to the script that made it.
 *
 * Returns { wsUrl, port, profile, chrome, close }. Call `close()` when done;
 * it is idempotent and also runs on process exit.
 */
export async function launchChrome(name, { windowSize = '1600,1000', extraArgs = [] } = {}) {
  const port = Number(process.env.CDP_PORT) || (await freePort())
  const profile = path.join(tmpdir(), `odyssey-${name}-${process.pid}-${Date.now()}`)
  mkdirSync(profile, { recursive: true })

  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--hide-scrollbars',
      `--user-data-dir=${profile}`,
      `--window-size=${windowSize}`,
      ...extraArgs,
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  let exited = false
  let exitCode = null
  chrome.on('exit', (code) => {
    exited = true
    exitCode = code
  })

  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    // Kill the exact pid we spawned — never a name, never a tree.
    try { chrome.kill() } catch {}
    try { rmSync(profile, { recursive: true, force: true }) } catch {}
  }

  // 'exit' alone misses Ctrl-C and an uncaught throw, which is how 800-odd
  // profile directories accumulated in %TEMP%.
  //
  // The exit-handler teardown is deliberately kill-only: deleting the profile
  // tree from inside `process.on('exit')` while the browser socket is still
  // open crashes Node on Windows with
  //   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c
  // and the process exits 9 — a run that passed reporting failure. Callers
  // that want the directory reclaimed should call close() themselves before
  // returning; see verify-theme-script.mjs, which hit exactly this.
  process.on('exit', () => { try { chrome.kill() } catch {} })
  process.on('SIGINT', () => { close(); process.exit(130) })
  process.on('SIGTERM', () => { close(); process.exit(143) })
  process.on('uncaughtException', (err) => {
    close()
    console.error(err)
    process.exit(1)
  })

  const wsUrl = await devtoolsUrl({ port, profile, chrome, isExited: () => exited, exitCode: () => exitCode })

  /**
   * The debugger URL for a page target rather than the browser itself.
   *
   * Some scripts drive a tab directly and reconnect per navigation, so they
   * want `/json/list` instead of `/json/version`. Ownership is already proven
   * by the time this is callable — the browser endpoint was verified above.
   */
  async function pageTarget() {
    for (let i = 0; i < 40; i++) {
      if (exited) throw new Error(`Chrome exited (code ${exitCode}) before exposing a page target.`)
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/list`)
        const page = (await res.json()).find((t) => t.type === 'page')
        if (page) return page.webSocketDebuggerUrl
      } catch {
        /* not up yet */
      }
      await sleep(250)
    }
    throw new Error(`Chrome exposed no page target on port ${port}`)
  }

  return { wsUrl, port, profile, chrome, close, pageTarget }
}

/**
 * Poll for the DevTools endpoint, then prove it belongs to our Chrome.
 *
 * The ownership check is the whole point: `/json/version` is answered by
 * whichever Chrome holds the port, so a bare "did it respond" poll is exactly
 * what let a script attach to a browser it did not start.
 */
async function devtoolsUrl({ port, profile, chrome, isExited, exitCode }) {
  for (let i = 0; i < 60; i++) {
    // If our own Chrome died, waiting for it to answer is pointless — and if
    // we kept polling we might get an answer from somebody else's.
    if (isExited()) {
      throw new Error(
        `Chrome exited (code ${exitCode()}) before exposing port ${port}. ` +
          `Profile was ${profile}.`,
      )
    }
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (r.ok) {
        const info = await r.json()
        assertOurs(info, { port, profile, chrome })
        return info.webSocketDebuggerUrl
      }
    } catch (e) {
      if (e instanceof OwnershipError) throw e
    }
    await sleep(250)
  }
  throw new Error(`Chrome did not expose debugging port ${port}`)
}

class OwnershipError extends Error {}

/**
 * Refuse to drive a Chrome that is not ours.
 *
 * `/json/version` does NOT report the user-data-dir (checked against Chrome
 * 151 — it returns only Browser/Protocol-Version/User-Agent/V8/WebKit/wsUrl),
 * so the profile path cannot be used as the fingerprint. The listening socket
 * can: whoever holds the port owns the endpoint, so if that pid is not the
 * Chrome we spawned, the endpoint is somebody else's.
 *
 * Chrome's launcher process may hand the port to a child, so a descendant of
 * our pid counts as ours too.
 */
function assertOurs(info, { port, profile, chrome }) {
  if (!info.webSocketDebuggerUrl) {
    throw new OwnershipError(`Port ${port} answered without a debugger URL — not driving it.`)
  }

  const holder = pidHoldingPort(port)
  // If we cannot read the socket table, do not guess. Refusing here would
  // break every run on a locked-down machine; the pid check is a safety net
  // over an already-unique port, not the only defence.
  if (holder === null) return

  if (!isSelfOrDescendant(holder, chrome.pid)) {
    throw new OwnershipError(
      `Port ${port} is held by pid ${holder}, but this script spawned pid ${chrome.pid}.\n` +
        `Refusing to attach — driving that browser would close a window this script did not open.\n` +
        `Our profile was ${profile}.`,
    )
  }
}

/** The pid LISTENING on a loopback port, or null if it cannot be determined. */
function pidHoldingPort(port) {
  try {
    const out = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' })
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i)
      if (m && Number(m[1]) === port) return Number(m[2])
    }
    return null
  } catch {
    return null
  }
}

/** Walk the parent chain so a Chrome child process still counts as ours. */
function isSelfOrDescendant(pid, ancestor) {
  if (pid === ancestor) return true
  const parents = parentMap()
  if (!parents) return true // cannot verify — do not block the run
  let cur = pid
  for (let hops = 0; hops < 12; hops++) {
    const next = parents.get(cur)
    if (next === undefined) return false
    if (next === ancestor) return true
    cur = next
  }
  return false
}

let cachedParents
function parentMap() {
  if (cachedParents !== undefined) return cachedParents
  try {
    const out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }',
      ],
      { encoding: 'utf8' },
    )
    const map = new Map()
    for (const line of out.split(/\r?\n/)) {
      const [a, b] = line.trim().split(/\s+/)
      if (a && b) map.set(Number(a), Number(b))
    }
    cachedParents = map
  } catch {
    cachedParents = null
  }
  return cachedParents
}

export { sleep }
