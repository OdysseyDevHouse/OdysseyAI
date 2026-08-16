'use server'

import { revalidatePath } from 'next/cache'
import { actorFor } from '@/lib/auth'
import { setListColumns, clearListColumns, type ListKey } from '@/lib/site/listColumns'
import { setReportColumns, clearReportColumns, setReportGroupBy } from '@/lib/site/reportColumns'

/**
 * Setting which columns a list or a report shows, for the whole store.
 *
 * Shared rather than per-screen: the products list was the first to use it, but
 * customers, suppliers, reports and the rest take the same shape, and copies of
 * a ten-line action would drift.
 *
 * ── WHY setup.edit ───────────────────────────────────────────────────────
 *
 * This changes what every user of the store sees, so it is a setup decision
 * rather than a personal one — the same capability that governs departments,
 * reasons and numbering. A user without it sees the columns the store chose and
 * no control to change them.
 *
 * The catalogue is passed in by the caller and filtered against on the server,
 * so a hand-rolled POST cannot store a key the table does not know about.
 */
export async function setListColumnsAction(
  listKey: ListKey,
  visible: string[],
  known: string[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  const result = await setListColumns(ctx.siteId, listKey, visible, known, ctx.actor.userId)
  if (!result.ok) return result

  revalidatePath(`/${listKey}`)
  return { ok: true }
}

/** Forgets the store's choice, so the list's own default applies again. */
export async function clearListColumnsAction(
  listKey: ListKey,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  await clearListColumns(ctx.siteId, listKey)
  revalidatePath(`/${listKey}`)
  return { ok: true }
}

/**
 * Sets which columns a REPORT shows, and in what order, for the whole store.
 *
 * `ordered` is the visible output keys in render order — see reportColumns.ts.
 * `known` is what the report actually produced on this run, which is also the
 * only list the server will accept keys from.
 *
 * The report id carries a colon for a saved report ('saved:12'), so the path
 * revalidated is the report's own screen rather than `/${reportId}`.
 */
export async function setReportColumnsAction(
  reportId: string,
  ordered: string[],
  known: string[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  const result = await setReportColumns(ctx.siteId, reportId, ordered, known, ctx.actor.userId)
  if (!result.ok) return result

  // The viewer is a dynamic route, so the list page alone would not refresh it.
  revalidatePath(`/reports/${reportId}`)
  revalidatePath('/reports')
  return { ok: true }
}

/**
 * Sets which column a REPORT is banded by, for the whole store.
 *
 * `key` is a single output key, or null for "no grouping" — which is a choice
 * rather than a reset, and is stored as such.
 *
 * `known` is the BANDABLE keys from this run — not every column the report
 * produced — so a hand-rolled POST cannot band by a money column or by one the
 * caller's permissions stripped.
 *
 * setup.edit for the same reason the column choice needs it: this changes what
 * every user of the store sees when they open the report.
 */
export async function setReportGroupByAction(
  reportId: string,
  key: string | null,
  known: string[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  const result = await setReportGroupBy(ctx.siteId, reportId, key, known, ctx.actor.userId)
  if (!result.ok) return result

  revalidatePath(`/reports/${reportId}`)
  revalidatePath('/reports')
  return { ok: true }
}

/** Forgets the store's choice, so the report's own columns and order apply. */
export async function clearReportColumnsAction(
  reportId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  await clearReportColumns(ctx.siteId, reportId)
  revalidatePath(`/reports/${reportId}`)
  revalidatePath('/reports')
  return { ok: true }
}
