// The print engine's Electron half: the OS printer list, a hidden window for
// rendered documents, PDFs, and the five `printing:*` handlers.
//
// ── WHAT THIS REPLACES ──────────────────────────────────────────────────────
//
// scripts/print-bridge.mjs — a Node sidecar the shop had to install by hand,
// which the installer never shipped, which spoke TCP 9100 and nothing else, and
// which read its printers from a JSON file nobody in the back office could see.
// The transports moved into printTransports.js; what is new here is everything
// that needs a window: the real queue list, silent driver printing, and PDF.
//
// ── EVERY HANDLER RETURNS, NEVER THROWS ─────────────────────────────────────
//
// `{ ok: true, ... } | { ok: false, error }`, always. A rejected IPC promise on
// the path between a cashier and a slip is a promise that can take a sale down
// with it, and "the app froze at the counter" is not a bug report anybody can
// act on.
const { ipcMain, BrowserWindow, shell, app } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const targets = require('./printTargets')
const transports = require('./printTransports')
const printQueues = require('./printQueues')

let getOriginRef = () => null
let getWindowRef = () => null

/** The hidden render window, its idle timer, and the mutex over its one DOM. */
const state = {
  hidden: null,
  idleTimer: null,
  busy: Promise.resolve(),
  printers: null,
  printersAt: 0,
}

const HIDDEN_IDLE_MS = 5 * 60 * 1000
const PRINTER_CACHE_MS = 30 * 1000
const RENDER_TIMEOUT_MS = 10 * 1000

/*
 * Queues that look like printers and are not — the Save-As-dialog trap — are
 * classified in printQueues.js, from the PORT rather than the name, because a
 * name is localised and a port is not. Deny-listed on THIS side of the bridge
 * and not only in the setup screen, because this is the side that receives an
 * untrusted name.
 */

/** Where a raw-print helper lives, packaged and from source. */
function helperPath() {
  if (process.platform !== 'win32') return null
  return app.isPackaged
    ? path.join(process.resourcesPath, 'rawprint', 'odyssey-rawprint.exe')
    : path.join(__dirname, '..', 'build', 'rawprint', 'odyssey-rawprint.exe')
}

/* ── Discovery ─────────────────────────────────────────────────────────────── */

/**
 * The OS print queues, cached for thirty seconds.
 *
 * Cached because every raw and rendered job validates its queue name against
 * this list, and an uncached call would mean a round trip per receipt.
 *
 * ── getPrintersAsync IS ONLY THE FALLBACK ─────────────────────────────────
 *
 * Verified on a real Windows machine, it answers the NAME and nothing else:
 * `{ name, displayName, description: '', options: {} }`. No status, no port, no
 * isDefault, whatever the docs suggest. A picker built on that can only list
 * names, and the commonest cause of "it stopped printing" — a paused or offline
 * queue — is invisible.
 *
 * So printQueues.js asks Windows properly (Get-Printer) and this hands it the
 * names as a fallback for a machine where PowerShell is blocked by policy.
 */
async function listPrinters() {
  const now = Date.now()
  if (state.printers && now - state.printersAt < PRINTER_CACHE_MS) {
    return { ok: true, printers: state.printers }
  }

  /* Off the MAIN window when there is one: `getPrintersAsync` hangs off a
     webContents, and by the time the setup screen can ask, the main window
     exists by definition — it IS the setup screen. Creating the hidden window
     just to enumerate printers would cost ~50MB for a list. */
  const contents = getWindowRef()?.webContents ?? state.hidden?.webContents
  let names = []
  if (contents) {
    try {
      names = (await contents.getPrintersAsync()).map((p) => p.name)
    } catch {
      /* printQueues asks the operating system directly and does not need it. */
    }
  }

  try {
    state.printers = await printQueues.listQueues(names)
    state.printersAt = now
    return { ok: true, printers: state.printers }
  } catch (err) {
    return { ok: false, error: `Could not read this machine's printers — ${err.message}.` }
  }
}

