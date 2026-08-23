'use server'

import { revalidatePath } from 'next/cache'
import { actorForModule } from '@/lib/auth'
import {
  unlinkCalendarAccount,
  setCalendarDirections,
  acceptChange,
  declineChange,
  type CalendarResult,
} from '@/lib/site/jobCalendar'

/**
 * Deciding what a linked calendar may do, and what to do about a drag.
 *
 * All four gated on `jobs.setup`, matching the link route: a calendar link
 * pushes customer names and addresses to a third party and reads a person's
 * busy time back, which is a decision about how the business runs its work.
 *
 * Accepting a change is the odd one out and deliberately gated the same way —
 * it reschedules a customer's visit, which is at least as consequential as
 * configuring the link that proposed it.
 */

function refresh() {
  revalidatePath('/setup/job-calendar')
  // An accepted change moves a real visit.
  revalidatePath('/jobs/schedule')
  revalidatePath('/jobs')
}

export async function unlinkAction(accountId: number): Promise<CalendarResult> {
  const ctx = await actorForModule('job_cards', 'jobs.setup')
  if ('ok' in ctx) return ctx
  const result = await unlinkCalendarAccount(ctx.siteId, ctx.actor, accountId)
  if (result.ok) refresh()
  return result
}

export async function setDirectionsAction(
  accountId: number,
  push: boolean,
  pull: boolean,
): Promise<CalendarResult> {
  const ctx = await actorForModule('job_cards', 'jobs.setup')
  if ('ok' in ctx) return ctx
  const result = await setCalendarDirections(ctx.siteId, ctx.actor, accountId, { push, pull })
  if (result.ok) refresh()
  return result
}

export async function acceptAction(changeId: number): Promise<CalendarResult> {
  const ctx = await actorForModule('job_cards', 'jobs.setup')
  if ('ok' in ctx) return ctx
  const result = await acceptChange(ctx.siteId, ctx.actor, changeId)
  if (result.ok) refresh()
  return result
}

export async function declineAction(changeId: number): Promise<CalendarResult> {
  const ctx = await actorForModule('job_cards', 'jobs.setup')
  if ('ok' in ctx) return ctx
  const result = await declineChange(ctx.siteId, ctx.actor, changeId)
  if (result.ok) refresh()
  return result
}
