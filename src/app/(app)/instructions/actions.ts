'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireSiteId } from '@/lib/auth'
import {
  createGroup,
  updateGroup,
  deleteGroup,
  replaceOptions,
  type GroupInput,
  type OptionInput,
} from '@/lib/site/instructions'

export type InstructionFormState = { error: string | null }

function num(form: FormData, key: string): number {
  const raw = String(form.get(key) ?? '').trim()
  if (!raw) return 0
  const n = Number(raw.replace(/,/g, ''))
  return Number.isFinite(n) ? n : 0
}

function readGroup(form: FormData): GroupInput {
  return {
    name: String(form.get('name') ?? ''),
    prompt: String(form.get('prompt') ?? ''),
    isRequired: String(form.get('isRequired') ?? '') === '1',
    minChoices: num(form, 'minChoices'),
    maxChoices: num(form, 'maxChoices'),
    sortOrder: num(form, 'sortOrder'),
    isActive: String(form.get('isActive') ?? '1') === '1',
  }
}

/**
 * The options editor submits parallel arrays — option_id[], option_name[] and
 * so on — because the row count is not known until the user has finished adding
 * rows. FormData preserves their order, so index i of each array belongs to the
 * same row.
 */
function readOptions(form: FormData): (OptionInput & { id?: number })[] {
  const ids = form.getAll('optionId')
  const names = form.getAll('optionName')
  const prices = form.getAll('optionPrice')
  const products = form.getAll('optionProduct')
  const quantities = form.getAll('optionQuantity')
  const defaults = form.getAll('optionDefault')

  const options: (OptionInput & { id?: number })[] = []

  for (let i = 0; i < names.length; i++) {
    const name = String(names[i] ?? '').trim()
    // A blank name is an empty row the user never filled in, not an error.
    if (!name) continue

    const rawId = String(ids[i] ?? '').trim()
    const rawProduct = String(products[i] ?? '').trim()
    const rawPrice = String(prices[i] ?? '').replace(/,/g, '')
    const rawQuantity = String(quantities[i] ?? '').replace(/,/g, '')

    options.push({
      id: rawId ? Number(rawId) : undefined,
      name,
      priceAdjust: Number.isFinite(Number(rawPrice)) ? Number(rawPrice) : 0,
      productId: rawProduct ? Number(rawProduct) : null,
      quantity: Number.isFinite(Number(rawQuantity)) && rawQuantity ? Number(rawQuantity) : 1,
      // Checkboxes submit their row index as the value, so an unticked row
      // sends nothing and cannot be confused with the row before it.
      isDefault: defaults.map(String).includes(String(i)),
      sortOrder: i,
    })
  }

  return options
}

export async function saveInstructionAction(
  _prev: InstructionFormState,
  form: FormData,
): Promise<InstructionFormState> {
  const siteId = await requireSiteId()

  const idRaw = String(form.get('id') ?? '').trim()
  const input = readGroup(form)

  const result = idRaw
    ? await updateGroup(siteId, Number(idRaw), input)
    : await createGroup(siteId, input)

  if (!result.ok) return { error: result.error }

  const options = await replaceOptions(siteId, result.id, readOptions(form))
  if (!options.ok) return { error: options.error }

  revalidatePath('/instructions')
  redirect(`/instructions/${result.id}?saved=1`)
}

export async function deleteInstructionAction(form: FormData): Promise<void> {
  const siteId = await requireSiteId()
  const id = Number(form.get('id'))

  if (Number.isFinite(id) && id > 0) {
    const result = await deleteGroup(siteId, id)
    // Still in use — send the reason back to the edit screen rather than
    // failing silently or deleting something the user still depends on.
    if (!result.ok) {
      revalidatePath(`/instructions/${id}`)
      redirect(`/instructions/${id}?error=${encodeURIComponent(result.error)}`)
    }
  }

  revalidatePath('/instructions')
  redirect('/instructions?deleted=1')
}