/**
 * The membership check, and the most valuable line in this file.
 *
 * It turns an arbitrary renderer-chosen string — which is about to become an
 * argv element handed to a spawned executable — into a choice from a list the
 * operating system itself produced. It also eliminates the whole "a queue name
 * with a quote in it" class, and gives a readable error instead of a silent
 * failure.
 */
async function checkQueue(name) {
  const list = await listPrinters()
  if (!list.ok) return list
  const match = list.printers.find((p) => p.name === name)
  if (!match) return { ok: false, error: `This machine has no printer called “${name}”.` }
  if (match.isVirtual) {
    return { ok: false, error: `“${name}” is not a real printer — it would ask where to save the file.` }
  }
  return { ok: true, printer: match }
}

/* ── The hidden window ─────────────────────────────────────────────────────── */

/**
 * The window rendered documents are laid out in.
 *
 * Five settings here are load-bearing and none is incidental:
 *
 *   A REAL WIDTH AND HEIGHT   `show: false` alone is not enough. A window with
 *                             no box does not lay out, and a document that has
 *                             not laid out prints blank — the same warning
 *                             usePrintDocument.ts already carries about its
 *                             off-screen iframe.
 *   NO `partition`            THIS IS HOW IT AUTHENTICATES. odyssey_session is
 *                             httpOnly and odyssey_wid is a plain cookie; both
 *                             live in the DEFAULT session's jar, which every
 *                             BrowserWindow without a partition shares. Adding
 *                             `partition: 'print'` "for isolation" turns every
 *                             print into a redirect to the login page, and
 *                             because we refuse anything that is not a 200 the
 *                             symptom is "printing stopped working" with no
 *                             other clue.
 *   NO preload                A page we drive by path has no business holding
 *                             window.odyssey.
 *   `sandbox: true`           Available precisely BECAUSE there is no preload.
 *                             The main window cannot have it — its preload needs
 *                             node:fs and node:crypto.
 *   backgroundThrottling off  A hidden window is a backgrounded one, and
 *                             Chromium throttles its timers to about 1Hz.
 *
 * `offscreen: true` is deliberately NOT used: it has long-standing printing
 * quirks and buys nothing over a window that is already invisible.
 *
 * Created IN MAIN rather than opened from the renderer, which is why it never
 * reaches main.js's setWindowOpenHandler, and why the till build's
 * `will-navigate` guard — attached to the main window's webContents alone —
 * does not apply to it. That is a consequence to rely on, not luck.
 */
function hiddenWindow() {
  if (state.hidden && !state.hidden.isDestroyed()) {
    resetIdle()
    return state.hidden
  }

  const win = new BrowserWindow({
    show: false,
    width: 1240,
    height: 1754, // A4 at ~150dpi, so a full page lays out before it is printed.
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  })

  /* A rendered page must not be able to walk this window somewhere else between
     loading and printing. */
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  state.hidden = win
  resetIdle()
  return win
}

function resetIdle() {
  if (state.idleTimer) clearTimeout(state.idleTimer)
  state.idleTimer = setTimeout(() => {
    /* ~50MB back on a till that prints twice an hour. It is recreated on demand,
       and creating it costs a few hundred milliseconds once. */
    if (state.hidden && !state.hidden.isDestroyed()) state.hidden.destroy()
    state.hidden = null
  }, HIDDEN_IDLE_MS)
  if (state.idleTimer.unref) state.idleTimer.unref()
}

