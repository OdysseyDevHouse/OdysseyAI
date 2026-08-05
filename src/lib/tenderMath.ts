import { round } from './decimals'

/**
 * The tender rules, as pure functions.
 *
 * Split out of site/tenderTypes.ts because that module is `server-only` (it
 * talks to the database) while the till's tender pad is a Client Component that
 * needs the SAME arithmetic to show a running change figure as the cashier
 * types. Duplicating the rules on the client is how the screen and the posting
 * engine end up disagreeing about what is owed.
 *
 * Same reasoning as documentMath.ts and site/ledger.ts: the rules live where
 * both sides can reach them, and only the SQL stays server-side.
 */

/** The behaviour flags the engine branches on. A subset of the stored row. */
export type TenderBehaviour = {
  id: number
  name: string
  postsToDebtor: boolean
  requiresCustomer: boolean
  countsAsDrawerCash: boolean
  allowsChange: boolean
  allowsSplit: boolean
  requiresReference: boolean
  referenceLabel: string | null
  roundsToCashDenomination: boolean
  minAmount: number
  maxAmount: number
  surchargePct: number
}

export type TenderLine = {
  tender: TenderBehaviour
  /** What the customer handed over — gross, not the amount owed. */
  amount: number
  reference?: string | null
}

export type TenderCheck = {
  /** Sum of what was handed over. */
  tendered: number
  /** What still has to be covered. Zero once settled. */
  outstanding: number
  /** Only a drawer-cash tender can give change. */
  change: number
  surcharge: number
  errors: string[]
}

/**
 * Validates a set of tenders against a document total.
 *
 * THE RULE worth stating: R100 cash on an R87.50 sale is a R100 tender with
 * R12.50 change, NOT an R87.50 tender. Store the net and the drawer is short
 * R12.50 at every cash-up with nothing to explain it.
 */
export function checkTenders(
  lines: readonly TenderLine[],
  totalIncl: number,
  hasCustomer: boolean,
): TenderCheck {
  const errors: string[] = []
  let tendered = 0
  let surcharge = 0

  for (const line of lines) {
    const { tender, amount } = line

    if (amount <= 0) errors.push(`${tender.name}: enter an amount.`)
    if (tender.requiresCustomer && !hasCustomer) {
      // Not "<name> needs a customer account" — the tender is usually CALLED
      // "Account", and "Account needs a customer account" reads like a stutter.
      errors.push(`${tender.name}: attach a customer first.`)
    }
    if (tender.requiresReference && !line.reference?.trim()) {
      errors.push(`${tender.name} needs a ${tender.referenceLabel ?? 'reference'}.`)
    }
    if (tender.minAmount > 0 && amount < tender.minAmount) {
      errors.push(`${tender.name} has a minimum of ${tender.minAmount.toFixed(2)}.`)
    }
    if (tender.maxAmount > 0 && amount > tender.maxAmount) {
      errors.push(`${tender.name} has a maximum of ${tender.maxAmount.toFixed(2)}.`)
    }
    if (!tender.allowsSplit && lines.length > 1) {
      errors.push(`${tender.name} cannot be combined with another tender.`)
    }

    tendered = round(tendered + amount, 2)
    if (tender.surchargePct > 0) {
      surcharge = round(surcharge + amount * (tender.surchargePct / 100), 2)
    }
  }

  const payable = round(totalIncl + surcharge, 2)
  const over = round(tendered - payable, 2)

  let change = 0
  if (over > 0) {
    // Change comes out of the drawer, so it can only be given when a
    // drawer-cash tender is present. Over-tendering a card is a capture error,
    // not a request for change.
    const cashGiven = lines
      .filter((l) => l.tender.allowsChange)
      .reduce((sum, l) => round(sum + l.amount, 2), 0)

    if (cashGiven >= over) {
      change = over
    } else {
      errors.push(
        `Over-tendered by ${over.toFixed(2)}, but only ${cashGiven.toFixed(2)} can give change.`,
      )
    }
  }

  return {
    tendered,
    outstanding: over < 0 ? round(-over, 2) : 0,
    change,
    surcharge,
    errors,
  }
}
