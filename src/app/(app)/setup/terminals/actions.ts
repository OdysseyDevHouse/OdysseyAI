'use server'

import { revalidatePath } from 'next/cache'
import { requireSiteId, actorFor } from '@/lib/auth'
import { POS_MODE_LABELS, type PosMode } from '@/lib/posMode'
import {
  createTerminal,
  updateTerminal,
  deleteTerminal,
  releaseTerminal,
  claimTerminal,
  type TerminalInput,
} from '@/lib/site/terminals'
import { releaseSpot, claimSpot } from '@/lib/control/devices'
import { setSetting } from '@/lib/site/settings'

export type TerminalActionResult = { ok: true; message: string } | { ok: false; error: string }

/**
 * Hand a POS LICENCE back, so a replacement machine can take it.
 *
 * ── NOT THE SAME AS releaseTerminalAction BELOW ────────────────────────────
 *
 * That one clears `terminals.device_id` in the SITE database — which machine is
 * standing at which register. This one clears `cp2_devices.serial_number` in the
 * control database — which machine is consuming a paid licence. A shop can
 * re-point a till at another register all day without that touching what they
 * pay for; only this frees a spot.
 *
 * The manager's answer to a dead till or a wiped browser profile: without it, a
 * licence the shop has paid for stays held by a machine that no longer exists.
 */
export async function releaseLicenceAction(deviceRowId: number): Promise<TerminalActionResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  await releaseSpot(ctx.siteId, deviceRowId)
  revalidatePath('/setup/terminals')
  return {
    ok: true,
    message: 'Till licence released. Another machine can now be linked to it.',
  }
}

/**
 * Make THIS machine a working till: licence and register, in one act.
 *
 * ── WHY ONE ACTION AND NOT TWO ──────────────────────────────────────────────
 *
 * These used to be separate: a licence claimed from the till screen, and a
 * terminal claimed with "Use here" on the card above. A machine could hold
 * either without the other — and a licensed till with no terminal numbers its
 * invoices from the shop-wide sequence instead of its own run, which nobody
 * notices until an accountant reads the numbering months later.
 *
 * So it is one question with one answer: this machine is licence X, ringing up
 * as till Y.
 *
 * ── WHY setup.edit AND NOT sales.till ───────────────────────────────────────
 *
 * Consuming a licence costs the shop money. A cashier who may ring up a sale
 * must not be able to spend one by tapping a button on the screen in front of
 * them — which is exactly what the old till-side flow allowed.
 */
export async function linkDeviceAction(
  deviceRowId: number,
  terminalId: number,
  serial: string,
  label: string,
): Promise<TerminalActionResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  if (!serial.trim()) {
    return {
      ok: false,
      error: 'This browser has no device number — storage may be blocked. Try another browser.',
    }
  }

  // The licence first: it is the half that can be refused, and claiming a
  // terminal we then could not licence would leave the shop half-configured.
  const claimed = await claimSpot(siteId, deviceRowId, serial.trim(), label, terminalId)
  if (!claimed.ok) return { ok: false, error: claimed.error }

  /* Then the till itself, in the SITE database. `claimTerminal` already releases
     whatever else held this device id, so a machine cannot end up as two tills. */
  const seated = await claimTerminal(siteId, terminalId, serial.trim(), label)
  if (!seated.ok) return { ok: false, error: seated.error }

  revalidatePath('/setup/terminals')
  return { ok: true, message: 'This machine is now set up as a till.' }
}

export async function saveTerminalAction(
  id: number | null,
  input: TerminalInput,
): Promise<TerminalActionResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx
  const result = id ? await updateTerminal(siteId, id, input) : await createTerminal(siteId, input)
  if (!result.ok) return { ok: false, error: result.error }

  revalidatePath('/setup/terminals')
  return { ok: true, message: id ? 'Till updated.' : 'Till registered.' }
}

export async function deleteTerminalAction(id: number): Promise<TerminalActionResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx
  const result = await deleteTerminal(siteId, id)
  if (!result.ok) return { ok: false, error: result.error }

  revalidatePath('/setup/terminals')
  return { ok: true, message: 'Till removed.' }
}

