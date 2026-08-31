'use server'

import { revalidatePath } from 'next/cache'
import { actorFor } from '@/lib/auth'
import { getSettings, setSetting, validateSetting } from '@/lib/site/settings'
import { cashupMode, openShifts } from '@/lib/site/shifts'
import {
  currencyState,
  switchCurrency,
  setDenominationActive,
  addDenomination,
} from '@/lib/site/cashDenominations'
import { listDenominations } from '@/lib/site/cashupDeclaration'
import { CURRENCIES, currencyFor } from '@/lib/currencies'

/**
 * How far a drawer may be out before somebody has to explain it.
 *
 * The setting was readable and not writable: the cash-up screens have consulted
 * `cashup_variance_tolerance` since 016, but nothing put a control on a screen,
 * so changing it meant an UPDATE against the settings table.
 *
 * Mode lives here too. It used to sit on the cash-up screen itself, which put
 * a configuration choice on a screen people open twice a day to count money —
 * both settings now being in one place is what somebody looking for either of
 * them expects.
 *
 * Guarded on `setup.edit`. The tolerance is the threshold at which a short
 * drawer has to be ACCOUNTED FOR — letting the people being held to it raise it
 * is the one arrangement that defeats the point.
 */

export type CashupSettings = {
  varianceTolerance: string
  /** '1' or '0' — whether the till demands an open shift before it will sell. */
  requireShift: string
}

export type CashupSettingsResult =
  | { ok: true; settings: CashupSettings }
  | { ok: false; error: string }

/**
 * Everything this panel renders, in one read.
 *
 * New with the move out of /setup: the screen used to be a route, so its
 * page.tsx did these five reads on the server and handed them down as props.
 * As a TAB of /settings there is no page of its own, so the panel asks for its
 * own state when it is opened — see `usePanelData`.
 *
 * One action rather than five, because the panel needs all of it before it can
 * render anything: five round trips would each pay the same auth check and the
 * panel would still wait for the slowest.
 */
export type CashupPanelState =
  | {
      ok: true
      settings: CashupSettings
      mode: 'terminal' | 'user'
      openShiftCount: number
      currency: Awaited<ReturnType<typeof currencyState>>
      denominations: Awaited<ReturnType<typeof listDenominations>>
      currencies: { code: string; name: string; symbol: string }[]
    }
  | { ok: false; error: string }

export async function loadCashupPanelAction(): Promise<CashupPanelState> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  const [settings, mode, open, currency, denominations] = await Promise.all([
    getSettings(siteId, ['cashup_variance_tolerance', 'pos_require_shift']),
    cashupMode(siteId),
    // Only the COUNT is used: the mode cannot change while a shift is open, and
    // the screen says so rather than letting somebody click into a refusal.
    openShifts(siteId),
    currencyState(siteId),
    /* Inactive included: the whole point of showing the grid here is turning a
       row back on — a shop that finds old 5c coins in a safe should tick a box
       rather than ring support. See 168. */
    listDenominations(siteId, true),
  ])

  return {
    ok: true,
    settings: {
      varianceTolerance: settings.cashup_variance_tolerance,
      requireShift: settings.pos_require_shift,
    },
    mode,
    openShiftCount: open.length,
    currency,
    denominations,
    currencies: CURRENCIES.map((c) => ({ code: c.code, name: c.name, symbol: c.symbol })),
  }
}

export async function saveCashupSettingsAction(input: {
  varianceTolerance: string
  requireShift: string
}): Promise<CashupSettingsResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  // setSetting validates the key and refuses a bad value — negative, or above
  // the 500 ceiling that would hide a real shortage.
  const result = await setSetting(
    ctx.siteId,
    'cashup_variance_tolerance',
    input.varianceTolerance,
  )
  if (!result.ok) return result

  /*
   * Written second, and NOT rolled back if it fails.
   *
   * There is no transaction across two settings rows and inventing one here
   * would be the wrong shape — these are two independent switches that happen
   * to share a Save button. What matters is that a failure is REPORTED rather
   * than swallowed, so the screen does not show a saved state for a value the
   * database refused. The tolerance having landed first is harmless: it is the
   * value the person typed, and they are told the other one did not take.
   */
  const shiftResult = await setSetting(ctx.siteId, 'pos_require_shift', input.requireShift)
  if (!shiftResult.ok) return shiftResult

  revalidatePath('/settings')
  /* Every screen that reads the tolerance to decide whether an explanation is
     required. Without these, a till keeps demanding a reason against
     yesterday's threshold. */
  revalidatePath('/sales/cashup', 'layout')
  revalidatePath('/pos')

  const saved = await getSettings(ctx.siteId, [
    'cashup_variance_tolerance',
    'pos_require_shift',
  ])
  return {
    ok: true,
    settings: {
      varianceTolerance: saved.cashup_variance_tolerance,
      requireShift: saved.pos_require_shift,
    },
  }
}

