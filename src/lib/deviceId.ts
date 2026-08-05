'use client'

/**
 * This machine's identity, for claiming a till.
 *
 * Electron's preload exposes a stable id persisted in the app's userData
 * directory; a browser has no such thing, so one is generated and kept in
 * localStorage. Both are just identifiers — NOT credentials. The server
 * re-validates the terminal claim on every sale, so a spoofed id buys nothing
 * beyond skipping a picker.
 *
 * A generated UUID rather than hardware fingerprinting: fingerprints change
 * when a disk or a driver does, and a till that silently loses its identity
 * after a Windows update is worse than one that asks a question once.
 */

const STORAGE_KEY = 'odyssey.device.id'

type OdysseyBridge = {
  isDesktop?: boolean
  platform?: string
  machineId?: string
}

function bridge(): OdysseyBridge | undefined {
  if (typeof window === 'undefined') return undefined
  return (window as unknown as { odyssey?: OdysseyBridge }).odyssey
}

/**
 * The id, preferring the desktop shell's.
 *
 * Returns null during SSR so a caller can render the picker without guessing —
 * the machine identity is only knowable in the browser.
 */
export function deviceId(): string | null {
  if (typeof window === 'undefined') return null

  const fromShell = bridge()?.machineId
  if (fromShell) return fromShell

  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    if (stored) return stored

    const generated = crypto.randomUUID()
    window.localStorage.setItem(STORAGE_KEY, generated)
    return generated
  } catch {
    // Private browsing, or storage disabled. The user gets asked every time,
    // which is inconvenient but still works.
    return null
  }
}

/** Something recognisable in the setup list — "Desktop (win32)" or "Browser". */
export function deviceLabel(): string {
  const shell = bridge()
  if (shell?.isDesktop) return `Desktop (${shell.platform ?? 'unknown'})`
  if (typeof navigator === 'undefined') return 'Unknown'

  const ua = navigator.userAgent
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Chrome\//.test(ua)
      ? 'Chrome'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Browser'
  const platform = /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : ''
  return platform ? `${browser} on ${platform}` : browser
}

export function isDesktopShell(): boolean {
  return bridge()?.isDesktop === true
}
