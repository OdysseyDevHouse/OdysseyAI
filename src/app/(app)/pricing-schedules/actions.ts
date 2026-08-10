'use server'

import { revalidatePath } from 'next/cache'
import { actorFor } from '@/lib/auth'
import {
  createSchedule,
  updateSchedule,
  deleteSchedule,
  setScheduleLines,
  removeScheduleLine,
  clearScheduleLines,
  seedFromCurrent,
  addRuleLines,
  refreshOldPrices,
  armSchedule,
  disarmSchedule,
  applyOneSchedule,
  revertSchedule,
  type ScheduleInput,
  type LineInput,
  type SeedScope,
} from '@/lib/site/priceSchedules'
import type { RepriceScope } from '@/lib/site/reprice'
import type { RepriceRule } from '@/lib/repricing'

/**
 * Scheduled price changes.
 *
 * ── WHY products.edit AND NOT setup.edit ─────────────────────────────────
 *
 * `setup.edit` covers the SHAPE of pricing — what price types exist, what VAT
 * rates apply. `products.edit` is the one described as "add products, change
 * descriptions and set prices", and it is what /specials uses. Setting a price
 * for Friday is setting a price.
 */

export type ScheduleActionResult = { ok: true; message: string } | { ok: false; error: string }
export type CreateResult = { ok: true; id: number } | { ok: false; error: string }

/**
 * The list, the editor, and everywhere a price is READ.
 *
 * The products screen included: an armed change alters nothing today, but an
 * APPLIED one has just moved every price on it, and a stale product page
 * showing the old figure is how somebody concludes the change did not work.
 */
function revalidate() {
  revalidatePath('/pricing-schedules')
  revalidatePath('/products')
}

export async function createScheduleAction(input: ScheduleInput): Promise<CreateResult> {
  const ctx = await actorFor('products.edit')
  if ('ok' in ctx) return ctx

  const result = await createSchedule(ctx.siteId, ctx.actor, input)
  if (!result.ok) return result
  revalidate()
  return result
}

export async function saveScheduleAction(
  id: number,
  input: ScheduleInput,
): Promise<ScheduleActionResult> {
  const ctx = await actorFor('products.edit')
  if ('ok' in ctx) return ctx

  const result = await updateSchedule(ctx.siteId, ctx.actor, id, input)
  if (!result.ok) return result
  revalidate()
  return { ok: true, message: 'Saved.' }
}

export async function deleteScheduleAction(id: number): Promise<ScheduleActionResult> {
  const ctx = await actorFor('products.edit')
  if ('ok' in ctx) return ctx

  const result = await deleteSchedule(ctx.siteId, ctx.actor, id)
  if (!result.ok) return result
  revalidate()
  return { ok: true, message: 'Price change deleted.' }
}

export async function setLinesAction(
  scheduleId: number,
  lines: LineInput[],
): Promise<ScheduleActionResult> {
  const ctx = await actorFor('products.edit')
  if ('ok' in ctx) return ctx

  const result = await setScheduleLines(ctx.siteId, scheduleId, lines)
  if (!result.ok) return result
  revalidate()
  return { ok: true, message: lines.length === 1 ? 'Price set.' : `${lines.length} prices set.` }
}

export async function removeLineAction(
  scheduleId: number,
  lineId: number,
): Promise<ScheduleActionResult> {
  const ctx = await actorFor('products.edit')
  if ('ok' in ctx) return ctx

  const result = await removeScheduleLine(ctx.siteId, scheduleId, lineId)
  if (!result.ok) return result
  revalidate()
  return { ok: true, message: 'Removed.' }
}

export async function clearLinesAction(scheduleId: number): Promise<ScheduleActionResult> {
  const ctx = await actorFor('products.edit')
  if ('ok' in ctx) return ctx

  const result = await clearScheduleLines(ctx.siteId, scheduleId)
  if (!result.ok) return result
  revalidate()
  return { ok: true, message: 'List cleared.' }
}