/**
 * Switches the site between reconciling by till and by person.
 *
 * REFUSED WHILE ANYTHING IS OPEN. A shift records the mode it was opened under,
 * so switching mid-shift would leave a half-counted drawer being reconciled by
 * one rule while the next sale banks by another — and the person holding the
 * cash would have no way to tell which. Closing everything first is a small
 * inconvenience that makes the change unambiguous.
 *
 * Separate from the tolerance save rather than folded into it: this one can be
 * REFUSED by state the screen does not control, and a single Save that silently
 * wrote one setting and rejected the other is the ambiguity this whole guard
 * exists to prevent.
 */
export async function setCashupModeAction(
  mode: 'terminal' | 'user',
): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  const open = await openShifts(siteId)
  if (open.length > 0) {
    return {
      ok: false,
      error: `Cash up the ${open.length} open shift${open.length === 1 ? '' : 's'} before changing how this site reconciles.`,
    }
  }

  const invalid = validateSetting('cashup_mode', mode)
  if (invalid) return { ok: false, error: invalid }

  await setSetting(siteId, 'cashup_mode', mode)
  revalidatePath('/settings')
  revalidatePath('/sales/cashup', 'layout')
  revalidatePath('/pos')
  return {
    ok: true,
    message:
      mode === 'user'
        ? 'Cash-ups now reconcile per person.'
        : 'Cash-ups now reconcile per till.',
  }
}

/**
 * Switch the shop's currency, and replace the denominations with it.
 *
 * ── REFUSED WHILE A SHIFT IS OPEN, LIKE THE MODE ────────────────────────────
 *
 * Same guard as `setCashupModeAction`, and a stronger version of the same
 * reason. A shift is reconciled against the grid it was counted into, so
 * swapping rand rows for Canadian ones under an open drawer would leave a
 * half-counted declaration pointing at denominations that no longer exist on
 * the screen. Closing everything first makes the change unambiguous.
 *
 * Historical counts are never disturbed — `switchCurrency` retires a row that
 * has been counted rather than deleting it. This guard is about the drawer
 * somebody is holding RIGHT NOW.
 */
export async function switchCurrencyAction(
  code: string,
): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  const open = await openShifts(siteId)
  if (open.length > 0) {
    return {
      ok: false,
      error: `Cash up the ${open.length} open shift${open.length === 1 ? '' : 's'} before changing currency.`,
    }
  }

  const spec = currencyFor(code)
  if (!spec) return { ok: false, error: `${code} is not a currency this system knows.` }

  const result = await switchCurrency(siteId, code)
  if (!result.ok) return result

  revalidatePath('/settings')
  revalidatePath('/sales/cashup', 'layout')
  revalidatePath('/pos')
  return {
    ok: true,
    message: `Drawers are now counted in ${spec.name.toLowerCase()}.`,
  }
}

/** Turn one denomination on or off — the tick, not a delete. See 168. */
export async function setDenominationActiveAction(
  id: number,
  active: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  const result = await setDenominationActive(ctx.siteId, id, active)
  if (!result.ok) return result

  revalidatePath('/settings')
  revalidatePath('/sales/cashup', 'layout')
  return { ok: true }
}

/** Add a note or coin the shipped set does not carry. */
export async function addDenominationAction(input: {
  label: string
  value: number
  isNote: boolean
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  const result = await addDenomination(ctx.siteId, input)
  if (!result.ok) return result

  revalidatePath('/settings')
  revalidatePath('/sales/cashup', 'layout')
  return { ok: true }
}
