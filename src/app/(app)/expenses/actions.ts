'use server'

import { revalidatePath } from 'next/cache'
import { requireActor } from '@/lib/auth'
import {
  saveDraft,
  finalise,
  voidExpense,
  deleteDraft,
  findDuplicate,
  type ExpenseInput,
} from '@/lib/site/expenses'
import {
  createCategory,
  updateCategory,
  setCategoryActive,
  deleteCategory,
  type CategoryInput,
} from '@/lib/site/expenseCategories'
import {
  saveRecurring,
  setRecurringActive,
  deleteRecurring,
  generateDue,
  type RecurringInput,
} from '@/lib/site/recurringExpenses'

/**
 * Expense actions.
 *
 * Save and finalise are SEPARATE actions rather than one with a flag: they have
 * different blast radii — one writes a draft nobody has seen, the other moves
 * money — and a reviewer should be able to tell them apart at a glance.
 */

export type ActionResult = { ok: true; message: string } | { ok: false; error: string }

function revalidateExpenses(id?: number): void {
  revalidatePath('/expenses')
  if (id) revalidatePath(`/expenses/${id}`)
}

export async function saveExpenseAction(
  input: ExpenseInput,
  existingId?: number,
): Promise<ActionResult & { id?: number }> {
  const { siteId, actor } = await requireActor()

  const result = await saveDraft(siteId, actor, input, existingId)
  if (!result.ok) return result

  revalidateExpenses(result.id)
  return { ok: true, message: 'Saved as a draft.', id: result.id }
}

/**
 * Saves and posts in one step.
 *
 * The common path by far — somebody captures a slip they are holding and has no
 * reason to review it later. The draft still exists for the moment between the
 * two writes, so a failure at finalise leaves the capture rather than losing it.
 */
export async function saveAndFinaliseAction(
  input: ExpenseInput,
  existingId?: number,
): Promise<ActionResult & { id?: number; documentNumber?: string }> {
  const { siteId, actor } = await requireActor()

  const saved = await saveDraft(siteId, actor, input, existingId)
  if (!saved.ok) return saved

  const posted = await finalise(siteId, actor, saved.id)
  if (!posted.ok) {
    revalidateExpenses(saved.id)
    // The draft survives — say so, or the user will assume nothing was kept.
    return { ok: false, error: `${posted.error} The expense has been kept as a draft.` }
  }

  revalidateExpenses(saved.id)
  revalidatePath('/cashbook')
  revalidatePath('/suppliers/remittances')

  return {
    ok: true,
    id: saved.id,
    documentNumber: posted.documentNumber,
    message:
      input.paymentType === 'on_account'
        ? `Posted as ${posted.documentNumber}. It is now on the supplier's account.`
        : `Posted as ${posted.documentNumber}. The money is out of the bank.`,
  }
}

export async function finaliseExpenseAction(id: number): Promise<ActionResult> {
  const { siteId, actor } = await requireActor()

  const result = await finalise(siteId, actor, id)
  if (!result.ok) return result

  revalidateExpenses(id)
  revalidatePath('/cashbook')
  return { ok: true, message: `Posted as ${result.documentNumber}.` }
}

export async function voidExpenseAction(id: number, reason: string): Promise<ActionResult> {
  const { siteId, actor } = await requireActor()

  const result = await voidExpense(siteId, actor, id, reason)
  if (!result.ok) return result

  revalidateExpenses(id)
  revalidatePath('/cashbook')
  return { ok: true, message: 'Voided.' }
}

export async function deleteDraftAction(id: number): Promise<ActionResult> {
  const { siteId, actor } = await requireActor()

  const result = await deleteDraft(siteId, actor, id)
  if (!result.ok) return result

  revalidateExpenses()
  return { ok: true, message: 'Draft discarded.' }
}

/**
 * Checks whether a supplier invoice number has been seen before.
 *
 * A warning, never a refusal — a supplier may legitimately reuse a number
 * across years — but booking the same bill twice silently overstates costs, so
 * it is worth the round trip while the user is still typing.
 */
export async function checkDuplicateAction(
  supplierId: number,
  supplierInvoiceNo: string,
  excludeId = 0,
): Promise<{ id: number; documentNumber: string | null; expenseDate: string; totalIncl: number } | null> {
  const { siteId } = await requireActor()

  const found = await findDuplicate(siteId, supplierId, supplierInvoiceNo, excludeId)
  return found
    ? {
        id: found.id,
        documentNumber: found.documentNumber,
        expenseDate: found.expenseDate,
        totalIncl: found.totalIncl,
      }
    : null
}

/* ── Categories ──────────────────────────────────────────────────────────── */

export async function saveCategoryAction(
  input: CategoryInput,
  existingId?: number,
): Promise<ActionResult> {
  const { siteId, actor } = await requireActor()

  const result = existingId
    ? await updateCategory(siteId, actor, existingId, input)
    : await createCategory(siteId, actor, input)
  if (!result.ok) return result

  revalidatePath('/setup/expense-categories')
  revalidateExpenses()
  return { ok: true, message: existingId ? 'Category saved.' : 'Category added.' }
}

export async function setCategoryActiveAction(
  id: number,
  active: boolean,
): Promise<ActionResult> {
  const { siteId, actor } = await requireActor()

  const result = await setCategoryActive(siteId, actor, id, active)
  if (!result.ok) return result

  revalidatePath('/setup/expense-categories')
  return { ok: true, message: active ? 'Category reactivated.' : 'Category deactivated.' }
}

export async function deleteCategoryAction(id: number): Promise<ActionResult> {
  const { siteId, actor } = await requireActor()

  const result = await deleteCategory(siteId, actor, id)
  if (!result.ok) return result

  revalidatePath('/setup/expense-categories')
  return { ok: true, message: 'Category deleted.' }
}

/* ── Recurring ───────────────────────────────────────────────────────────── */

export async function saveRecurringAction(
  input: RecurringInput,
  existingId?: number,
): Promise<ActionResult & { id?: number }> {
  const { siteId, actor } = await requireActor()

  const result = await saveRecurring(siteId, actor, input, existingId)
  if (!result.ok) return result

  revalidatePath('/expenses/recurring')
  revalidateExpenses()
  return { ok: true, message: existingId ? 'Schedule saved.' : 'Schedule created.', id: result.id }
}

export async function setRecurringActiveAction(
  id: number,
  active: boolean,
): Promise<ActionResult> {
  const { siteId, actor } = await requireActor()

  const result = await setRecurringActive(siteId, actor, id, active)
  if (!result.ok) return result

  revalidatePath('/expenses/recurring')
  return { ok: true, message: active ? 'Schedule resumed.' : 'Schedule paused.' }
}

export async function deleteRecurringAction(id: number): Promise<ActionResult> {
  const { siteId, actor } = await requireActor()

  const result = await deleteRecurring(siteId, actor, id)
  if (!result.ok) return result

  revalidatePath('/expenses/recurring')
  return { ok: true, message: 'Schedule deleted. The expenses it produced are kept.' }
}

export async function generateDueAction(): Promise<ActionResult> {
  const { siteId, actor } = await requireActor()

  const result = await generateDue(siteId, actor)
  revalidatePath('/expenses/recurring')
  revalidateExpenses()

  if (result.generated.length === 0) {
    return {
      ok: true,
      message:
        result.skipped.length > 0
          ? `Nothing generated. ${result.skipped[0].reason}`
          : 'Nothing is due yet.',
    }
  }

  return {
    ok: true,
    message: `${result.generated.length} draft${result.generated.length === 1 ? '' : 's'} created. Review and post them.`,
  }
}
