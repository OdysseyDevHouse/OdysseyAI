'use server'

import { revalidatePath } from 'next/cache'
import { requireActor, requireSiteId, actorFor } from '@/lib/auth'
import {
  captureTransaction,
  voidTransaction,
  linkTransaction,
  unlinkTransaction,
  suggestMatches,
  autoMatch,
  completeReconciliation,
  reopenReconciliation,
  recordCustomerReceipt,
} from '@/lib/site/cashbook'
import { createAccount, updateAccount, closeAccount, repairBankBalance } from '@/lib/site/bankAccounts'
import { parseStatement, importStatement, undoImport } from '@/lib/site/bankImport'
import type { BankAccountType } from '@/lib/site/cashbookRules'

/**
 * Cashbook actions.
 *
 * Everything that moves money or agrees a figure lives here, separate from the
 * account's descriptive settings, for the reason ledgerActions.ts gives: a
 * reviewer should be able to see everything with a financial blast radius in
 * one file.
 *
 * They return their result rather than redirecting — the reconciliation screen
 * is a client component that reports the outcome in a toast and refreshes in
 * place, so a redirect would lose the user's scroll position mid-match.
 */

export type ActionResult = { ok: true; message: string } | { ok: false; error: string }

function revalidateAccount(accountId?: number): void {
  revalidatePath('/cashbook')
  if (accountId) revalidatePath(`/cashbook/${accountId}`)
}

