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
  createVariantGrid,
  VariantError,
  type VariantGroup,
  type CreateGridInput,
} from '@/lib/site/productVariants'
import { searchProductsForPicker, getProduct, type ProductPick } from '@/lib/site/products'
import { listPriceStructures } from '@/lib/site/lookups'
import { getBooleanSetting } from '@/lib/site/settings'

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

/* ── The grid wizard ──────────────────────────────────────────────────── */

/**
 * What the wizard needs to open: the parent's own code, description, cost and
 * price, so the grid starts pre-filled rather than blank.
 *
 * Read on the server rather than passed down from the product page because the
 * panel does not have the price structures and would have had to be given them
 * for this one dialog — and the wizard is opened rarely, while the page renders
 * on every visit.
 */
export type GridSeedData = {
  code: string
  description: string
  costExcl: number
  sellIncl: number
  priceStructureId: number | null
  structureName: string
  /** True when the site invents product codes, so the code boxes say "Auto". */
  autoCode: boolean
}

export async function gridSeedAction(productId: number): Promise<GridSeedData | null> {
  const { siteId } = await requireCapability('products.edit')
  const product = await getProduct(siteId, productId)
  if (!product) return null

  const structures = await listPriceStructures(siteId)
  const structure = structures.find((s) => s.isDefault) ?? structures[0] ?? null

  // The price the grid pre-fills every row with is the one from the structure
  // it will WRITE to, so what the person sees offered is what gets saved.
  const price = product.prices.find((p) => p.priceStructureId === structure?.id)

  return {
    code: product.code,
    description: product.description,
    costExcl: product.lastCost,
    sellIncl: price?.sellIncl ?? 0,
    priceStructureId: structure?.id ?? null,
    structureName: structure?.name ?? 'Selling price',
    // A suggestion is a convenience: if the setting cannot be read the wizard
    // should still open, with the derived codes it would have used anyway.
    autoCode: await getBooleanSetting(siteId, 'autocode_product').catch(() => false),
  }
}

export async function createVariantGridAction(
  input: CreateGridInput,
): Promise<{ ok: true; created: number } | { ok: false; error: string }> {
  const { siteId, actor } = await requireCapability('products.edit')
  try {
    const result = await createVariantGrid(siteId, input, {
      source: 'editor',
      userName: actor.userName,
    })
    if (result.ok) revalidatePath(`/products/${input.parentId}`)
    return result
  } catch (error) {
    /* failed() narrows to Result, which carries no created count. Its refusal
       arm is the one that matters here — a throw created nothing — so the
       shape is widened rather than the message reinvented. */
    const refusal = failed(error)
    return refusal.ok ? { ok: true, created: 0 } : refusal
  }
}
