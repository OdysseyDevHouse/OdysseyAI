'use client'

import type { PrinterConnection } from '@/lib/printing/resolve'

/**
 * The desktop shell's print engine, as the renderer sees it.
 *
 * ── FEATURE DETECTION, NOT ASSUMPTION ─────────────────────────────────────
 *
 * `window.odyssey.printing` exists only in the packaged desktop build, and only
 * once that build carries the engine. Every accessor here answers honestly when
 * it is absent, because the three cases are genuinely different and the screen
 * says different things about each: a browser CANNOT reach a printer directly,
 * an older desktop build has not been updated yet, and a current one can.
 *
 * Nothing here throws. A print path that can fail by rejecting is a print path
 * that can take a sale down with it.
 */

/**
 * One OS print queue, as the operating system reports it.
 *
 * Richer than Electron's own `getPrintersAsync`, which on Windows answers the
 * NAME and nothing else — verified on a real machine: no status, no port, no
 * isDefault. electron/printQueues.js asks Windows properly instead, which is
 * what makes a useful dropdown possible at all.
 */
export type ShellPrinter = {
  name: string
  displayName: string
  /** The Windows port: 'USB001', 'ESDPRT001', 'IP_192.168.1.50', 'PORTPROMPT:'. */
  port: string
  driver: string
  /** How it looks to be wired, guessed from the port. Labelled as a guess. */
  kind: 'usb' | 'network' | 'shared' | 'other' | 'unknown'
  /** The IP behind a Standard TCP/IP port, when there is one. */
  address: string | null
  /**
   * Why it is not ready, in a word — 'Paused', 'Offline', 'Out of paper'.
   *
   * Null when it is fine. A paused or offline queue accepts every job and
   * prints none of them, forever, with no error anywhere: this is the only
   * thing that will ever say so.
   */
  statusText: string | null
  shared: boolean
  /** The share name, for the raw UNC fallback. Read, never typed. */
  shareName: string
  isDefault: boolean
  /**
   * TRUE for "Microsoft Print to PDF", the XPS writer, OneNote and Fax.
   *
   * They look like printers and are not. Printing to one with `silent: true`
   * opens a modal Save-As dialog on a window nobody can see, which presents as
   * the app hanging for no reason. Classified from the PORT rather than the
   * name, because a name is localised. The engine refuses them; the picker
   * marks them so nobody tries.
   */
  isVirtual: boolean
}

export type ShellTarget =
  | { transport: 'tcp'; host: string; port?: number | null }
  | { transport: 'queue'; name: string; shareName?: string }

export type ShellResult = { ok: true } | { ok: false; error: string }

type ShellPrinting = {
  listPrinters: () => Promise<{ ok: true; printers: ShellPrinter[] } | { ok: false; error: string }>
  sendRaw: (target: ShellTarget, bytes: Uint8Array) => Promise<ShellResult>
  printRoute: (
    target: ShellTarget,
    path: string,
    options?: { copies?: number; pageSize?: 'A4' | 'A5' | 'roll80' },
  ) => Promise<ShellResult>
  toPdf: (
    source: { kind: 'route'; path: string } | { kind: 'bytes'; bytes: Uint8Array },
    options?: { name?: string; open?: boolean },
  ) => Promise<{ ok: true; path: string; opened: boolean } | { ok: false; error: string }>
  probe: (target: ShellTarget) => Promise<ShellResult>
}

function api(): ShellPrinting | null {
  if (typeof window === 'undefined') return null
  const shell = (window as unknown as { odyssey?: { printing?: ShellPrinting } }).odyssey
  return shell?.printing ?? null
}

/** Whether this machine can reach a printer without going through a dialog. */
export function shellCanPrint(): boolean {
  return api() !== null
}

/**
 * The OS print queues on this machine.
 *
 * Returns null — not an empty array — when there is no engine to ask. The
 * difference matters to the setup screen: an empty list means "this machine has
 * no printers installed", and null means "we cannot know", and only one of
 * those should turn a dropdown back into a free-text box.
 */
export async function shellPrinters(): Promise<ShellPrinter[] | null> {
  const printing = api()
  if (!printing) return null
  try {
    const result = await printing.listPrinters()
    return result.ok ? result.printers : null
  } catch {
    return null
  }
}

/** Can this machine open that target? Behind the setup screen's Test button. */
export async function shellProbe(target: ShellTarget): Promise<ShellResult> {
  const printing = api()
  if (!printing) return { ok: false, error: 'This machine has no print engine.' }
  try {
    return await printing.probe(target)
  } catch {
    return { ok: false, error: 'The print engine did not answer.' }
  }
}

/** Raw ESC/POS to a target. The offline-safe path — no HTTP, no database. */
export async function shellSendRaw(target: ShellTarget, bytes: Uint8Array): Promise<ShellResult> {
  const printing = api()
  if (!printing) return { ok: false, error: 'This machine cannot send data straight to a printer.' }
  try {
    return await printing.sendRaw(target, bytes)
  } catch {
    return { ok: false, error: 'The print engine did not answer.' }
  }
}

/**
 * Turns a resolved connection into something the engine will accept.
 *
 * The one place the database's vocabulary ('usb', 'network') becomes the
 * engine's ('queue', 'tcp'). Keeping the two apart is deliberate: the database
 * describes what a shop plugged in, and the engine describes how bytes travel,
 * and they are not the same list — a networked printer reached through a
 * Windows queue is 'usb' to one and 'queue' to the other.
 */
export function shellTargetFor(printer: {
  connection: PrinterConnection
  target: string
  shareName?: string
  port?: number | null
}): ShellTarget | null {
  if (!printer.target) return null
  if (printer.connection === 'network') {
    return { transport: 'tcp', host: printer.target, port: printer.port ?? null }
  }
  return { transport: 'queue', name: printer.target, shareName: printer.shareName || undefined }
}
