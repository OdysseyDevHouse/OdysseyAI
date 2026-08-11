'use server'

import { revalidatePath } from 'next/cache'
import { actorFor } from '@/lib/auth'
import { logActivity } from '@/lib/site/activityLog'
import {
  createStaffReservation,
  getReservation,
  setReservationStatus,
  setReservationTable,
  type ActionResult,
} from '@/lib/site/reservations'
import {
  notifyKindForStatus,
  notifyReservationGuest,
} from '@/lib/site/reservationNotify'
import {
  STATUS_LABEL,
  type ReservationStatus,
  type StaffReservationInput,
} from '@/lib/reservationTypes'

/**
 * Server actions for the reservations queue.
 *
 * Every action re-checks the capability rather than trusting the UI to have
 * hidden itself — a button nobody can see is still an action anyone can post
 * to. `actorFor` returns a refusal instead of redirecting, which is what these
 * want: the result shape has room to carry the error back to a toast.
 */

export async function setReservationStatusAction(
  id: number,
  status: ReservationStatus,
  reason?: string,
): Promise<ActionResult> {
  const ctx = await actorFor('reservations.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  // Read BEFORE the change: cancelling a booking the shop never agreed to is a
  // decline, and cancelling one it promised is a cancellation. The two read
  // very differently to the guest, and afterwards both look identical.
  const before = await getReservation(siteId, id)

  const result = await setReservationStatus(siteId, id, status, actor, { reason })
  if (!result.ok) return result

  const after = await getReservation(siteId, id)
  if (after) {
    await logActivity(siteId, actor, {
      entity: 'reservation',
      entityId: id,
      action: `status_${status}`,
      detail:
        `Booking ${after.reference} for ${after.contactName} marked ` +
        `${STATUS_LABEL[status].toLowerCase()}${reason?.trim() ? ` — ${reason.trim().slice(0, 160)}` : ''}`,
    })

    // After the commit, and best-effort: a mail server that is down must not
    // undo the status change staff just made. notifyReservationGuest never
    // throws, so there is nothing to catch.
    if (before) {
      const kind = notifyKindForStatus(status, before.status)
      if (kind) await notifyReservationGuest(siteId, after, kind)
    }
  }

  revalidatePath('/sales/reservations')
  return { ok: true }
}

/** Put a booking on a table, or clear it with "". */
export async function setReservationTableAction(
  id: number,
  tableName: string,
): Promise<ActionResult> {
  const ctx = await actorFor('reservations.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await setReservationTable(siteId, id, tableName, actor)
  if (!result.ok) return result

  await logActivity(siteId, actor, {
    entity: 'reservation',
    entityId: id,
    action: 'set_table',
    detail: tableName.trim()
      ? `Booking put on table ${tableName.trim().slice(0, 50)}`
      : 'Booking taken off its table',
  })

  revalidatePath('/sales/reservations')
  return { ok: true }
}

/**
 * Take a booking over the phone.
 *
 * Confirmed the moment it is taken, and not bound by the public form's slot
 * rules — the person on the call can see the room, and those rules exist to
 * stop the shop over-promising to strangers, not to overrule staff.
 */
export async function createReservationAction(
  input: StaffReservationInput,
): Promise<ActionResult> {
  const ctx = await actorFor('reservations.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await createStaffReservation(siteId, input, actor)
  if (!result.ok) return result

  await logActivity(siteId, actor, {
    entity: 'reservation',
    entityId: result.reservation.id,
    action: 'create',
    detail:
      `Took booking ${result.reservation.reference} for ${result.reservation.contactName} ` +
      `— ${input.date} at ${input.time}, party of ${result.reservation.partySize}`,
  })

  // A phone booking is confirmed the moment it is taken, so the guest gets the
  // confirmation they were just promised on the call. Silent when they left no
  // email address, which is the common case for a booking taken at the door.
  await notifyReservationGuest(siteId, result.reservation, 'confirmed')

  revalidatePath('/sales/reservations')
  return { ok: true }
}