/** One hidden-window job at a time — it has exactly one DOM. */
function exclusive(fn) {
  const run = state.busy.then(fn, fn)
  state.busy = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/**
 * Loads a (print) route into the hidden window and waits for it to be ready.
 *
 * ── THE THREE SIGNALS, AND WHY NOT THE 150ms BEAT ─────────────────────────
 *
 * The browser fallback waits 150ms and hopes. It has to: a page cannot ask the
 * main process anything. Here we can do better, and the better answer is also
 * the one that stops a login page reaching paper.
 *
 *   1. `did-navigate` carries the HTTP STATUS and the final URL. Anything that
 *      is not 200 at the path we asked for is refused. A redirect to `/` is the
 *      login page — the session died, or the operator lacks the capability the
 *      route requires — and silently printing THAT is worse than not printing,
 *      because nobody notices.
 *   2. `document.fonts.ready` then one `requestAnimationFrame`. This is the
 *      actual thing 150ms was guessing at, and it returns `scrollHeight` in the
 *      same round trip — which the slip PDF path needs to size its page.
 *   3. A ten-second cap, so a route that hangs on an unreachable database does
 *      not hang the till with it.
 */
async function loadRoute(win, routePath) {
  const origin = getOriginRef()
  if (!origin) return { ok: false, error: 'The app is still starting.' }

  const clean = targets.stripAuto(routePath)
  const url = new URL(clean, origin)
  const wanted = url.pathname

  const navigation = new Promise((resolve) => {
    const onNavigate = (_event, navigatedUrl, statusCode) => {
      win.webContents.removeListener('did-navigate', onNavigate)
      resolve({ navigatedUrl, statusCode })
    }
    win.webContents.on('did-navigate', onNavigate)
  })

  const timeout = new Promise((resolve) =>
    setTimeout(() => resolve({ timedOut: true }), RENDER_TIMEOUT_MS),
  )

  try {
    void win.loadURL(url.toString()).catch(() => undefined)
    const outcome = await Promise.race([navigation, timeout])

    if (outcome.timedOut) {
      return { ok: false, error: 'The document did not finish rendering in ten seconds.' }
    }
    if (Number(outcome.statusCode) !== 200) {
      return {
        ok: false,
        error: 'The document could not be loaded — the shop database may be unreachable.',
      }
    }
    if (new URL(outcome.navigatedUrl).pathname !== wanted) {
      /* We asked for a document and were handed something else. In practice
         that is the sign-in page, which must never reach paper or a PDF. */
      return { ok: false, error: 'The document could not be opened — you may need to sign in again.' }
    }

    const height = await Promise.race([
      win.webContents.executeJavaScript(
        `document.fonts.ready.then(() => new Promise((r) => requestAnimationFrame(() => r(document.documentElement.scrollHeight))))`,
      ),
      timeout.then(() => 0),
    ])
    return { ok: true, scrollHeight: Number(height) || 0 }
  } catch (err) {
    return { ok: false, error: `The document could not be rendered — ${err.message}.` }
  }
}

/* ── Where PDFs land ───────────────────────────────────────────────────────── */

/**
 * The output path. The renderer supplies a STEM and never a directory.
 *
 * `path.resolve` then a prefix check, so a stem that somehow survived
 * sanitisation still cannot escape the folder — belt and braces, because the
 * consequence of escaping is an arbitrary file write followed by shell.openPath
 * on the result.
 */
function pdfOutputPath(stem, dir) {
  const base = dir && dir.trim() ? dir.trim() : path.join(app.getPath('documents'), 'Odyssey')
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15)
  const file = path.resolve(base, `${targets.sanitisePdfStem(stem)}-${stamp}.pdf`)
  if (!file.startsWith(path.resolve(base) + path.sep)) {
    return path.resolve(base, `document-${stamp}.pdf`)
  }
  return file
}

/* ── The handlers ──────────────────────────────────────────────────────────── */

