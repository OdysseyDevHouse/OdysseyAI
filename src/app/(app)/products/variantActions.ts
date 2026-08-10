'use server'

import { revalidatePath } from 'next/cache'
import { requireCapability } from '@/lib/auth'
import {
  makeParent,
  attachChild,
  detachChild,
  unmakeParent,
  setVariantOrder,
  getGroup,
  VariantError,
  type VariantGroup,
} from '@/lib/site/productVariants'
import { searchProductsForPicker, type ProductPick } from '@/lib/site/products'

/**
 * The variants panel's server actions.
 *
 * Every one re-checks `products.edit`. The panel is only rendered for someone
 * who has it, but a hidden panel is not a boundary — these are POST endpoints
 * that anyone can call, and the action is where the check has to live.
 *
 * The model throws VariantError with a message written for a shopkeeper, so
 * these return it verbatim rather than replacing it with something generic.
 */

type Result = { ok: true } | { ok: false; error: string }

function failed(error: unknown): Result {
  if (error instanceof VariantError) return { ok: false, error: error.message }
  // Anything else is a bug or a dead connection, and its text is not fit for a
  // user to read.
  console.error('variant action failed', error)
  return { ok: false, error: 'Something went wrong. Please try again.' }
}

export async function makeParentAction(
  productId: number,
  axisLabels: string[],
): Promise<Result> {
  const { siteId } = await requireCapability('products.edit')
  try {
    await makeParent(
      siteId,
      productId,
      axisLabels.map((label, i) => ({ position: (i + 1) as 1 | 2, label })),
    )
    revalidatePath(`/products/${productId}`)
    return { ok: true }
  } catch (error) {
    return failed(error)
  }
}

export async function attachChildAction(
  parentId: number,
  childId: number,
  axis1: string,
  axis2: string,
): Promise<Result> {
  const { siteId } = await requireCapability('products.edit')
  try {
    await attachChild(siteId, parentId, childId, axis1, axis2)
    revalidatePath(`/products/${parentId}`)
    return { ok: true }
  } catch (error) {
    return failed(error)
  }
}

export async function detachChildAction(parentId: number, childId: number): Promise<Result> {
  const { siteId } = await requireCapability('products.edit')
  try {
    await detachChild(siteId, childId)
    revalidatePath(`/products/${parentId}`)
    return { ok: true }
  } catch (error) {
    return failed(error)
  }
}

export async function unmakeParentAction(productId: number): Promise<Result> {
  const { siteId } = await requireCapability('products.edit')
  try {
    await unmakeParent(siteId, productId)
    revalidatePath(`/products/${productId}`)
    return { ok: true }
  } catch (error) {
    return failed(error)
  }
}

export async function reorderVariantsAction(
  parentId: number,
  orderedIds: number[],
): Promise<Result> {
  const { siteId } = await requireCapability('products.edit')
  try {
    await setVariantOrder(siteId, parentId, orderedIds)
    revalidatePath(`/products/${parentId}`)
    return { ok: true }
  } catch (error) {
    return failed(error)
  }
}

/** Re-read the group after a change, so the panel redraws from the truth. */
export async function loadGroupAction(parentId: number): Promise<VariantGroup | null> {
  const { siteId } = await requireCapability('products.edit')
  return getGroup(siteId, parentId)
}

/**
 * Candidates to attach.
 *
 * searchProductsForPicker already hides parents and archived rows. It does not
 * hide products that are already someone else's variant — attachChild refuses
 * those, and showing them with the reason is kinder than a search that
 * silently omits the product someone is looking straight at.
 */
export async function searchAttachableAction(
  parentId: number,
  search: string,
): Promise<ProductPick[]> {
  const { siteId } = await requireCapability('products.edit')
  const rows = await searchProductsForPicker(siteId, { search, exclude: parentId, limit: 20 })
  return rows
}