export async function seedFromCurrentAction(
  scheduleId: number,
  scope: SeedScope,
): Promise<ScheduleActionResult> {
  const ctx = await actorFor('products.edit')
  if ('ok' in ctx) return ctx

  const result = await seedFromCurrent(ctx.siteId, scheduleId, scope)
  if (!result.ok) return result
  revalidate()
  return {
    ok: true,
    message:
      result.added === 0
        ? 'Nothing matched — check the price types and departments.'
        : `${result.added} price${result.added === 1 ? '' : 's'} brought in. Edit the ones you want to change.`,
  }
}

/**
 * Expand a pricing rule into lines.
 *
 * Re-plans from the RULE rather than accepting a list of prices from the
 * browser — the same reasoning as applyRepriceAction. A posted list of product
 * ids and prices is an invitation to set any price on any product, and this
 * endpoint is reachable by anyone who can open the screen.
 */
export async function addRuleLinesAction(
  scheduleId: number,
  scope: RepriceScope,
  rule: RepriceRule,
): Promise<ScheduleActionResult> {
  const ctx = await actorFor('products.edit')
  if ('ok' in ctx) return ctx

  const result = await addRuleLines(ctx.siteId, scheduleId, scope, rule)
  if (!result.ok) return result
  revalidate()

  const skipped = result.skipped > 0 ? `, ${result.skipped} skipped` : ''
  return {
    ok: true,
    message:
      result.added === 0
        ? `The rule changed nothing${skipped}.`
        : `${result.added} price${result.added === 1 ? '' : 's'} added${skipped}.`,
  }
}

export async function refreshOldPricesAction(scheduleId: number): Promise<ScheduleActionResult> {
  const ctx = await actorFor('products.edit')
  if ('ok' in ctx) return ctx

  const result = await refreshOldPrices(ctx.siteId, scheduleId)
  if (!result.ok) return result
  revalidate()
  return { ok: true, message: 'Before-prices brought up to date.' }
}

export async function armScheduleAction(id: number): Promise<ScheduleActionResult> {
  const ctx = await actorFor('products.edit')
  if ('ok' in ctx) return ctx

  const result = await armSchedule(ctx.siteId, ctx.actor, id)
  if (!result.ok) return result
  revalidate()
  return { ok: true, message: 'Scheduled. The tills will apply it on the minute.' }
}

export async function disarmScheduleAction(id: number): Promise<ScheduleActionResult> {
  const ctx = await actorFor('products.edit')
  if ('ok' in ctx) return ctx

  const result = await disarmSchedule(ctx.siteId, ctx.actor, id)
  if (!result.ok) return result
  revalidate()
  return { ok: true, message: 'Unscheduled. Nothing will change until you schedule it again.' }
}

/**
 * Do it now, by hand.
 *
 * The "I have changed my mind, put these prices in today" path. Goes through
 * the same claim-and-write as the cron so the two cannot disagree, and passes
 * the real person as the actor rather than the scheduler.
 */
export async function applyNowAction(id: number): Promise<ScheduleActionResult> {
  const ctx = await actorFor('products.edit')
  if ('ok' in ctx) return ctx

  const result = await applyOneSchedule(ctx.siteId, id, ctx.actor)
  if (!result.ok) return result
  revalidate()

  /* Beaten to it by the scheduler, which is a real race: pressing this a moment
     after the moment arrives. The change HAS happened, so this is not an error
     — but saying "done, 0 prices changed" would read as a failure. */
  if (!result.claimed) {
    return { ok: true, message: 'Already done — the schedule got there first.' }
  }

  return {
    ok: true,
    message:
      result.written === 0
        ? 'Nothing to change — those prices were already in place.'
        : `Done. ${result.written} price${result.written === 1 ? '' : 's'} changed.`,
  }
}

export async function revertScheduleAction(id: number): Promise<ScheduleActionResult> {
  const ctx = await actorFor('products.edit')
  if ('ok' in ctx) return ctx

  const result = await revertSchedule(ctx.siteId, ctx.actor, id)
  if (!result.ok) return result
  revalidate()

  const skipped =
    result.skipped > 0
      ? ` ${result.skipped} were left alone because somebody changed them since.`
      : ''
  return {
    ok: true,
    message: `${result.restored} price${result.restored === 1 ? '' : 's'} put back.${skipped}`,
  }
}
