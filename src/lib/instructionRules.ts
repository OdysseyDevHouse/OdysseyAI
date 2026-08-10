import { round } from './decimals'
import type { TillInstructionGroup, TillInstructionOption } from './site/instructions'

/**
 * What was chosen when a till asked its questions, and the arithmetic on it.
 *
 * ── PURE, AND NO `server-only` ────────────────────────────────────────────
 *
 * Every function here is value-in value-out: no React, no fetch, no database.
 * That is what lets the till run them in the browser with no network, and it is
 * why the SERVER runs the same ones when the sale is posted.
 *
 * That second half is the point. An offline slip is printed by this code and the
 * invoice is written by `saveDraft`; if the two computed the modifier price
 * separately they would agree by luck rather than by construction, and the first
 * time they disagreed it would be a customer holding a receipt that does not
 * match their statement. Same reasoning as documentMath and finaliseOffline.
 *
 * ── WHAT LIVES HERE AND WHAT DOES NOT ─────────────────────────────────────
 *
 * Here: how many of an answer may be taken, what the answers add up to, and how
 * to say what was chosen in words.
 *
 * Not here: what the line ends up costing. The adjustment is folded into the
 * line's own `unitPriceIncl` by the caller, so specials, discounts and VAT all
 * see the item at the price it was actually sold at — see basket.ts.
 */

/** One answer, as chosen on a line. Snapshotted, so it survives the option. */
export type ChosenOption = {
  groupId: number
  groupName: string
  optionId: number
  optionName: string
  /**
   * How many of this answer ONE ITEM on the line carries.
   *
   * Per item, not per line: two burgers each with bacon ×3 stores 3, and the
   * line's own quantity does the multiplying. Storing 6 would be unreadable the
   * moment somebody changed the line quantity.
   */
  qty: number
  /** What ONE of this answer adds, INCLUSIVE of VAT. Signed. */
  priceAdjustIncl: number
  /** Set when choosing this deducts a stocked product. */
  productId: number | null
  /** How much of that product ONE of this answer consumes. */
  stockQtyPer: number
  printsOnKitchen: boolean
  printsOnReceipt: boolean
}

/** A fresh choice from a library option, at the count the till is offering. */
export function chooseOption(
  group: { id: number; name: string },
  option: TillInstructionOption,
  qty: number,
): ChosenOption {
  return {
    groupId: group.id,
    groupName: group.name,
    optionId: option.id,
    optionName: option.name,
    qty,
    priceAdjustIncl: option.priceAdjust,
    productId: option.productId,
    stockQtyPer: option.quantity,
    printsOnKitchen: option.printsOnKitchen,
    printsOnReceipt: option.printsOnReceipt,
  }
}

/**
 * What the answers add to ONE item on the line, VAT-inclusive and signed.
 *
 * Rounded to four places, matching the DECIMAL(12,4) the price columns are:
 * repeated addition of unrounded floats drifts, and the figure this returns is
 * added to a price that will be compared against the shelf to a cent.
 */
export function adjustPerUnit(chosen: readonly ChosenOption[]): number {
  return round(
    chosen.reduce((sum, c) => sum + c.priceAdjustIncl * c.qty, 0),
    4,
  )
}

/** The count of an option the till should start with. */
export function startingQty(option: TillInstructionOption): number {
  if (!option.isDefault) return 0
  // A pre-ticked answer at a count of nothing is not a state anybody means.
  return Math.max(1, option.defaultQty || 1, option.minQty)
}

/** How much of a linked product this line consumes, across its whole quantity. */
export function stockForOption(chosen: ChosenOption, lineQty: number): number {
  return round(chosen.stockQtyPer * chosen.qty * lineQty, 3)
}

/**
 * Whether a set of answers satisfies the questions, or the first reason it does
 * not.
 *
 * Returns a message rather than throwing, so the till can put it beside the
 * question the cashier still has to answer — a refused line with a customer
 * standing there needs to say which one and why.
 *
 * Only groups that are actually BEING ASKED are checked. A nested question whose
 * revealing answer was not chosen is not unanswered, it is not asked, and
 * requiring it would make a required follow-up impossible to get past.
 */
