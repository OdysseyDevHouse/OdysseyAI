'use server'

import { revalidatePath } from 'next/cache'
import { actorFor } from '@/lib/auth'
import {
  createAccount,
  updateAccount,
  setAccountActive,
  setMapping,
  type AccountInput,
} from '@/lib/site/chartOfAccounts'
import { post, reverse } from '@/lib/site/journals'
import { closeYear } from '@/lib/site/glPosting'
import type { JournalLineInput } from '@/lib/glModel'

/**
 * General ledger actions.
 *
 * Everything here changes what the financial statements say, so all of it sits
 * behind setup.edit or reports.financial rather than a general edit right.
 */

export type ActionResult = { ok: true; message: string } | { ok: false; error: string }

export async function saveAccountAction(
  input: AccountInput,
  existingId?: number,
): Promise<ActionResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = existingId
    ? await updateAccount(siteId, actor, existingId, input)
    : await createAccount(siteId, actor, input)
  if (!result.ok) return result

  revalidatePath('/accounting/accounts')
  return { ok: true, message: existingId ? 'Account saved.' : 'Account added.' }
}

export async function setAccountActiveAction(
  id: number,
  active: boolean,
): Promise<ActionResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await setAccountActive(siteId, actor, id, active)
  if (!result.ok) return result

  revalidatePath('/accounting/accounts')
  return { ok: true, message: active ? 'Account reactivated.' : 'Account hidden.' }
}

export async function setMappingAction(
  mappingKey: string,
  refId: number | null,
  accountId: number,
): Promise<ActionResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await setMapping(siteId, actor, mappingKey, refId, accountId)
  if (!result.ok) return result

  revalidatePath('/accounting/accounts')
  return { ok: true, message: 'Mapping saved.' }
}

/* ── Journals ────────────────────────────────────────────────────────────── */

export async function postJournalAction(input: {
  journalDate: string
  description: string
  reference?: string
  lines: JournalLineInput[]
}): Promise<ActionResult & { journalNumber?: string }> {
  const ctx = await actorFor('reports.financial')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await post(siteId, actor, input)
  if (!result.ok) return result

  revalidatePath('/accounting/journals')
  revalidatePath('/accounting/trial-balance')

  return {
    ok: true,
    journalNumber: result.journalNumber,
    message: `Posted as ${result.journalNumber}.`,
  }
}

export async function reverseJournalAction(
  id: number,
  reason: string,
): Promise<ActionResult> {
  const ctx = await actorFor('reports.financial')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await reverse(siteId, actor, id, reason)
  if (!result.ok) return result

  revalidatePath('/accounting/journals')
  revalidatePath('/accounting/trial-balance')
  return { ok: true, message: `Reversed as ${result.journalNumber}.` }
}

/* ── Year end ────────────────────────────────────────────────────────────── */

export async function closeYearAction(
  yearStart: string,
  yearEnd: string,
): Promise<ActionResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await closeYear(siteId, actor, yearStart, yearEnd)
  if (!result.ok) return result

  revalidatePath('/accounting/trial-balance')
  revalidatePath('/accounting/balance-sheet')
  revalidatePath('/accounting/income-statement')

  return {
    ok: true,
    message: `Year closed. ${result.netResult >= 0 ? 'Profit' : 'Loss'} of ${Math.abs(result.netResult).toFixed(2)} moved to retained earnings.`,
  }
}
