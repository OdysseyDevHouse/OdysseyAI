'use server'

import { actorFor } from '@/lib/auth'
import { validateCode, type DiscountBasketLine } from '@/lib/site/discountCodes'

/**
 * A promo code, checked against the basket ON the counter.
 *
 * `validateCode` stays the ONE authority — exactly as its docblock demands.
 * What this adds is the till's own rulings, applied BEFORE the shared check:
 *
 *   free_delivery does nothing here — there is no delivery fee at a counter.
 *
 *   first_order_only and per-customer limits need an IDENTITY. Online that is
 *   the email on the order; at a counter there is none, so those codes demand
 *   an attached customer — enforcement over convenience, the storefront's own
 *   guarantee kept.
 *
 * The reduction is applied client-side through the doc-discount machinery
 * (masked to the eligible lines) and the code is SPENT transactionally at
 * finalise, so the last use of a single-use code cannot go to two tills.
 */

export type TillCodeResult =
  | {
      ok: true
      codeId: number
      code: string
      /** What comes off the eligible goods, as validateCode priced it. */
      discountIncl: number
      /** Basket keys the code may reduce. Empty set means the whole basket. */
      eligibleKeys: string[] | null
      reason: string
    }
  | { ok: false; error: string }

export async function validateTillCodeAction(
  rawCode: string,
  basket: {
    lines: {
      key: string
      productId: number | null
      qty: number
      unitPriceIncl: number
      onSpecial: boolean
      departmentId: number | null
    }[]
    customerId: number | null
  },
): Promise<TillCodeResult> {
  const ctx = await actorFor('sales.till')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  /* Free-text lines have no product and cannot be judged for eligibility —
     they are excluded rather than guessed at. */
  const judged = basket.lines.filter(
    (l): l is typeof l & { productId: number } => l.productId !== null,
  )
  const lines: DiscountBasketLine[] = judged.map((l) => ({
    productId: l.productId,
    qty: l.qty,
    unitPriceIncl: l.unitPriceIncl,
    onSpecial: l.onSpecial,
    departmentId: l.departmentId,
  }))

  const result = await validateCode(siteId, rawCode, {
    lines,
    deliveryFeeIncl: 0,
    customerId: basket.customerId,
    contactEmail: undefined,
  })
  if (!result.ok) return result

  const { code, discountIncl, freeDelivery, reason } = result.application

  if (code.kind === 'free_delivery' || (freeDelivery && discountIncl <= 0)) {
    return { ok: false, error: 'That code waives a delivery fee — it does nothing at the till.' }
  }
  /* Identity-bound rules with nobody attached: refuse rather than quietly
     letting a walk-in dodge a limit the storefront enforces. */
  if ((code.firstOrderOnly || code.maxUsesPerCustomer !== null) && !basket.customerId) {
    return {
      ok: false,
      error: code.firstOrderOnly
        ? 'That code is for a first order — attach the customer so it can be checked.'
        : 'That code is limited per customer — attach the customer to use it.',
    }
  }
  if (discountIncl <= 0) {
    return { ok: false, error: 'That code takes nothing off this basket.' }
  }

  /* Which lines it may reduce, as basket keys. A department-scoped code masks
     the doc-discount spread to its own goods; null means the whole basket. */
  const eligibleKeys =
    code.departmentId === null
      ? null
      : judged
          .filter((l) => l.departmentId === code.departmentId)
          .map((l) => l.key)
  /* A scoped code with combines_with_specials off must also skip the special
     lines — validateCode already priced the discount off the eligible subset,
     so the mask only has to match its arithmetic. */
  const finalKeys =
    !code.combinesWithSpecials
      ? (eligibleKeys ?? judged.map((l) => l.key)).filter(
          (key) => !judged.find((l) => l.key === key)?.onSpecial,
        )
      : eligibleKeys

  return {
    ok: true,
    codeId: code.id,
    code: code.code,
    discountIncl,
    eligibleKeys: finalKeys,
    reason,
  }
}
