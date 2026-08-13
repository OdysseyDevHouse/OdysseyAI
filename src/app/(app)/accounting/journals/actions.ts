'use server'

import { revalidatePath } from 'next/cache'
import { actorFor } from '@/lib/auth'
import { postDraft, discardDraft } from '@/lib/site/journals'
import {
  saveRecurringJournal,
  setRecurringJournalActive,
  deleteRecurringJournal,
  generateDueJournals,
  type RecurringJournalInput,
} from '@/lib/site/recurringJournals'

/**
 * Journal actions beyond the accounts screen's postJournalAction — drafts and
 * the recurring schedules that produce them.
 */

export type ActionResult = { ok: true; message: string } | { ok: false; error: string }

function revalidateJournals(batchId?: number): void {
  revalidatePath('/accounting/journals')
  revalidatePath('/accounting/journals/recurring')
  if (batchId) revalidatePath(`/accounting/journals/${batchId}`)
}

export async function postDraftAction(batchId: number): Promise<ActionResult> {
  const ctx = await actorFor('reports.financial')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await postDraft(siteId, actor, batchId)
  if (!result.ok) return result

  revalidateJournals(batchId)
  return { ok: true, message: `Posted as ${result.journalNumber}.` }
}

export async function discardDraftAction(batchId: number): Promise<ActionResult> {
  const ctx = await actorFor('reports.financial')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await discardDraft(siteId, actor, batchId)
  if (!result.ok) return result

  revalidateJournals()
  return { ok: true, message: 'Draft discarded.' }
}

export async function saveRecurringJournalAction(
  input: RecurringJournalInput,
  id?: number,
): Promise<ActionResult> {
  const ctx = await actorFor('reports.financial')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await saveRecurringJournal(siteId, actor, input, id)
  if (!result.ok) return result

  revalidateJournals()
  return { ok: true, message: id ? 'Schedule saved.' : 'Schedule created.' }
}

export async function setRecurringActiveAction(
  id: number,
  active: boolean,
): Promise<ActionResult> {
  const ctx = await actorFor('reports.financial')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await setRecurringJournalActive(siteId, actor, id, active)
  if (!result.ok) return result

  revalidateJournals()
  return { ok: true, message: active ? 'Schedule resumed.' : 'Schedule paused.' }
}

export async function deleteRecurringJournalAction(id: number): Promise<ActionResult> {
  const ctx = await actorFor('reports.financial')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await deleteRecurringJournal(siteId, actor, id)
  if (!result.ok) return result

  revalidateJournals()
  return { ok: true, message: 'Schedule deleted. Journals it produced are untouched.' }
}

export async function generateRecurringJournalsAction(): Promise<ActionResult> {
  const ctx = await actorFor('reports.financial')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await generateDueJournals(siteId, actor)
  revalidateJournals()

  if (result.generated.length === 0 && result.skipped.length === 0) {
    return { ok: true, message: 'Nothing is due.' }
  }
  const parts: string[] = []
  const drafts = result.generated.filter((g) => !g.posted).length
  const posted = result.generated.filter((g) => g.posted).length
  if (drafts > 0) parts.push(`${drafts} draft${drafts === 1 ? '' : 's'}`)
  if (posted > 0) parts.push(`${posted} posted`)
  if (result.skipped.length > 0) parts.push(`${result.skipped.length} skipped — ${result.skipped[0].reason}`)
  return { ok: true, message: parts.join(', ') + '.' }
}