export async function captureAction(input: {
  bankAccountId: number
  amount: number
  txnDate?: string
  description?: string
  reference?: string
}): Promise<ActionResult> {
  const ctx = await actorFor('cashbook.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await captureTransaction(siteId, actor, input)
  if (!result.ok) return result

  revalidateAccount(input.bankAccountId)
  return { ok: true, message: 'Movement captured.' }
}

export async function voidAction(
  bankAccountId: number,
  transactionId: number,
  reason: string,
): Promise<ActionResult> {
  const ctx = await actorFor('cashbook.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await voidTransaction(siteId, actor, transactionId, reason)
  if (!result.ok) return result

  revalidateAccount(bankAccountId)
  return { ok: true, message: 'Movement voided.' }
}

export async function suggestAction(bankTxnId: number) {
  const ctx = await actorFor('cashbook.reconcile')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx
  return suggestMatches(siteId, bankTxnId, 5)
}

export async function linkAction(input: {
  bankAccountId: number
  bankTxnId: number
  side: 'customer' | 'supplier'
  ledgerTxnId: number
  amount: number
}): Promise<ActionResult> {
  const ctx = await actorFor('cashbook.reconcile')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await linkTransaction(
    siteId,
    actor,
    input.bankTxnId,
    input.side,
    input.ledgerTxnId,
    input.amount,
  )
  if (!result.ok) return result

  revalidateAccount(input.bankAccountId)
  return { ok: true, message: `Matched ${result.linked.toFixed(2)}.` }
}

export async function unlinkAction(bankAccountId: number, linkId: number): Promise<ActionResult> {
  const ctx = await actorFor('cashbook.reconcile')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await unlinkTransaction(siteId, actor, linkId)
  if (!result.ok) return result

  revalidateAccount(bankAccountId)
  return { ok: true, message: 'Match removed.' }
}

export async function autoMatchAction(bankAccountId: number): Promise<ActionResult> {
  const ctx = await actorFor('cashbook.reconcile')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await autoMatch(siteId, actor, bankAccountId)
  revalidateAccount(bankAccountId)

  if (result.matched === 0) {
    return {
      ok: true,
      message:
        result.considered === 0
          ? 'Nothing left to match.'
          : `Nothing could be matched with confidence. ${result.considered} line${result.considered === 1 ? '' : 's'} need${result.considered === 1 ? 's' : ''} a decision.`,
    }
  }
  return {
    ok: true,
    message: `Matched ${result.matched} of ${result.considered} line${result.considered === 1 ? '' : 's'}.`,
  }
}

export async function completeReconciliationAction(input: {
  bankAccountId: number
  statementDate: string
  statementBalance: number
  notes?: string
  force?: boolean
}): Promise<ActionResult> {
  const ctx = await actorFor('cashbook.reconcile')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await completeReconciliation(siteId, actor, input)
  if (!result.ok) return result

  revalidateAccount(input.bankAccountId)
  return {
    ok: true,
    message: result.difference === 0
      ? 'Reconciled and signed off.'
      : `Signed off with ${Math.abs(result.difference).toFixed(2)} unexplained.`,
  }
}

export async function reopenReconciliationAction(
  bankAccountId: number,
  reconciliationId: number,
  reason: string,
): Promise<ActionResult> {
  const ctx = await actorFor('cashbook.reconcile')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await reopenReconciliation(siteId, actor, reconciliationId, reason)
  if (!result.ok) return result

  revalidateAccount(bankAccountId)
  return { ok: true, message: 'Reconciliation reopened.' }
}

export async function receiptAction(input: {
  customerId: number
  bankAccountId: number
  amount: number
  receiptDate?: string
  reference?: string
  description?: string
  autoAllocate?: boolean
}): Promise<ActionResult> {
  const ctx = await actorFor('cashbook.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await recordCustomerReceipt(siteId, actor, input)
  if (!result.ok) return result

  revalidateAccount(input.bankAccountId)
  revalidatePath(`/customers/${input.customerId}`)
  return { ok: true, message: 'Receipt recorded and banked.' }
}

/* ── Accounts ────────────────────────────────────────────────────────────── */

export async function createAccountAction(input: {
  code: string
  name: string
  accountType?: BankAccountType
  bankName?: string
  accountNumber?: string
  branchCode?: string
  openingBalance?: number
  openingDate?: string
  isDefaultReceipts?: boolean
  isDefaultPayments?: boolean
}): Promise<ActionResult & { id?: number }> {
  const ctx = await actorFor('cashbook.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await createAccount(siteId, actor, input)
  if (!result.ok) return result

  revalidateAccount()
  return { ok: true, message: 'Account created.', id: result.id }
}

export async function updateAccountAction(
  id: number,
  input: {
    code: string
    name: string
    accountType?: BankAccountType
    bankName?: string
    accountNumber?: string
    branchCode?: string
    openingBalance?: number
    openingDate?: string
    isDefaultReceipts?: boolean
    isDefaultPayments?: boolean
  },
): Promise<ActionResult> {
  const ctx = await actorFor('cashbook.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await updateAccount(siteId, actor, id, input)
  if (!result.ok) return result

  revalidateAccount(id)
  return { ok: true, message: 'Account saved.' }
}

export async function closeAccountAction(id: number): Promise<ActionResult> {
  const ctx = await actorFor('cashbook.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await closeAccount(siteId, actor, id)
  if (!result.ok) return result

  revalidateAccount(id)
  return { ok: true, message: 'Account closed.' }
}

export async function repairBalanceAction(id: number): Promise<ActionResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await repairBankBalance(siteId, actor, id)
  if (!result.ok) return result

  revalidateAccount(id)
  return {
    ok: true,
    message: `Balance corrected from ${result.from.toFixed(2)} to ${result.to.toFixed(2)}.`,
  }
}

/* ── Import ──────────────────────────────────────────────────────────────── */

/**
 * Parses a statement WITHOUT importing it.
 *
 * The two are separate actions so the screen can show what the sniffer decided
 * — which date format, which columns, how many rows — before anything is
 * written. A misread date format is only obvious when you see it, and by then
 * it is too late if the import already happened.
 */
export async function parseStatementAction(text: string) {
  await requireSiteId()
  return parseStatement(text)
}

export async function importStatementAction(input: {
  bankAccountId: number
  text: string
  filename?: string
  autoMatch?: boolean
}): Promise<ActionResult & { imported?: number; duplicates?: number; autoMatched?: number }> {
  const ctx = await actorFor('cashbook.reconcile')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const parsed = parseStatement(input.text)
  const result = await importStatement(siteId, actor, {
    bankAccountId: input.bankAccountId,
    parsed,
    filename: input.filename,
    autoMatch: input.autoMatch,
  })
  if (!result.ok) return result

  revalidateAccount(input.bankAccountId)

  const parts = [`${result.imported} imported`]
  if (result.duplicates > 0) parts.push(`${result.duplicates} already present`)
  if (result.autoMatched > 0) parts.push(`${result.autoMatched} auto-matched`)

  return {
    ok: true,
    message: parts.join(', ') + '.',
    imported: result.imported,
    duplicates: result.duplicates,
    autoMatched: result.autoMatched,
  }
}

export async function undoImportAction(
  bankAccountId: number,
  batchId: number,
): Promise<ActionResult> {
  const ctx = await actorFor('cashbook.reconcile')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await undoImport(siteId, actor, batchId)
  if (!result.ok) return result

  revalidateAccount(bankAccountId)
  return { ok: true, message: `Removed ${result.removed} imported line${result.removed === 1 ? '' : 's'}.` }
}
