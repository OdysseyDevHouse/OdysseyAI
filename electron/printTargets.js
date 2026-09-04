// Every argument the renderer sends to the print engine, checked before it can
// become a socket, an argv element, or a path on disk.
//
// ── WHY THIS FILE HAS NO DEPENDENCIES ───────────────────────────────────────
//
// It requires nothing — not electron, not node:fs. So scripts/test-print-ipc.mjs
// can `require` it and RUN the rules against real rejection cases, rather than
// grepping the source and hoping. Validation that is only read is validation
// nobody notices going wrong.
//
// ── WHAT IS ACTUALLY BEING DEFENDED ─────────────────────────────────────────
//
// The main window runs with `sandbox: false`, and its renderer is a full Next
// app with a dependency tree. Anything that ends up executing in there — a
// compromised package, an injected script — can call every verb on
// window.odyssey. So these arguments are treated as hostile input even though
// the only code that composes them today is ours.
//
// Two of them do real work and are worth naming:
//
//   `queue.name`   becomes an argv element handed to a spawned executable. The
//                  check turns an attacker-chosen string into a choice from a
//                  list the OPERATING SYSTEM produced.
//   `route.path`   becomes a URL this app renders with the operator's own
//                  session, and can be written to disk. Without a prefix
//                  allow-list, "render a document to a PDF" is also "render
//                  /setup/users to a file and open it".

/**
 * Ports the engine will open.
 *
 * Without this list, `sendRaw` is a general-purpose "connect to any host and
 * port on this LAN and write these bytes" primitive. We cannot validate the
 * bytes — they are ESC/POS by construction, but nothing can prove it — so the
 * port is the mitigation actually available.
 *
 * 9100-9109 are the RAW spool ports (multi-head printers use the range), 515 is
 * LPD and 631 IPP. A shop with a printer somewhere else produces exactly one
 * support call and one refusal in the log that answers it.
 */
const DEFAULT_PORTS = [515, 631, 9100, 9101, 9102, 9103, 9104, 9105, 9106, 9107, 9108, 9109]

/**
 * Route prefixes that may be rendered.
 *
 * Short because the set of things that are DOCUMENTS is short. Everything else
 * in this app is a screen, and a screen rendered to a file is an exfiltration
 * primitive that inherits whoever is signed in.
 */
const ROUTE_PREFIXES = ['/sales/', '/purchasing/', '/labels/']

/** Frozen and matched exactly — never used as a lookup key into an object. */
const TRANSPORTS = Object.freeze(['tcp', 'queue'])

const MAX_BYTES = 2 * 1024 * 1024

function isAllowedPort(port, allowed = DEFAULT_PORTS) {
  return Number.isInteger(port) && allowed.includes(port)
}

/**
 * A bare hostname or IP literal. Never a URL, a UNC path or a socket path.
 *
 * This value becomes an outbound connection from the desktop app's position on
 * the shop network, so the shape is constrained rather than merely escaped:
 * anything that is not a host cannot be one by accident.
 */
function isHostname(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 253) return false
  // An IPv6 literal, which legitimately carries colons.
  if (/^[0-9a-fA-F:]+$/.test(value) && value.includes(':')) return true
  return /^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(value)
}

/**
 * Normalises a target, or says why not.
 *
 * `queue` names are NOT checked here — this file cannot know what is installed
 * on the machine. They are checked in printing.js against the list
 * getPrintersAsync() returned, which is the check that matters and the only one
 * that can be made.
 */
function normaliseTarget(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'No printer was named.' }

  const transport = raw.transport
  if (typeof transport !== 'string' || !TRANSPORTS.includes(transport)) {
    return { ok: false, error: 'That is not a way to reach a printer.' }
  }

  if (transport === 'tcp') {
    if (!isHostname(raw.host)) {
      return { ok: false, error: 'That is not a printer address.' }
    }
    const port = raw.port == null ? 9100 : raw.port
    if (!isAllowedPort(port)) {
      return { ok: false, error: `Odyssey will not print to port ${String(port)}.` }
    }
    return { ok: true, target: { transport: 'tcp', host: raw.host, port } }
  }

  const name = raw.name
  if (typeof name !== 'string' || name.trim() === '' || name.length > 190) {
    return { ok: false, error: 'That is not a printer queue.' }
  }
  const shareName = typeof raw.shareName === 'string' ? raw.shareName.slice(0, 190) : ''
  /* A share name becomes a UNC path component. A backslash or a slash in it
     would let it climb out of \\localhost\ into another host entirely. */
  if (shareName && !/^[^\\/:*?"<>|]+$/.test(shareName)) {
    return { ok: false, error: 'That is not a share name.' }
  }
  return { ok: true, target: { transport: 'queue', name, shareName } }
}

