// Minimal surface. The renderer is the same Next app the browser runs, so it
// must not depend on anything here — this only exposes facts the web build can
// read from NEXT_PUBLIC_APP_MODE instead.
const { contextBridge, ipcRenderer } = require('electron')
const { app } = require('electron')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

/**
 * A stable id for THIS installation, so a till can claim itself without anyone
 * picking from a list.
 *
 * A generated UUID kept in userData, NOT a hardware fingerprint: fingerprints
 * change when a disk or a driver does, and a till that silently loses its
 * identity after a Windows update is worse than one that asks a question once.
 *
 * It is an identifier, not a credential. The server re-validates the terminal
 * claim on every sale, so this only decides whether the user gets asked.
 */
function machineId() {
  try {
    const file = path.join(app.getPath('userData'), 'device-id')
    if (fs.existsSync(file)) {
      const existing = fs.readFileSync(file, 'utf8').trim()
      if (existing) return existing
    }
    const generated = crypto.randomUUID()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, generated, 'utf8')
    return generated
  } catch {
    // Read-only install or a locked profile. The browser fallback in
    // lib/deviceId.ts takes over, so the app still works.
    return null
  }
}

const { appRole } = require('./appRole')

contextBridge.exposeInMainWorld('odyssey', {
  isDesktop: true,
  platform: process.platform,
  version: process.env.npm_package_version || null,
  machineId: machineId(),
  /**
   * Which installer produced this app: 'backoffice' | 'pos' | 'database'.
   *
   * The renderer uses it to hide what this machine cannot do — a till build has
   * no back office to send anybody to, so a "Back office" button on it is a
   * dead end dressed up as an escape hatch.
   *
   * Presentation only. The till build's real constraint is the will-navigate
   * guard in main.js, and the actual authority is capabilities on the server.
   * A browser reads undefined here and keeps every button, which is right: the
   * web build genuinely does have a back office.
   */
  role: appRole(),
  /**
   * Is this a developer's checkout rather than an installed copy?
   *
   * Decided by `app.isPackaged` — but in MAIN, and relayed here through the
   * environment, because `app` does not exist in a preload. `require('electron')`
   * in this process answers with the renderer's half of the module and nothing
   * else: nativeImage, shell, clipboard, contextBridge, crashReporter,
   * ipcRenderer, webFrame, webUtils. Reading `app.isPackaged` here throws, and a
   * throw at this point takes `window.odyssey` with it — every consumer then
   * decides it is running in a browser.
   *
   * Nothing else may turn this on. main.js DELETES the variable in a packaged
   * build before any window exists, so a stray `ODYSSEY_DEV=1` in a customer's
   * environment cannot reach the renderer — which matters, because what this
   * gates is a sign-in form that fills itself in.
   *
   * A browser reads undefined, which is the honest answer: there is no shell
   * here to be running in debug.
   */
  isDev: process.env.ODYSSEY_DEV === '1',
  /**
   * Odyssey Database Setup's own channels, and the first IPC in this app.
   *
   * ── A NAMED SURFACE, NOT A GENERIC ONE ────────────────────────────────────
   *
   * Every method here is one verb the wizard needs. There is deliberately no
   * `invoke(channel, args)` escape hatch: a generic bridge means anything that
   * ends up running in the renderer — a dependency, an injected script — can
   * reach every handler the main process will ever have. The whole value of
   * contextIsolation is that the renderer's reach is a list somebody wrote
   * down.
   *
   * Present on every build, because preload has no cheap way to know the role
   * before appRole() resolves and a missing bridge is harder to diagnose than a
   * refused call. It is harmless elsewhere: nothing registers these handlers
   * unless the build is the installer, so calling one on a till rejects.
   *
   * Note what does NOT come back. `plan()` answers the redacted plan; the real
   * one, with the shop's database password in it, stays in main. See
   * electron/dbSetupBridge.js.
   */
  /**
   * What went wrong, for the app's own error screen.
   *
   * Present on every build. Absent in a browser, where the error screen falls
   * back to showing the digest alone — which is all the web build could offer
   * anyway.
   */
  diagnostics: {
    recentErrors: () => ipcRenderer.invoke('diagnostics:recent-errors'),
    logPath: () => ipcRenderer.invoke('diagnostics:log-path'),
    openLog: () => ipcRenderer.invoke('diagnostics:open-log'),
  },
  /**
   * Updates, for the technician standing at the machine.
   *
   * THREE VERBS, and the same rule as the bridges either side of this one:
   * one verb per thing the caller needs, and no `invoke(channel, args)`
   * escape hatch. `install` restarts the app, which is the strongest thing
   * anything in this file can do — a generic bridge would make that reachable
   * by any script the renderer ever loads.
   *
   * Present on every build, absent in a browser. The Updates screen checks
   * for it and shows the web build the one honest thing it can say: this copy
   * of Odyssey is served, not installed, so there is nothing to update.
   */
  updates: {
    state: () => ipcRenderer.invoke('updates:state'),
    check: () => ipcRenderer.invoke('updates:check'),
    install: () => ipcRenderer.invoke('updates:install'),
  },
  /**
   * The print engine: network, USB and PDF.
   *
   * FIVE VERBS, and the same rule as dbSetup above — one verb per thing the
   * caller needs, and no `invoke(channel, args)` escape hatch. The two arguments
   * that matter are validated in main rather than trusted here: a queue NAME
   * becomes an argv element handed to a spawned executable, and a route PATH
   * becomes a page this app renders with the operator's own session and can
   * write to disk. See electron/printTargets.js for what each check defends.
   *
   * Bytes cross as a Uint8Array over structured clone, not base64. The old HTTP
   * bridge base64-encoded because JSON cannot carry bytes; IPC can, and a 33%
   * size increase plus two string conversions on every slip buys nothing.
   *
   * Absent in a browser, which is the honest answer: a browser genuinely cannot
   * reach a printer, and lib/print/shell.ts says so on screen rather than
   * offering controls that will not work.
   */
  printing: {
    /** The OS print queues on this machine, for Setup → Printing. */
    listPrinters: () => ipcRenderer.invoke('printing:list-printers'),
    /** Raw ESC/POS to a network printer or a local queue. The offline-safe path. */
    sendRaw: (target, bytes) => ipcRenderer.invoke('printing:raw', { target, bytes }),
    /** Render one of this app's own (print) routes and send it to a queue. */
    printRoute: (target, path, options) =>
      ipcRenderer.invoke('printing:route', { target, path, options }),
    /** A PDF, from a (print) route or from bytes the caller already holds. */
    toPdf: (source, options) => ipcRenderer.invoke('printing:pdf', { source, options }),
    /** Can this machine reach that target? Behind the setup screen's test. */
    probe: (target) => ipcRenderer.invoke('printing:probe', { target }),
  },
  dbSetup: {
    signIn: (email, password) => ipcRenderer.invoke('db-setup:sign-in', { email, password }),
    sites: () => ipcRenderer.invoke('db-setup:sites'),
    plan: (siteId, allowFrom) => ipcRenderer.invoke('db-setup:plan', { siteId, allowFrom }),
    provision: () => ipcRenderer.invoke('db-setup:provision'),
    createOwner: (name, pin) => ipcRenderer.invoke('db-setup:create-owner', { name, pin }),
    /**
     * Progress lines while the database installs.
     *
     * Returns its own unsubscribe rather than exposing removeListener: handing
     * the renderer a way to detach arbitrary listeners is the same generic
     * reach the rest of this surface avoids. The callback is wrapped so the
     * Electron event object — which carries a `sender` — never reaches renderer
     * code.
     */
    onProgress: (callback) => {
      const handler = (_event, message) => callback(String(message))
      ipcRenderer.on('db-setup:progress', handler)
      return () => ipcRenderer.removeListener('db-setup:progress', handler)
    },
  },
})
