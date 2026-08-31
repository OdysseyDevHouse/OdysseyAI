'use server'

import { revalidatePath } from 'next/cache'
import { actorFor } from '@/lib/auth'
import { logActivity } from '@/lib/site/activityLog'
import { getReservationSettings, saveReservationSettings } from '@/lib/site/reservations'
import { parseOpeningHours, type ReservationSettings } from '@/lib/reservationTypes'
import { createPublicReserveToken } from '@/lib/publicReserveToken'

/**
 * Saving the reservation settings.
 *
 * The clamping lives in the data layer (saveReservationSettings), not here, so
 * a caller that skips this screen cannot store a slot length of zero. This
 * action's own job is the capability check, the audit line, and turning the
 * hours the form collected back into a validated object.
 */

type Result = { ok: true } | { ok: false; error: string }

export async function saveReservationSettingsAction(
  input: ReservationSettings,
): Promise<Result> {
  const ctx = await actorFor('reservations.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  try {
    const before = await getReservationSettings(siteId)

    /*
     * Re-parsed rather than trusted. The form builds this object, but the
     * action is a public endpoint — parseOpeningHours drops a backwards range
     * and anything that is not a [HH:MM, HH:MM] pair, which is the same
     * validation the public page's slot generator assumes has already run.
     */
    const openingHours = parseOpeningHours(JSON.stringify(input.openingHours ?? {}))

    if (input.isEnabled && Object.keys(openingHours).length === 0) {
      return {
        ok: false,
        error: 'Add at least one day the restaurant takes bookings before switching them on.',
      }
    }

    await saveReservationSettings(siteId, { ...input, openingHours })

    await logActivity(siteId, actor, {
      entity: 'reservation',
      entityId: null,
      action: before.isEnabled === input.isEnabled ? 'settings_update' : input.isEnabled ? 'opened' : 'closed',
      detail:
        before.isEnabled === input.isEnabled
          ? 'Reservation settings changed'
          : input.isEnabled
            ? 'Online table bookings switched on'
            : 'Online table bookings switched off',
    })

    revalidatePath('/settings')
    revalidatePath('/sales/reservations')
    return { ok: true }
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'Could not save the reservation settings.',
    }
  }
}

/**
 * What the panel renders, in one read.
 *
 * New with the move out of /setup: the screen used to be a route whose page.tsx
 * read the settings and minted the public link on the server. As a TAB of
 * /settings there is no page of its own, so the panel asks when it is opened —
 * see `usePanelData`.
 *
 * Guarded on `reservations.edit`, the same capability the page carried and the
 * save beside it still carries. Not `setup.edit`: booking hours are set by
 * whoever runs the floor, who is not necessarily the person who configures the
 * shop.
 */
export type OnlineBookingsState =
  | { ok: true; settings: ReservationSettings; reservePath: string }
  | { ok: false; error: string }

export async function loadOnlineBookingsAction(): Promise<OnlineBookingsState> {
  const ctx = await actorFor('reservations.edit')
  if ('ok' in ctx) return ctx

  const [settings, token] = await Promise.all([
    getReservationSettings(ctx.siteId),
    createPublicReserveToken(ctx.siteId),
  ])

  return { ok: true, settings, reservePath: `/reserve/${token}` }
}
