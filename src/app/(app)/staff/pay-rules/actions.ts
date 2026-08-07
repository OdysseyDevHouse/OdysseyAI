'use server'

import { revalidatePath } from 'next/cache'
import { actorFor } from '@/lib/auth'
import { setSetting } from '@/lib/site/settings'
import { saveHolidayOverride, deleteHolidayOverride } from '@/lib/site/holidays'

/**
 * Pay rules — the multipliers, and the store's own public holidays.
 *
 * Guarded on `staff.cost` rather than `setup.edit`: everything here changes
 * what the wage bill comes to, and `staff.cost` is already the capability that
 * decides who may see pay at all. Somebody who cannot be shown an hourly rate
 * must not be able to raise what an hour is multiplied by.
 *
 * A server action is a public endpoint whatever the menu shows.
 */

type Result = { ok: true; message: string } | { ok: false; error: string }

export async function savePayRulesAction(input: {
  overtime: string
  sunday: string
  sundayOrdinary: string
  holiday: string
}): Promise<Result> {
  const ctx = await actorFor('staff.cost')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  // Validated inside setSetting, and the FIRST refusal returns rather than
  // saving what passed — a half-saved set of rates would have the store
  // believing all four applied. Same reasoning as the lay-by screen.
  for (const [key, value] of [
    ['staff_overtime_multiplier', input.overtime.trim() || '1.5'],
    ['staff_sunday_multiplier', input.sunday.trim() || '2'],
    ['staff_sunday_ordinary_multiplier', input.sundayOrdinary.trim() || '1.5'],
    ['staff_holiday_multiplier', input.holiday.trim() || '2'],
  ] as const) {
    const result = await setSetting(siteId, key, value)
    if (!result.ok) return result
  }

  // The timesheet names the rates in its hints and the cost report charges
  // them, so both are stale the moment these change.
  revalidatePath('/staff/pay-rules')
  revalidatePath('/staff/timesheets')
  revalidatePath('/staff/cost')

  return { ok: true, message: 'Pay rules saved.' }
}

export async function saveHolidayAction(input: {
  date: string
  name: string
  isWorkingDay: boolean
  note: string | null
}): Promise<Result> {
  const ctx = await actorFor('staff.cost')
  if ('ok' in ctx) return ctx

  const result = await saveHolidayOverride(ctx.siteId, input, ctx.actor)
  if (!result.ok) return result

  revalidatePath('/staff/pay-rules')
  revalidatePath('/staff/timesheets')
  revalidatePath('/staff/cost')

  return {
    ok: true,
    message: input.isWorkingDay ? 'Marked as an ordinary working day.' : 'Public holiday saved.',
  }
}

export async function deleteHolidayAction(id: number): Promise<Result> {
  const ctx = await actorFor('staff.cost')
  if ('ok' in ctx) return ctx

  const result = await deleteHolidayOverride(ctx.siteId, id)
  if (!result.ok) return result

  revalidatePath('/staff/pay-rules')
  revalidatePath('/staff/timesheets')
  revalidatePath('/staff/cost')

  // Worth saying, because removing an override is not removing a holiday —
  // a statutory day comes straight back once nothing overrides it.
  return { ok: true, message: 'Removed. The statutory calendar applies to that day again.' }
}
