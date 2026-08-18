import type { DeclarationView } from '@/lib/site/cashupDeclaration'

/**
 * What the browser is told about a cash-up in progress.
 *
 * ── TWO PEOPLE, TWO ANSWERS ─────────────────────────────────────────────────
 *
 * The same declaration is counted by two kinds of person, for two reasons:
 *
 *   THE PERSON BEING CHECKED counts their own drawer. Publishing what it should
 *   hold turns counting into copying, so every expected figure is withheld until
 *   a number has been committed for that tender.
 *
 *   THE PERSON DOING THE CHECKING reconciles a shift. Withholding the figures
 *   there protects nothing; it just means the screen cannot answer the question
 *   it exists for until somebody types a number, and the reveal wrote to the
 *   database as a side effect of looking.
 *
 * Which one you are is a PERMISSION — `sales.cashup_expected` — and not which
 * screen you opened. It was briefly the screen: the till blind, the back office
 * not. That is wrong in both directions. An owner who works their own counter
 * cashes up at the till and has nobody to hide figures from; a junior clerk with
 * a back-office login is exactly the person a blind count is for.
 *
 * Hence the parameter rather than one rule. It defaults to blind so a new caller
 * has to ASK to see everything — a screen that leaks the target by forgetting an
 * argument is the failure worth making impossible.
 *
 * Either way the stripping happens on the SERVER, not with CSS. A figure that
 * reaches the browser is one somebody can read in devtools, and "the count was
 * blind" would then be a claim the software cannot actually make.
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
  /** Null while blind and uncounted. Always populated for a reconciler. */
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
 * @param blind Withhold expected figures until each tender is counted. Both
 *   callers pass `!can(capabilities, 'sales.cashup_expected')` — the person,
 *   not the screen. Defaults to blind, so a caller that forgets cannot leak.
 *
 * A FINALIZED declaration is exempt either way. It is a record being read back,
 * the count is long over, and withholding figures from a signed cash-up would
 * make the "View" action useless for the one job it has.
 */
export function visibleFor(view: DeclarationView, blind = true): VisibleDeclaration {
  const signed = view.finalizedAt !== null
  const showAll = signed || !blind

  const tenders: VisibleTender[] = view.tenders.map((t) => {
    const revealed = showAll || t.declared !== null
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
      /* Still null until a count exists, even when everything is on show: a
         difference against nothing is not zero, it is a question nobody has
         answered yet. */
      variance:
        revealed && t.declared !== null
          ? Math.round((t.declared - t.expected) * 100) / 100
          : null,
    }
  })

  /* The total stays gated on a COMPLETE count in both modes. Summing the
     differences of the tenders done so far reads as "the shift is R40 short"
     when the truth is "three of five tenders are counted", and that is the
     figure somebody signs their name under. */
  const everyTenderDeclared = view.tenders.every((t) => t.declared !== null)
  const totalVariance =
    signed || everyTenderDeclared
      ? Math.round(
          view.tenders.reduce((sum, t) => sum + ((t.declared ?? 0) - t.expected), 0) * 100,
        ) / 100
      : null

  /* The cash tender's expected figure IS the expected cash, so publishing it
     while blind would hand back precisely what counting the drawer tests. */
  const cashRevealed =
    showAll || view.tenders.some((t) => t.countsAsDrawerCash && t.declared !== null)

  return {
    ...view,
    tenders,
    openedAt: view.openedAt.toISOString(),
    finalizedAt: view.finalizedAt ? view.finalizedAt.toISOString() : null,
    totalVariance,
    expectedCashVisible: cashRevealed ? view.expectedCash : null,
  }
}