function register({ getOrigin, getWindow }) {
  getOriginRef = getOrigin
  getWindowRef = getWindow

  /** One line per job, so "it stopped printing at two o'clock" is answerable
   *  from a file a shop can email. Never the job's BYTES — a slip carries a
   *  customer's name and what they bought. */
  const note = (fields) => console.log('[print]', JSON.stringify(fields))

  ipcMain.handle('printing:list-printers', async () => listPrinters())

  ipcMain.handle('printing:raw', async (_event, args) => {
    const checked = targets.normaliseTarget(args?.target)
    if (!checked.ok) return checked

    const bytes = args?.bytes
    if (!ArrayBuffer.isView(bytes)) return { ok: false, error: 'There was nothing to print.' }
    const size = targets.checkBytes(bytes)
    if (!size.ok) return size

    const started = Date.now()
    const t = checked.target
    let result

    if (t.transport === 'tcp') {
      result = await transports.sendTcp(t.host, t.port, bytes)
    } else {
      /* The OS's own list decides, BEFORE anything is spawned. */
      const queue = await checkQueue(t.name)
      if (!queue.ok) return queue
      /* Logged, not refused. A queue that says "Offline" often prints anyway —
         a thermal printer reports it whenever it is between jobs — so blocking
         on it would stop a shop trading over a status word. What it buys is the
         line in the log that answers "it stopped printing at two o'clock". */
      if (queue.printer.statusText) {
        note({ op: 'raw', target: t.name, status: queue.printer.statusText, result: 'queue-not-ready' })
      }
      result = await transports.sendQueueRaw(t.name, bytes, {
        helperPath: helperPath(),
        shareName: t.shareName,
      })
    }

    note({
      op: 'raw',
      transport: t.transport,
      target: t.transport === 'tcp' ? `${t.host}:${t.port}` : t.name,
      byteLength: bytes.byteLength,
      ms: Date.now() - started,
      result: result.ok ? 'sent' : result.error,
    })
    return result
  })

  ipcMain.handle('printing:route', async (_event, args) => {
    const checked = targets.normaliseTarget(args?.target)
    if (!checked.ok) return checked
    if (checked.target.transport !== 'queue') {
      return { ok: false, error: 'A rendered document needs a printer this machine has installed.' }
    }
    if (!targets.isAllowedRoutePath(args?.path)) {
      return { ok: false, error: 'That is not a document this app prints.' }
    }
    const queue = await checkQueue(checked.target.name)
    if (!queue.ok) return queue

    const copies = targets.normaliseCopies(args?.options?.copies)
    const pageSize = targets.normalisePageSize(args?.options?.pageSize)

    return exclusive(async () => {
      const started = Date.now()
      const win = hiddenWindow()
      const loaded = await loadRoute(win, args.path)
      if (!loaded.ok) return loaded

      const result = await new Promise((resolve) => {
        win.webContents.print(
          {
            silent: true,
            deviceName: checked.target.name,
            /* NOT optional. (print)/print.css re-asserts the light tokens and
               sets print-color-adjust: exact precisely so tints and rules
               survive — and Chromium defaults this to false, which drops a
               table header's fill and takes the document's structure with it. */
            printBackground: true,
            margins: { marginType: 'none' },
            copies,
            ...(pageSize === 'A4' || pageSize === 'A5' ? { pageSize } : {}),
            /* Microns for print(), inches for printToPDF(). The two APIs
               disagree, and passing one to the other asks for an 80,000-inch
               page. See ROLL80_MICRONS below. */
            ...(pageSize === 'roll80' ? { pageSize: ROLL80_MICRONS } : {}),
          },
          (success, failureReason) =>
            resolve(
              success
                ? { ok: true }
                : { ok: false, error: failureReason || 'The printer refused the job.' },
            ),
        )
      })

      note({
        op: 'route',
        target: checked.target.name,
        path: targets.stripAuto(args.path),
        copies,
        ms: Date.now() - started,
        result: result.ok ? 'spooled' : result.error,
      })
      return result
    })
  })

  ipcMain.handle('printing:pdf', async (_event, args) => {
    const source = args?.source
    const file = pdfOutputPath(args?.options?.name, args?.options?.dir)

    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
    } catch (err) {
      return { ok: false, error: `Could not create the folder for PDFs — ${err.message}.` }
    }

    /* Bytes the caller already holds — an existing pdfkit route. Preferred
       wherever one exists: that is the canonical, correctly paginated document
       that also gets emailed, and rendering the HTML instead would produce a
       second, subtly different artefact for the same invoice. */
    if (source?.kind === 'bytes') {
      if (!ArrayBuffer.isView(source.bytes)) return { ok: false, error: 'There was nothing to save.' }
      const size = targets.checkBytes(source.bytes)
      if (!size.ok) return size
      try {
        fs.writeFileSync(file, Buffer.from(source.bytes.buffer, source.bytes.byteOffset, source.bytes.byteLength))
      } catch (err) {
        return { ok: false, error: `Could not save the PDF — ${err.message}.` }
      }
      return openPdf(file, args?.options?.open !== false, note)
    }

    if (source?.kind !== 'route' || !targets.isAllowedRoutePath(source.path)) {
      return { ok: false, error: 'That is not a document this app prints.' }
    }

    return exclusive(async () => {
      const win = hiddenWindow()
      const loaded = await loadRoute(win, source.path)
      if (!loaded.ok) return loaded

      const pageSize = targets.normalisePageSize(args?.options?.pageSize)
      try {
        const data = await win.webContents.printToPDF({
          printBackground: true,
          margins: { top: 0, bottom: 0, left: 0, right: 0 },
          ...(pageSize === 'roll80'
            ? {
                /* INCHES here. Chromium will not honour `@page { size: 80mm auto }`
                   because there is no auto page height, so the height comes from
                   the scrollHeight the readiness probe already measured. A blank
                   render must not become a zero-height page, which Chromium
                   rejects outright — hence the floor. */
                pageSize: { width: ROLL80_INCHES, height: Math.max(loaded.scrollHeight / 96 + 0.1, 1) },
              }
            : {
                pageSize: pageSize === 'A5' ? 'A5' : 'A4',
                /* What makes @page { size: A4 } in document-a4.css actually win. */
                preferCSSPageSize: true,
              }),
        })
        fs.writeFileSync(file, data)
      } catch (err) {
        return { ok: false, error: `Could not make the PDF — ${err.message}.` }
      }
      return openPdf(file, args?.options?.open !== false, note)
    })
  })

  ipcMain.handle('printing:probe', async (_event, args) => {
    const checked = targets.normaliseTarget(args?.target)
    if (!checked.ok) return checked
    const t = checked.target
    if (t.transport === 'tcp') return transports.probeTcp(t.host, t.port)
    const queue = await checkQueue(t.name)
    if (!queue.ok) return queue
    if (queue.printer.statusText) {
      return { ok: false, error: `“${t.name}” is ${queue.printer.statusText.toLowerCase()}.` }
    }
    return { ok: true }
  })
}

