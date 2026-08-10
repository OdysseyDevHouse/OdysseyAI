'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireSiteId, actorFor, actorForOrThrow } from '@/lib/auth'
import {
  createGroup,
  updateGroup,
  deleteGroup,
  replaceOptions,
  setGroupOrder,
  type GroupInput,
  type OptionInput,
} from '@/lib/site/instructions'

export type InstructionFormState = { error: string | null }

/** What an inline action on the list reports back, without leaving the page. */
export type InlineResult = { ok: boolean; error?: string; message?: string }

function num(form: FormData, key: string): number {
  const raw = String(form.get(key) ?? '').trim()
  if (!raw) return 0
  const n = Number(raw.replace(/,/g, ''))
  return Number.isFinite(n) ? n : 0
}

/** A form field that may legitimately be empty, meaning "nothing chosen". */
function optionalId(raw: string): number | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const n = Number(trimmed)
  return Number.isFinite(n) && n > 0 ? n : null
}

function readGroup(form: FormData): GroupInput {
  return {
    name: String(form.get('name') ?? ''),
    prompt: String(form.get('prompt') ?? ''),
    isRequired: String(form.get('isRequired') ?? '') === '1',
    minChoices: num(form, 'minChoices'),
    maxChoices: num(form, 'maxChoices'),
    imageId: optionalId(String(form.get('imageId') ?? '')),
    sortOrder: num(form, 'sortOrder'),
    isActive: String(form.get('isActive') ?? '1') === '1',
  }
}

/** A whole number from a form field, falling back when it is blank or junk. */
function count(raw: unknown, fallback: number): number {
  const n = Number(String(raw ?? '').replace(/,/g, '').trim())
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : fallback
}

/**
 * The options editor submits parallel arrays — option_id[], option_name[] and
 * so on — because the row count is not known until the user has finished adding
 * rows. FormData preserves their order, so index i of each array belongs to the
 * same row.
 *
 * ── WHY THE REVEALED GROUPS ARE ONE COMMA-SEPARATED FIELD ───────────────────
 *
 * Every other column here is one value per row, which is what makes the parallel
 * arrays line up. The groups an answer goes on to ask are a LIST per row, and a
 * second dimension breaks that: `optionReveals` as a repeated field would give
 * seven entries across three rows with nothing to say which row each belonged
 * to. One hidden field per row holding "4,9" keeps every array the same length
 * and the index meaning the same thing in all of them.
 */
function readOptions(form: FormData): (OptionInput & { id?: number })[] {
  const ids = form.getAll('optionId')
  const names = form.getAll('optionName')
  const prices = form.getAll('optionPrice')
  const products = form.getAll('optionProduct')
  const quantities = form.getAll('optionQuantity')
  const defaults = form.getAll('optionDefault')
  const maxQtys = form.getAll('optionMaxQty')
  const minQtys = form.getAll('optionMinQty')
  const defaultQtys = form.getAll('optionDefaultQty')
  const images = form.getAll('optionImage')
  const kitchen = form.getAll('optionKitchen')
  const receipt = form.getAll('optionReceipt')
  const reveals = form.getAll('optionReveals')

  const options: (OptionInput & { id?: number })[] = []

  for (let i = 0; i < names.length; i++) {
    const name = String(names[i] ?? '').trim()
    // A blank name is an empty row the user never filled in, not an error.
    // `continue` rather than a filter, so `i` keeps indexing every array above.
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
      maxQty: count(maxQtys[i], 1),
      minQty: count(minQtys[i], 0),
      defaultQty: count(defaultQtys[i], 0),
      imageId: optionalId(String(images[i] ?? '')),
      // Sent as an explicit 1/0 per row rather than as a checkbox, because an
      // unticked box sends NOTHING and "the user turned kitchen printing off"
      // would be indistinguishable from "this field never reached the form".
      // The two must not be confused: one means the cook should not see this
      // answer, the other would silently drop it off the ticket.
      printsOnKitchen: String(kitchen[i] ?? '1') === '1',
      printsOnReceipt: String(receipt[i] ?? '1') === '1',
      revealsGroupIds: String(reveals[i] ?? '')
        .split(',')
        .map((part) => optionalId(part))
        .filter((id): id is number => id !== null),
      sortOrder: i,
    })
  }

  return options
}

export async function saveInstructionAction(
  _prev: InstructionFormState,
  form: FormData,
): Promise<InstructionFormState> {
  const ctx = await actorFor('products.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

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

/**
 * Reorders the library from the list screen, without a form or a redirect.
 *
 * The order matters because it is the order a till offers the questions in when
 * a product asks several — until now every group's sort_order was left at 0 and
 * the list fell back to alphabetical, so "choice of bread" came before "how
 * would you like your eggs" for no reason anybody chose.
 */
export async function reorderInstructionsAction(orderedIds: number[]): Promise<InlineResult> {
  const ctx = await actorFor('products.edit')
  if ('ok' in ctx) return ctx

  const result = await setGroupOrder(ctx.siteId, orderedIds)
  if (!result.ok) return { ok: false, error: result.error }

  revalidatePath('/instructions')
  return { ok: true, message: 'Order saved.' }
}

export async function deleteInstructionAction(form: FormData): Promise<void> {
  const ctx = await actorForOrThrow('products.edit')
  const { siteId } = ctx
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