export function validateSelection(
  asked: readonly TillInstructionGroup[],
  chosen: readonly ChosenOption[],
): string | null {
  for (const group of asked) {
    const picked = chosen.filter((c) => c.groupId === group.id)
    const distinct = picked.length
    const label = group.prompt || group.name

    // ── The group's own bounds: how many DISTINCT answers ──────────────────
    //
    // Distinct answers, NOT units. "Up to 2 toppings" with bacon ×3 and cheese
    // ×1 is two choices against that ceiling, not four. Summing the counts here
    // would refuse an order the shop plainly meant to allow.
    if ((group.isRequired || group.minChoices > 0) && distinct === 0) {
      return `${label}: please choose an answer.`
    }
    if (group.minChoices > 0 && distinct < group.minChoices) {
      return `${label}: choose at least ${group.minChoices}.`
    }
    if (group.maxChoices > 0 && distinct > group.maxChoices) {
      return `${label}: choose no more than ${group.maxChoices}.`
    }

    // ── Each answer's own count ────────────────────────────────────────────
    for (const c of picked) {
      const option = group.options.find((o) => o.id === c.optionId)
      if (!option) continue
      if (c.qty <= 0) return `${label}: “${c.optionName}” needs a quantity.`
      if (option.maxQty > 0 && c.qty > option.maxQty) {
        return `${label}: at most ${option.maxQty} × “${c.optionName}”.`
      }
      if (option.minQty > 0 && c.qty < option.minQty) {
        return `${label}: at least ${option.minQty} × “${c.optionName}”.`
      }
    }
  }

  return null
}

/**
 * Which questions are actually being asked, given what has been chosen so far.
 *
 * A product names the questions it starts on; an answer may go on to ask more.
 * Walking it here rather than in the modal keeps "what is being asked" one
 * definition, which `validateSelection` and the ticket renderer both need to
 * agree with.
 *
 * The visited-set is not decoration. `readInstructionLibrary` already refuses to
 * ship a cycle, but this runs against whatever a till happens to be holding —
 * including a catalogue downloaded before a config was fixed — and a till that
 * loops is a till with a customer standing in front of it.
 */
export function askedGroups(
  startIds: readonly number[],
  byId: ReadonlyMap<number, TillInstructionGroup>,
  chosen: readonly ChosenOption[],
): TillInstructionGroup[] {
  const asked: TillInstructionGroup[] = []
  const seen = new Set<number>()

  const walk = (ids: readonly number[]) => {
    for (const id of ids) {
      if (seen.has(id)) continue
      const group = byId.get(id)
      if (!group) continue
      seen.add(id)
      asked.push(group)

      // Only answers that were actually chosen open their follow-ups.
      for (const option of group.options) {
        if (!option.revealsGroupIds.length) continue
        if (!chosen.some((c) => c.optionId === option.id && c.qty > 0)) continue
        walk(option.revealsGroupIds)
      }
    }
  }

  walk(startIds)
  return asked
}

/**
 * Answers that are no longer being asked.
 *
 * Unticking "make it a meal" must take the side and the drink with it, or the
 * line quietly keeps charging for a side nobody can see on screen.
 */
export function pruneUnasked(
  asked: readonly TillInstructionGroup[],
  chosen: readonly ChosenOption[],
): ChosenOption[] {
  const askedIds = new Set(asked.map((g) => g.id))
  return chosen.filter((c) => askedIds.has(c.groupId))
}

/**
 * What was chosen, in words, for a receipt or a kitchen ticket.
 *
 * The filter is the whole reason the two print flags exist: "no onions" costs
 * nothing, must reach the cook, and is clutter on the customer's slip.
 */
export function describeSelection(
  chosen: readonly ChosenOption[],
  audience: 'kitchen' | 'receipt' | 'all' = 'all',
): string[] {
  return chosen
    .filter((c) => {
      if (audience === 'kitchen') return c.printsOnKitchen
      if (audience === 'receipt') return c.printsOnReceipt
      return true
    })
    .map((c) => (c.qty > 1 ? `${c.optionName} ×${c.qty}` : c.optionName))
}
