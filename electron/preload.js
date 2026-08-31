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
