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
  setTerminalPosMode,
  setTerminalStockLocation,
  getTerminal,
  type TerminalInput,
} from '@/lib/site/terminals'
import { releaseSpot, claimSpot } from '@/lib/control/devices'
import { setSetting } from '@/lib/site/settings'
import { setBackdrop, clearBackdrop } from '@/lib/site/posSignInArt'

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
 * Which of the three screens ONE TILL runs.
 *
 * ── WHY THIS IS PER TILL AND NOT PER SHOP ─────────────────────────────────
 *
 * It used to write a single `pos_mode` setting for the whole site, which cannot
 * describe a real shop: a builders' merchant runs a wholesale trade desk on the
 * invoicing screen and a retail front counter on the retail screen, under one
 * company and one roof. One answer per site puts one of those two halves on the
 * wrong screen every day it trades.
 *
 * The site setting is gone rather than kept as a default — see
 * sql/site/180_terminal_pos_mode.sql for why one place to set a thing beats
 * two.
 */
export async function setTerminalPosModeAction(
  terminalId: number,
  mode: PosMode,
): Promise<TerminalActionResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  const saved = await setTerminalPosMode(ctx.siteId, terminalId, mode)
  if (!saved.ok) return { ok: false, error: saved.error }

  const terminal = await getTerminal(ctx.siteId, terminalId)

  /* The till reads this through its own page render, so a running till picks the
     change up on its next refresh rather than needing somebody to reload it
     mid-service. */
  revalidatePath('/setup/terminals')
  revalidatePath('/pos')
  return {
    ok: true,
    message: `${terminal?.code ?? 'That till'} now runs the ${POS_MODE_LABELS[mode].toLowerCase()}.`,
  }
}

/**
 * Which stock room this till sells out of.
 *
 * Per till and on the row, for the same reasons the mode above is — see that
 * docblock, and `setTerminalStockLocation` for why it is a narrow write rather
 * than a field on the edit dialog.
 *
 * Revalidates /pos as well as this screen: the till reads its own location
 * through its page render, so a register picks a correction up on the next
 * refresh rather than needing somebody to restart it mid-trade.
 */
export async function setTerminalStockLocationAction(
  terminalId: number,
  locationId: number | null,
): Promise<TerminalActionResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  const saved = await setTerminalStockLocation(ctx.siteId, terminalId, locationId)
  if (!saved.ok) return { ok: false, error: saved.error }

  const terminal = await getTerminal(ctx.siteId, terminalId)

  revalidatePath('/setup/terminals')
  revalidatePath('/pos')
  return {
    ok: true,
    message: terminal?.stockLocationName
      ? `${terminal.code} now sells from ${terminal.stockLocationName}.`
      : `${terminal?.code ?? 'That till'} now sells from the main location.`,
  }
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

/**
 * Whether each person must be clocked on before the till will trade.
 *
 * Distinct from the shift gate, which is unconditional — see
 * `pos_force_clock_in` in settings.ts for why both exist.
 */
export async function setForceClockInAction(on: boolean): Promise<TerminalActionResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  const saved = await setSetting(ctx.siteId, 'pos_force_clock_in', on ? '1' : '0')
  if (!saved.ok) return { ok: false, error: saved.error }

  revalidatePath('/setup/terminals')
  return {
    ok: true,
    message: on
      ? 'Cashiers must now clock on before they can ring up a sale.'
      : 'Cashiers can trade without clocking on.',
  }
}

/**
 * Whether a disconnected till may still sell ON ACCOUNT.
 *
 * ── WHAT THE OWNER IS ACTUALLY AGREEING TO ────────────────────────────────
 *
 * That the till may extend credit against a limit it cannot check. A customer
 * at their ceiling when the line dropped can keep buying, and the shop finds
 * out when the queue syncs. There is no way to make that safe — a stale balance
 * is stale — so the only honest thing is to say so and let somebody decide.
 *
 * The messages below are worded as consequences rather than as state, because
 * "Offline account sales are on" tells an owner what they clicked and not what
 * it means.
 *
 * Shop-wide, like the stock warning and the undo limit: "do we trust our
 * account customers when the server is down" has one answer per business, not
 * one per till.
 */
export async function setOfflineAccountSalesAction(on: boolean): Promise<TerminalActionResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  const saved = await setSetting(ctx.siteId, 'pos_offline_account_sales', on ? '1' : '0')
  if (!saved.ok) return { ok: false, error: saved.error }

  revalidatePath('/setup/terminals')
  return {
    ok: true,
    message: on
      ? 'A till with no connection may now put a sale on account — against the balance it last saw.'
      : 'A till with no connection will refuse account sales until the line is back.',
  }
}

/* ── The sign-in screen's backdrop ───────────────────────────────────────── */

/**
 * Upload the picture behind the till's sign-in screen.
 *
 * `setup.edit` rather than `setup.stationery`, which gates the document logo:
 * that permission is about what PRINTS, and this is about what a machine on the
 * shop floor displays. They are the same job in a small shop and different
 * people in a large one, and the till screens are already this permission's.
 */
export async function uploadSignInBackdropAction(
  form: FormData,
): Promise<TerminalActionResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  const file = form.get('backdrop')
  if (!(file instanceof File)) return { ok: false, error: 'Choose an image to upload.' }

  const result = await setBackdrop(ctx.siteId, file)
  if (!result.ok) return result

  revalidatePath('/setup/terminals')
  /* Names where it shows up. A manager who has just uploaded a picture is not
     standing at a till, so "saved" alone leaves them with no way to tell
     whether it worked without walking to one. */
  revalidatePath('/pos')
  return { ok: true, message: 'Backdrop uploaded. Tills show it on the sign-in screen.' }
}

export async function clearSignInBackdropAction(): Promise<TerminalActionResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  const result = await clearBackdrop(ctx.siteId)
  if (!result.ok) return result

  revalidatePath('/setup/terminals')
  revalidatePath('/pos')
  return { ok: true, message: 'Backdrop removed. Tills show the standard background.' }
}
