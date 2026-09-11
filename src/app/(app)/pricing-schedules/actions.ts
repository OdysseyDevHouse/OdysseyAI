'use server'

import { revalidatePath } from 'next/cache'
import { actorFor } from '@/lib/auth'
import type { FieldProblems } from '@/lib/fieldErrors'
import {
  createSchedule,
  updateSchedule,
  duplicateSchedule,
  deleteSchedule,
  setScheduleLines,
  removeScheduleLine,
  clearScheduleLines,
  seedFromCurrent,
  addRuleLines,
  bulkAdjustScheduleLines,
  refreshOldPrices,
  armSchedule,
  disarmSchedule,
  applyOneSchedule,
  revertSchedule,
  type ScheduleInput,
  type LineInput,
  type SeedScope,
  type BulkLineFilter,
} from '@/lib/site/priceSchedules'
import { listDepartments, departmentFilterIds } from '@/lib/site/departments'
import type { RepriceScope } from '@/lib/site/reprice'
import type { BulkPriceChange, RepriceRounding, RepriceRule } from '@/lib/repricing'

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

/**
 * `field` and `problems` come along for the ride — see lib/fieldErrors.ts.
 *
 * These actions already return the library's failure unchanged (`if
 * (!result.ok) return result`), so widening the type is all that is needed for
 * the field information to reach the screen.
 */
export type ScheduleActionResult =
  | { ok: true; message: string }
  | { ok: false; error: string; field?: string; problems?: FieldProblems }
export type CreateResult =
  | { ok: true; id: number }
  | { ok: false; error: string; field?: string; problems?: FieldProblems }

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

/**
 * Copy a change so a second one can be built from the same list.
 *
 * Returns the new id rather than a message: the caller navigates straight into
 * the copy, because "duplicate" is never the whole intention — the reason to
 * make one is to go and change something on it.
 */
export async function duplicateScheduleAction(id: number, name?: string): Promise<CreateResult> {
  const ctx = await actorFor('products.edit')
  if ('ok' in ctx) return ctx

  const result = await duplicateSchedule(ctx.siteId, ctx.actor, id, name)
  if (!result.ok) return result
  revalidate()
  return result
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

  /*
   * A ticked department means that branch — "Drinks" is Drinks, Beer and
   * Imported. Expanded HERE, against the tree, rather than trusting the browser
   * to have sent every descendant: the picker ticks only the parent (it treats
   * children as implied, so one branch is one chip rather than eleven), and a
   * scope taken literally would seed the handful of products filed directly on
   * the parent and silently miss every sub-department under it.
   */
  const departments = await listDepartments(ctx.siteId)
  const departmentIds = scope.departmentIds?.length
    ? (departmentFilterIds(departments, scope.departmentIds) ?? undefined)
    : undefined

  const result = await seedFromCurrent(ctx.siteId, scheduleId, { ...scope, departmentIds })
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

/**
 * Move every price the editor's filters are showing, in one go.
 *
 * The browser sends the FILTER and the RULE — never a list of prices. Same
 * stance as `addRuleLinesAction` above, and for the same reason: a posted set
 * of figures is an invitation to write any price onto any product, and this
 * endpoint is reachable by anyone who can open the screen. It also keeps the
 * count honest, since the table only ever has fifty of its rows in the browser.
 */
export async function bulkAdjustLinesAction(
  scheduleId: number,
  filter: BulkLineFilter,
  change: BulkPriceChange,
  rounding?: RepriceRounding,
): Promise<ScheduleActionResult> {
  const ctx = await actorFor('products.edit')
  if ('ok' in ctx) return ctx

  /* A ticked department means that branch, expanded here against the tree —
     exactly as seedFromCurrentAction does it, so the two ways of choosing a
     department on this screen cannot come to different answers. */
  const departments = await listDepartments(ctx.siteId)
  const departmentIds = filter.departmentIds?.length
    ? (departmentFilterIds(departments, filter.departmentIds) ?? undefined)
    : undefined

  const result = await bulkAdjustScheduleLines(
    ctx.siteId,
    scheduleId,
    { ...filter, departmentIds },
    change,
    rounding,
  )
  if (!result.ok) return result
  revalidate()

  if (result.matched === 0) {
    return { ok: true, message: 'Nothing matched those filters — no prices were changed.' }
  }
  /* The skipped ones are named rather than folded into the total. They are the
     prices a change could not sanely make — R5 off a R3 item — and somebody who
     is told "412 updated" when 11 of them stayed put will not find those 11. */
  const skipped =
    result.skipped > 0
      ? ` ${result.skipped} left alone — the change would have taken them to zero or less.`
      : ''
  return {
    ok: true,
    message: `${result.updated} price${result.updated === 1 ? '' : 's'} updated.${skipped}`,
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
