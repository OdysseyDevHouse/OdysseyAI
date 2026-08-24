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

    const generated = newId()
    window.localStorage.setItem(STORAGE_KEY, generated)
    return generated
  } catch {
    // Private browsing, or storage disabled. The user gets asked every time,
    // which is inconvenient but still works.
    return null
  }
}

/**
 * A fresh id, on an origin that may not be secure.
 *
 * `crypto.randomUUID` is SECURE-CONTEXT ONLY. On plain http over a LAN — a shop
 * whose server is a PC in the back room, or an office trying the app out before
 * it is published — `crypto` exists but `randomUUID` is undefined, so calling it
 * throws. That threw inside the caller's try/catch and came back as `null`,
 * which reads as "this browser blocks storage": the licence check is skipped
 * entirely, no machine can claim a till, and Setup → Tills shows no device
 * number to link. A whole feature, absent, for a reason nothing on screen names.
 *
 * So it degrades instead, exactly as `windowSession.ts`, `parkOffline.ts` and
 * `finaliseOffline.ts` already do — and for the reason this module's own note
 * gives: the id is an IDENTIFIER, never a credential. The server re-validates
 * every terminal claim, so an id from a weaker source buys nobody anything. What
 * matters is that it is stable, and localStorage is what makes it stable.
 *
 * Genuinely no storage still returns null, from the caller's catch. That case is
 * real and separate, and the till is allowed through unlicensed for it.
 */
function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(16)
    crypto.getRandomValues(bytes)
    /* Stamped as a v4 UUID because the column and every screen that prints a
       device number expect that shape — the bytes are random either way. */
    bytes[6] = (bytes[6] & 0x0f) | 0x40
    bytes[8] = (bytes[8] & 0x3f) | 0x80
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }
  const rand = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('')
  return `${rand(8)}-${rand(4)}-4${rand(3)}-8${rand(3)}-${rand(12)}`
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
