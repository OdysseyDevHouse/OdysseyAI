'use server'

import { revalidatePath } from 'next/cache'
import { actorFor } from '@/lib/auth'
import {
  copyPrintingSetup,
  forgetDevice,
  getDevice,
  renameDevice,
  setDevicePdfDir,
} from '@/lib/site/devices'
import {
  clearDocumentPrinter,
  setDocumentPrinter,
  type PrintMode,
} from '@/lib/site/documentPrinters'
import { getPrintDoc } from '@/lib/printing/documents'

/**
 * PER-MACHINE printer setup.
 *
 * ── WHY THESE ARE SERVER ACTIONS AND NOT localStorage ─────────────────────
 *
 * This is the whole point of the feature. Held in the browser — which is where
 * `printBridge.ts` held it — a manager could not see a till's setup, let alone
 * fix it, and a re-imaged machine silently forgot where its slips came out.
 * Because every write here is keyed on a UUID rather than on "whoever is
 * calling", one person at one desk can set up every machine in the shop.
 *
 * ── THE deviceId IS RE-VALIDATED, EVERY TIME ──────────────────────────────
 *
 * The server can never derive which machine is calling; the id is always a
 * client-supplied parameter. So every action checks its SHAPE and then checks
 * that the machine is one THIS SITE knows — the second half being what stops a
 * well-formed id from another shop creating rows here.
 *
 * It is not a credential and is not treated as one (lib/deviceId.ts says so of
 * itself). Anyone who can call these can rewrite another machine's printer
 * setup by naming its id; `setup.edit` keeps that inside the shop, and the
 * blast radius is which printer a document comes out of.
 */

export type ActionResult = { ok: true; message: string } | { ok: false; error: string }

/** The shape check plus "and this site knows it", in one place. */
async function knownDevice(
  siteId: number,
  deviceId: string,
): Promise<{ ok: true; label: string } | { ok: false; error: string }> {
  const device = await getDevice(siteId, deviceId)
  if (!device) return { ok: false, error: 'That machine is not set up here.' }
  return { ok: true, label: device.label || device.terminal?.name || 'this machine' }
}

/* ── What a machine prints where ─────────────────────────────────────────── */

export async function setDocumentPrinterAction(
  deviceId: string,
  docKey: string,
  input: { mode: PrintMode; printerId?: number | null; copies?: number },
): Promise<ActionResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  const known = await knownDevice(ctx.siteId, deviceId)
  if (!known.ok) return known

  const result = await setDocumentPrinter(ctx.siteId, deviceId, docKey, input)
  if (!result.ok) return result

  revalidatePath('/setup/printing')

  /* The message names the OUTCOME rather than the act, because "Saved" leaves a
     manager to work out for themselves whether they just switched something
     off. The document's own label is used so the sentence reads the way the
     table does. */
  const label = getPrintDoc(docKey)?.label ?? 'That document'
  if (input.mode === 'pdf') return { ok: true, message: `${label} will be saved as a PDF.` }
  if (input.mode === 'browser') {
    return { ok: true, message: `${label} will use the browser’s print dialog.` }
  }
  if (input.mode === 'off') {
    return { ok: true, message: `Nothing on ${known.label} prints ${label.toLowerCase()}.` }
  }
  return { ok: true, message: `${label} prints on ${known.label}’s chosen printer.` }
}

/**
 * Puts a document back to "not set" on this machine.
 *
 * Deleting rather than saving 'browser'. The two behave identically today and
 * are different facts: "not set" is a shop that has not decided and should be
 * prompted, "browser" is a shop that decided and should be left alone.
 */
export async function clearDocumentPrinterAction(
  deviceId: string,
  docKey: string,
): Promise<ActionResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  const known = await knownDevice(ctx.siteId, deviceId)
  if (!known.ok) return known

  await clearDocumentPrinter(ctx.siteId, deviceId, docKey)
  revalidatePath('/setup/printing')
  return { ok: true, message: 'Cleared.' }
}

/* ── The machines themselves ─────────────────────────────────────────────── */

export async function renameDeviceAction(deviceId: string, label: string): Promise<ActionResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  const result = await renameDevice(ctx.siteId, deviceId, label)
  if (!result.ok) return result

  revalidatePath('/setup/printing')
  return { ok: true, message: `Now called ${label.trim()}.` }
}

/** Where this machine's PDFs land. Blank means the shell's own default. */
export async function setDevicePdfDirAction(deviceId: string, dir: string): Promise<ActionResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  const known = await knownDevice(ctx.siteId, deviceId)
  if (!known.ok) return known

  const result = await setDevicePdfDir(ctx.siteId, deviceId, dir)
  if (!result.ok) return result

  revalidatePath('/setup/printing')
  return { ok: true, message: dir.trim() ? 'PDFs will be saved there.' : 'Back to the default folder.' }
}

/**
 * Forgets a machine and its printer setup.
 *
 * Deletes rather than deactivates: a machine is referenced by nothing but its
 * own setup, so there is no history to strand. Its `terminals` row survives —
 * releasing a till is a separate act with licence consequences of its own.
 *
 * The machine reappears the next time it signs in, with nothing set up. That is
 * the point: it is how a shop clears out the staff phone that logged in once,
 * and how a mis-configured machine is started again from scratch.
 */
export async function forgetDeviceAction(deviceId: string): Promise<ActionResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  const known = await knownDevice(ctx.siteId, deviceId)
  if (!known.ok) return known

  const result = await forgetDevice(ctx.siteId, deviceId)
  if (!result.ok) return result

  revalidatePath('/setup/printing')
  return { ok: true, message: `Forgot ${known.label}.` }
}

/**
 * Copies one machine's whole printing setup onto another.
 *
 * The recovery path for the thing a UUID key cannot avoid — re-imaging a
 * machine gives it a new id, so its setup does not follow it — and the fast way
 * to set up the second, third and fourth till.
 *
 * Replaces wholesale rather than merging: a half-copied setup is one where some
 * documents point at the source machine's USB queue and some at the target's,
 * and nobody can tell by looking which is which.
 */
export async function copyPrintingSetupAction(
  fromDeviceId: string,
  toDeviceId: string,
): Promise<ActionResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  const from = await knownDevice(ctx.siteId, fromDeviceId)
  if (!from.ok) return from
  const to = await knownDevice(ctx.siteId, toDeviceId)
  if (!to.ok) return to

  const result = await copyPrintingSetup(ctx.siteId, fromDeviceId, toDeviceId)
  if (!result.ok) return result

  revalidatePath('/setup/printing')
  return { ok: true, message: `${to.label} now prints like ${from.label}.` }
}
