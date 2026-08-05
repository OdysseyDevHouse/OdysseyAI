'use server'

import { revalidatePath } from 'next/cache'
import { requireActor } from '@/lib/auth'
import { addSerials, writeOffSerial } from '@/lib/site/serials'

/**
 * Serial capture, saved on its own rather than with the product form.
 *
 * Every other tab on that form describes the product and can wait for Save.
 * Serials are individual units of stock: capturing fifty off a delivery note
 * and then losing them because the form failed validation on an unrelated
 * field would be indefensible. They commit as they are entered, and the panel
 * shows what is actually in the database.
 */

export type SerialActionState = {
  error: string | null
  message: string | null
}

export async function addSerialsAction(
  _prev: SerialActionState,
  form: FormData,
): Promise<SerialActionState> {
  const { siteId, actor } = await requireActor()

  const productId = Number(form.get('productId'))
  if (!Number.isFinite(productId) || productId <= 0) {
    return { error: 'Save the product before capturing serial numbers.', message: null }
  }

  // One per line or comma-separated — a delivery note gets pasted in whichever
  // shape it arrives, and splitting on both costs nothing.
  const serials = String(form.get('serials') ?? '')
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

  if (serials.length === 0) return { error: 'Enter at least one serial number.', message: null }

  const costRaw = String(form.get('costExcl') ?? '').trim()
  const cost = Number(costRaw.replace(/,/g, ''))

  const result = await addSerials(siteId, actor, productId, serials, {
    costExcl: Number.isFinite(cost) ? cost : 0,
    warrantyUntil: String(form.get('warrantyUntil') ?? '').trim() || null,
  })

  if (!result.ok) return { error: result.error, message: null }

  revalidatePath(`/products/${productId}`)

  // Skipped duplicates are named rather than swallowed: someone pasting fifty
  // serials needs to know which one was already captured.
  const skipped =
    result.skipped.length > 0
      ? ` ${result.skipped.length} already captured: ${result.skipped.slice(0, 5).join(', ')}${
          result.skipped.length > 5 ? '…' : ''
        }`
      : ''

  return {
    error: null,
    message: `Added ${result.added} serial number${result.added === 1 ? '' : 's'}.${skipped}`,
  }
}

export async function writeOffSerialAction(
  _prev: SerialActionState,
  form: FormData,
): Promise<SerialActionState> {
  const { siteId, actor } = await requireActor()

  const serialId = Number(form.get('serialId'))
  const productId = Number(form.get('productId'))
  const reason = String(form.get('reason') ?? '')

  if (!Number.isFinite(serialId) || serialId <= 0) {
    return { error: 'That serial no longer exists.', message: null }
  }

  const result = await writeOffSerial(siteId, actor, serialId, reason)
  if (!result.ok) return { error: result.error, message: null }

  if (Number.isFinite(productId) && productId > 0) revalidatePath(`/products/${productId}`)

  return { error: null, message: 'Serial written off.' }
}