/** Frees a till so a replacement machine can claim it. */
export async function releaseTerminalAction(id: number): Promise<TerminalActionResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx
  await releaseTerminal(siteId, id)
  revalidatePath('/setup/terminals')
  return { ok: true, message: 'Till released. Another machine can now claim it.' }
}

/**
 * Claims a till for THIS machine.
 *
 * The device id comes from the browser — Electron's preload exposes a stable
 * one, a browser falls back to a generated id in localStorage. It only decides
 * whether the user is asked; the server still validates the terminal on every
 * sale, so a spoofed id buys nothing.
 */
export async function claimTerminalAction(
  id: number,
  deviceId: string,
  deviceLabel: string,
): Promise<TerminalActionResult> {
  const ctx = await actorFor('sales.till')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx
  const result = await claimTerminal(siteId, id, deviceId, deviceLabel)
  if (!result.ok) return { ok: false, error: result.error }

  revalidatePath('/setup/terminals')
  return { ok: true, message: 'This machine is now registered to that till.' }
}

/**
 * How many times a cashier may undo within one basket.
 *
 * ── WHY THE LIMIT IS SET HERE AND NOT ON THE TILL ─────────────────────────
 *
 * It is a control ON the cashier, so it cannot be a control the cashier holds.
 * `setup.edit` is the same right that adds a till or renames a register, and a
 * cashier who found this on the POS could raise their own allowance the moment it
 * refused them — which would make the whole setting theatre.
 *
 * Applies to every till in the shop, not to the register it happens to be set
 * from. The question a shop is answering is "how much quiet removal are we
 * comfortable with", and that has one answer per business rather than one per
 * machine.
 */
export async function setUndoLimitAction(limit: number): Promise<TerminalActionResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  /* Validated by `setSetting` against the same rule the till reads through — see
     settings.ts. Passing the number as a string because that is what the settings
     table stores; a number here would be coerced somewhere less obvious. */
  const saved = await setSetting(ctx.siteId, 'pos_undo_limit', String(limit))
  if (!saved.ok) return { ok: false, error: saved.error }

  revalidatePath('/setup/terminals')
  return {
    ok: true,
    message: limit === 0 ? 'Undo is now unlimited.' : `Cashiers may undo ${limit} times per sale.`,
  }
}

/**
 * Which of the three tills this shop runs.
 *
 * Separate from `setPosModeAction` on the tables screen, which is a two-way
 * switch that predates there being a third answer. That one still turns tables
 * on and off; this one names the mode outright, which is the only way to reach
 * the trade counter.
 *
 * Validated by `setSetting` against the same list the till reads through, so a
 * value this action does not recognise cannot be stored — see settings.ts.
 */
export async function setPosModeChoiceAction(mode: PosMode): Promise<TerminalActionResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  const saved = await setSetting(ctx.siteId, 'pos_mode', mode)
  if (!saved.ok) return { ok: false, error: saved.error }

  /* The till reads this from its offline catalogue as well as from the page, so
     a running till picks the change up on its next refresh rather than needing
     somebody to reload it mid-service. */
  revalidatePath('/setup/terminals')
  revalidatePath('/setup/tables')
  revalidatePath('/pos')
  return { ok: true, message: `This shop now runs the ${POS_MODE_LABELS[mode].toLowerCase()}.` }
}

/**
 * Whether the till says anything when a basket outruns the shelf.
 *
 * ── WHY THIS IS OPTIONAL AT ALL ───────────────────────────────────────────
 *
 * A shop that does not maintain its counts would be questioned several times a
 * day about figures nobody has ever reconciled. That does not make the shop
 * careless — plenty of trades genuinely do not track stock — but it does make
 * the warning noise, and noise at the payment step is worse than silence: a
 * cashier who dismisses a warning fifty times stops reading the fifty-first.
 *
 * Shop-wide rather than per till, like the undo limit and for the same reason:
 * "do we care about stock" has one answer per business.
 */
export async function setWarnOutOfStockAction(on: boolean): Promise<TerminalActionResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  const saved = await setSetting(ctx.siteId, 'pos_warn_out_of_stock', on ? '1' : '0')
  if (!saved.ok) return { ok: false, error: saved.error }

  revalidatePath('/setup/terminals')
  return {
    ok: true,
    message: on
      ? 'The till will warn when a sale outruns stock on hand.'
      : 'The till will no longer mention stock at the payment step.',
  }
}
