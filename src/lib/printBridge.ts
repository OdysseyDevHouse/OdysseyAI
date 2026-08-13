'use client'

/**
 * Talking to the local print bridge (scripts/print-bridge.mjs).
 *
 * A PER-MACHINE configuration, in localStorage — the same reasoning as the
 * terminal claim: only this machine knows what is plugged into it, and two
 * tills legitimately point at two different bridges (or one shared one).
 *
 * Every call has a short timeout. The bridge is loopback (or LAN) — a slow
 * bridge is a dead bridge, and a till must never hang on a print.
 */

const KEY = 'pos-print-bridge'

export type PrintBridgeConfig = {
  /** 'http://127.0.0.1:9723' — or a LAN peer's bridge when tills share one. */
  url: string
  /** The bridge's name for the slip printer. Empty = no slip printing. */
  receiptPrinter: string
  /** The bridge's name for the kitchen printer. Empty = no kitchen tickets. */
  kitchenPrinter: string
  /** 48 for 80mm Font A; 42 for the narrower heads. */
  columns: 42 | 48
  /** Whether this till sends the drawer-kick pulse at all. */
  drawerKick: boolean
}

export function bridgeConfig(): PrintBridgeConfig | null {
  try {
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<PrintBridgeConfig>
    if (!parsed.url) return null
    return {
      url: String(parsed.url).replace(/\/$/, ''),
      receiptPrinter: String(parsed.receiptPrinter ?? ''),
      kitchenPrinter: String(parsed.kitchenPrinter ?? ''),
      columns: parsed.columns === 42 ? 42 : 48,
      drawerKick: parsed.drawerKick !== false,
    }
  } catch {
    return null
  }
}

export function saveBridgeConfig(config: PrintBridgeConfig | null): void {
  try {
    if (config) window.localStorage.setItem(KEY, JSON.stringify(config))
    else window.localStorage.removeItem(KEY)
  } catch {
    // Storage blocked — the setup page's own save toast will still read ok,
    // but bridgeConfig() returns null; the test button is what reveals it.
  }
}

export type BridgeHealth = { ok: true; version: string; printers: string[] } | { ok: false; error: string }

export async function bridgeHealth(url: string): Promise<BridgeHealth> {
  try {
    const response = await fetch(`${url.replace(/\/$/, '')}/health`, {
      signal: AbortSignal.timeout(2000),
    })
    const body = (await response.json()) as { ok?: boolean; version?: string; printers?: string[] }
    if (!body.ok) return { ok: false, error: 'The bridge answered but is not healthy.' }
    return { ok: true, version: String(body.version ?? '?'), printers: body.printers ?? [] }
  } catch {
    return {
      ok: false,
      error: 'No bridge answered. Is print-bridge.mjs running on this machine?',
    }
  }
}

/** Base64 without spreading a large array into String.fromCharCode's arguments. */
function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

export async function printRaw(
  printer: 'receipt' | 'kitchen',
  bytes: Uint8Array,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const config = bridgeConfig()
  if (!config) return { ok: false, error: 'No print bridge is set up on this machine.' }
  const name = printer === 'receipt' ? config.receiptPrinter : config.kitchenPrinter
  if (!name) {
    return {
      ok: false,
      error: `No ${printer} printer is set on this machine — Setup → Printing.`,
    }
  }

  try {
    const response = await fetch(`${config.url}/print`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ printer: name, dataBase64: toBase64(bytes) }),
      signal: AbortSignal.timeout(5000),
    })
    const body = (await response.json()) as { ok?: boolean; error?: string }
    return body.ok ? { ok: true } : { ok: false, error: body.error ?? 'The bridge refused the job.' }
  } catch {
    return { ok: false, error: 'The print bridge did not answer.' }
  }
}
