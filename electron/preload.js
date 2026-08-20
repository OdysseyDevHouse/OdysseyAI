// Minimal surface. The renderer is the same Next app the browser runs, so it
// must not depend on anything here — this only exposes facts the web build can
// read from NEXT_PUBLIC_APP_MODE instead.
const { contextBridge } = require('electron')
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
})