/**
 * A path within this app that may be rendered.
 *
 * Rejects, and each rejection is a real shape rather than defensive noise:
 *   '//host/x'  protocol-relative — a DIFFERENT ORIGIN
 *   'C:\x'      a local file
 *   '..'        climbing out of the allow-listed prefix
 *   '#'         a fragment the main process would have to reason about
 *
 * `auto` is STRIPPED rather than rejected. The (print) routes use `?auto=1` to
 * self-print in a browser, and that path also calls recordPrintAction — so a
 * hidden window driven with it would print twice AND count the slip twice,
 * which drives the COPY banner on the next one. The engine prints the window
 * itself; the caller records the print.
 */
function isAllowedRoutePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return false
  if (!value.startsWith('/') || value.startsWith('//')) return false
  if (value.includes('\\') || value.includes('#') || value.includes('..')) return false
  // A colon anywhere would let 'javascript:' or 'file:' through a lax parser.
  if (value.includes(':')) return false
  const pathOnly = value.split('?')[0]
  return ROUTE_PREFIXES.some((prefix) => pathOnly.startsWith(prefix))
}

/** The same path with any `auto` parameter removed. See isAllowedRoutePath. */
function stripAuto(value) {
  const [pathOnly, query] = value.split('?')
  if (!query) return pathOnly
  const kept = query
    .split('&')
    .filter((pair) => pair !== '' && pair.split('=')[0] !== 'auto')
    .join('&')
  return kept ? `${pathOnly}?${kept}` : pathOnly
}

/**
 * The renderer may name a FILE STEM and nothing else.
 *
 * It never supplies a directory. A renderer-chosen absolute path is an
 * arbitrary file write, and because the engine calls shell.openPath on the
 * result it is also an arbitrary file EXECUTE — write foo.bat, open it. There
 * is no version of accepting a path that is worth the convenience.
 */
function sanitisePdfStem(value) {
  const raw = typeof value === 'string' ? value : ''
  const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[.-]+/, '')
  const stem = cleaned.slice(0, 64)
  if (!stem || stem === '.' || stem === '..') return 'document'
  return stem.replace(/\.pdf$/i, '')
}

/** Bytes the engine will accept in one job. */
function checkBytes(bytes) {
  if (!bytes || typeof bytes.byteLength !== 'number') {
    return { ok: false, error: 'There was nothing to print.' }
  }
  if (bytes.byteLength === 0) return { ok: false, error: 'There was nothing to print.' }
  /* Not 32KB: a slip with a raster logo (GS v 0) is comfortably 50-100KB, and a
     label sheet is larger still. The cap is here to stop a runaway, not to
     express an opinion about slips. */
  if (bytes.byteLength > MAX_BYTES) return { ok: false, error: 'That print job is too large.' }
  return { ok: true }
}

/** 1 to 10. A typo that asks for 500 copies is a ream of paper. */
function normaliseCopies(value) {
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1) return 1
  return Math.min(n, 10)
}

const PAGE_SIZES = Object.freeze(['A4', 'A5', 'roll80'])

function normalisePageSize(value) {
  return typeof value === 'string' && PAGE_SIZES.includes(value) ? value : null
}

module.exports = {
  DEFAULT_PORTS,
  ROUTE_PREFIXES,
  MAX_BYTES,
  isAllowedPort,
  isHostname,
  normaliseTarget,
  isAllowedRoutePath,
  stripAuto,
  sanitisePdfStem,
  checkBytes,
  normaliseCopies,
  normalisePageSize,
}
