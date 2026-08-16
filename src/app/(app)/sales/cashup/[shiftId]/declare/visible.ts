import type { DeclarationView } from '@/lib/site/cashupDeclaration'

/**
 * What the browser is allowed to know about a cash-up in progress.
 *
 * ── THIS IS WHERE THE BLIND COUNT IS ENFORCED ───────────────────────────────
 *
 * `declarationView` computes every figure, expected ones included. A cashier who
 * can see the target is copying rather than counting, so an expected figure is
 * REMOVED from the payload until a number has been committed for that tender.
 *
 * Removed on the server, not hidden with CSS. A figure that reaches the browser
 * is one somebody can read in devtools, and "the count was blind" would then be
 * a claim the software cannot actually make.
 *
 * Its own module because both the page (server component) and the action need
 * it, and a `'use server'` file may only export async functions — putting it
 * there would make every helper a callable endpoint.
 */

export type VisibleTender = {
  tenderTypeId: number
  tenderCode: string
  tenderName: string
  countsAsDrawerCash: boolean
  declared: number | null
  transactionCount: number
  /** Null until this tender has been declared. */
  expected: number | null
  takings: number | null
  floatIncluded: number | null
  movementsIncluded: number | null
  variance: number | null
}

export type VisibleDeclaration = Omit<
  DeclarationView,
  'tenders' | 'openedAt' | 'finalizedAt'
> & {
  tenders: VisibleTender[]
  openedAt: string
  finalizedAt: string | null
  /** Only once every tender is declared — the headline is a total or nothing. */
  totalVariance: number | null
  expectedCashVisible: number | null
}

/**
 * A FINALIZED declaration is exempt.
 *
 * It is a record being read back, the count is long over, and withholding
 * figures from a signed cash-up would make the "View" action useless for the one
 * job it has.
 */
export function visibleFor(view: DeclarationView): VisibleDeclaration {
  const signed = view.finalizedAt !== null

  const tenders: VisibleTender[] = view.tenders.map((t) => {
    const revealed = signed || t.declared !== null
    return {
      tenderTypeId: t.tenderTypeId,
      tenderCode: t.tenderCode,
      tenderName: t.tenderName,
      countsAsDrawerCash: t.countsAsDrawerCash,
      declared: t.declared,
      transactionCount: t.transactionCount,
      expected: revealed ? t.expected : null,
      takings: revealed ? t.takings : null,
      floatIncluded: revealed ? t.floatIncluded : null,
      movementsIncluded: revealed ? t.movementsIncluded : null,
      variance:
        revealed && t.declared !== null
          ? Math.round((t.declared - t.expected) * 100) / 100
          : null,
    }
  })

  const everyTenderDeclared = view.tenders.every((t) => t.declared !== null)
  const totalVariance =
    signed || everyTenderDeclared
      ? Math.round(
          view.tenders.reduce((sum, t) => sum + ((t.declared ?? 0) - t.expected), 0) * 100,
        ) / 100
      : null

  /* The cash tender's expected figure IS the expected cash, so publishing it
     here would hand back precisely what counting the drawer is meant to test. */
  const cashRevealed =
    signed || view.tenders.some((t) => t.countsAsDrawerCash && t.declared !== null)

  return {
    ...view,
    tenders,
    openedAt: view.openedAt.toISOString(),
    finalizedAt: view.finalizedAt ? view.finalizedAt.toISOString() : null,
    totalVariance,
    expectedCashVisible: cashRevealed ? view.expectedCash : null,
  }
}
