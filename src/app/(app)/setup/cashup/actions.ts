'use server'

import { revalidatePath } from 'next/cache'
import { actorFor } from '@/lib/auth'
import { getSetting, setSetting, validateSetting } from '@/lib/site/settings'
import { openShifts } from '@/lib/site/shifts'

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
}

export type CashupSettingsResult =
  | { ok: true; settings: CashupSettings }
  | { ok: false; error: string }

export async function saveCashupSettingsAction(input: {
  varianceTolerance: string
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

  revalidatePath('/setup/cashup')
  /* Every screen that reads the tolerance to decide whether an explanation is
     required. Without these, a till keeps demanding a reason against
     yesterday's threshold. */
  revalidatePath('/sales/cashup', 'layout')
  revalidatePath('/pos')

  return {
    ok: true,
    settings: { varianceTolerance: await getSetting(ctx.siteId, 'cashup_variance_tolerance') },
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
  revalidatePath('/setup/cashup')
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