/** 80mm, in each API's own unit. Named so the two can never be swapped. */
const ROLL80_MICRONS = { width: 80000, height: 297000 }
const ROLL80_INCHES = 3.15

/**
 * Opens the finished PDF.
 *
 * `shell.openPath` returns a STRING — empty on success, an error message
 * otherwise. It is not a boolean, and treating it as truthy inverts the check:
 * every successful save would report failure. On a machine with no PDF
 * association it fails (or Windows shows its "how do you want to open this"
 * chooser), so we fall back to revealing the file and say so plainly rather
 * than claiming a viewer opened.
 */
async function openPdf(file, wantOpen, note) {
  if (!wantOpen) {
    note({ op: 'pdf', path: file, result: 'saved' })
    return { ok: true, path: file, opened: false }
  }
  try {
    const problem = await shell.openPath(file)
    if (problem) {
      shell.showItemInFolder(file)
      note({ op: 'pdf', path: file, result: `saved, not opened: ${problem}` })
      return { ok: true, path: file, opened: false }
    }
  } catch {
    shell.showItemInFolder(file)
    return { ok: true, path: file, opened: false }
  }
  note({ op: 'pdf', path: file, result: 'opened' })
  return { ok: true, path: file, opened: true }
}

/**
 * Lets go of the hidden window.
 *
 * Called from before-quit: a held webContents keeps the process alive past the
 * point where the Next server has closed, and a till that will not shut down is
 * a till somebody power-cycles.
 */
function shutdown() {
  if (state.idleTimer) clearTimeout(state.idleTimer)
  if (state.hidden && !state.hidden.isDestroyed()) state.hidden.destroy()
  state.hidden = null
}

module.exports = { register, shutdown, pdfOutputPath, ROLL80_MICRONS, ROLL80_INCHES }
