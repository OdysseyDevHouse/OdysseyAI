'use server'

import { revalidatePath } from 'next/cache'
import { actorForModule } from '@/lib/auth'
import { saveBudgets, copyFromPriorYear, copyFromActuals, type BudgetEntry } from '@/lib/site/budgets'

export type ActionResult = { ok: true; message: string } | { ok: false; error: string }

export async function saveBudgetsAction(entries: BudgetEntry[]): Promise<ActionResult> {
  const ctx = await actorForModule('accounting', 'reports.financial')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await saveBudgets(siteId, actor, entries)
  if (!result.ok) return result

  revalidatePath('/accounting/budgets')
  revalidatePath('/accounting/income-statement')
  return { ok: true, message: `${result.saved} figure${result.saved === 1 ? '' : 's'} saved.` }
}

export async function copyPriorYearAction(year: number): Promise<ActionResult> {
  const ctx = await actorForModule('accounting', 'reports.financial')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await copyFromPriorYear(siteId, actor, year)
  if (!result.ok) return result

  revalidatePath('/accounting/budgets')
  return { ok: true, message: `${result.copied} figure${result.copied === 1 ? '' : 's'} carried over from ${year - 1}.` }
}

export async function copyActualsAction(year: number, sourceYear: number): Promise<ActionResult> {
  const ctx = await actorForModule('accounting', 'reports.financial')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await copyFromActuals(siteId, actor, year, sourceYear)
  if (!result.ok) return result

  revalidatePath('/accounting/budgets')
  return { ok: true, message: `${result.copied} figure${result.copied === 1 ? '' : 's'} written in from ${sourceYear}'s actuals.` }
}
