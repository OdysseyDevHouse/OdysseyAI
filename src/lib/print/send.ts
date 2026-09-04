'use client'

import { shellSendRaw, shellTargetFor, shellCanPrint } from './shell'
import { planForDoc } from './deviceConfig'

/**
 * The one place a document becomes bytes on a wire.
 *
 * ── THE RESOLUTION ORDER, AND WHY IT IS THIS WAY ROUND ────────────────────
 *
 * The DEVICE CONFIG decides first, then the shell. Not "the shell if present" —
 * a shop's setup can deliberately point a machine at a printer, or deliberately
 * say a document does not print here, and preferring the local engine because
 * it happens to exist would quietly overrule both.
 *
 * ── EVERY OUTCOME IS NAMED ────────────────────────────────────────────────
 *
 * `off`, `unreachable` and "no engine" are three different situations and a
 * shop fixes each in a different place. Collapsing them into "printing failed"
 * is how a manager ends up believing the assignment took effect.
 */

/**
 * Discriminated on `reason`, so a caller can narrow it in one `switch`.
 *
 * An earlier shape used optional `silent` and `fallback` flags, which TypeScript
 * could not narrow — every caller ended up reaching for `'error' in result`.
 * Three failures that a shop fixes in three different places deserve three
 * names, and the compiler should be the thing that makes a caller handle each.
 */
export type SendResult =
  /** Bytes left for the printer. NOT "it printed" — nothing can tell you that. */
  | { ok: true }
  /** Deliberately not printed here. Say nothing at all; the shop chose this. */
  | { ok: false; reason: 'off' }
  /** Nothing can print it without a dialog. Fall back to the (print) route. */
  | { ok: false; reason: 'browser' }
  /** It should have printed and did not. Show this. */
  | { ok: false; reason: 'error'; error: string }

/**
 * Sends raw ESC/POS for one document.
 *
 * THE OFFLINE-SAFE PATH. The bytes are a pure function over data already in
 * this browser's memory, and the shell opens a LAN socket or a spooler handle —
 * no HTTP, no database, no server component anywhere in it. A till with the
 * shop's server unreachable still prints a complete slip, which is the whole
 * reason the raw branch must stay ahead of the rendered one.
 */
export async function sendRawFor(docKey: string, bytes: Uint8Array): Promise<SendResult> {
  const plan = planForDoc(docKey)

  if (plan.kind === 'off') return { ok: false, reason: 'off' }
  if (plan.kind === 'unreachable') {
    return {
      ok: false,
      reason: 'error',
      error: `${plan.printerName} cannot be reached from this machine — Setup → Printing.`,
    }
  }
  if (plan.kind !== 'printer') return { ok: false, reason: 'browser' }

  const target = shellTargetFor(plan.printer)
  if (!target) {
    return {
      ok: false,
      reason: 'error',
      error: `${plan.printer.name} has no address on this machine — Setup → Printing.`,
    }
  }
  if (!shellCanPrint()) return { ok: false, reason: 'browser' }

  /* Copies are honoured by sending the job that many times. A raw ESC/POS
     stream has no notion of a copy count — the driver-rendered path gets one
     from Chromium, and this one does not. */
  for (let i = 0; i < plan.copies; i++) {
    const result = await shellSendRaw(target, bytes)
    if (!result.ok) return { ok: false, reason: 'error', error: result.error }
  }
  return { ok: true }
}

/**
 * Sends raw bytes to whatever prints the till slip, ignoring assignments.
 *
 * For the CASH DRAWER, which is not a document. The drawer is wired to the RJ11
 * on one printer, so "kick it" means "send these five bytes to that printer" —
 * there is no paper involved and nothing for the assignment table to say.
 */
export async function sendToSlipPrinter(bytes: Uint8Array): Promise<SendResult> {
  const plan = planForDoc('slip')
  if (plan.kind !== 'printer') return { ok: false, reason: 'browser' }
  const target = shellTargetFor(plan.printer)
  if (!target || !shellCanPrint()) return { ok: false, reason: 'browser' }
  const result = await shellSendRaw(target, bytes)
  return result.ok ? { ok: true } : { ok: false, reason: 'error', error: result.error }
}
