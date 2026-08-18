import 'server-only'
import type { AlertMessage } from './message'
import type { AlertRule } from './types'
import { cashupVarianceMessage, evaluateCashupVariance } from './kinds/cashupVariance'
import { creditLimitMessage, evaluateCreditLimit } from './kinds/creditLimit'
import { deadStockMessage, evaluateDeadStock } from './kinds/deadStock'
import { evaluateLowStock, lowStockMessage } from './kinds/lowStock'
import { evaluateMissingCashup, missingCashupMessage } from './kinds/missingCashup'
import { evaluateNegativeStock, negativeStockMessage } from './kinds/negativeStock'
import { evaluatePriceBelowCost, priceBelowCostMessage } from './kinds/priceBelowCost'
import { evaluateUnprocessedGrvs, unprocessedGrvsMessage } from './kinds/unprocessedGrvs'

/**
 * The rule-kind registry: run one rule's check, and say what it found.
 *
 * Every kind is one file under ./kinds exporting a pair — an `evaluate` that
 * asks the shop a question, and a `message` that turns the answer into
 * something a person reads. Adding a kind is those two functions, one case
 * below, and one entry in the AlertKind union. Nothing else in the feature
 * knows how many kinds there are.
 */

export type Finding = {
  /** What the check found. 0 means all clear — nobody is interrupted. */
  itemCount: number
  /**
   * What the check DID, in the owner's name — one readable label per document.
   *
   * Not document NUMBERS: the only kind that writes leaves drafts, and a draft
   * has no number until it is issued. See LowStockOrder.label.
   */
  createdDocs: string[]
  message: AlertMessage
}

/**
 * The rule's owner, passed to the kinds that WRITE.
 *
 * An automation's work is attributed to the person whose rule it is, never to
 * a system pseudo-user: a draft order that appears overnight must answer the
 * question "who raised this" with a name somebody can go and ask.
 */
export type RuleActor = { userId: number; userName: string }

export async function evaluateRule(
  siteId: number,
  rule: AlertRule,
  actor: RuleActor,
): Promise<Finding> {
  switch (rule.kind) {
    case 'low_stock': {
      const result = await evaluateLowStock(siteId, rule, actor)
      return {
        itemCount: result.total,
        // The drafts this run raised — the ledger's audit answer to "where did
        // this order come from".
        createdDocs: result.createdOrders.map((o) => o.label),
        message: lowStockMessage(rule, result),
      }
    }

    case 'negative_stock': {
      const result = await evaluateNegativeStock(siteId)
      return {
        itemCount: result.total,
        createdDocs: [],
        message: negativeStockMessage(rule, result),
      }
    }

    case 'price_below_cost': {
      const result = await evaluatePriceBelowCost(siteId, rule)
      return {
        itemCount: result.total,
        createdDocs: [],
        message: priceBelowCostMessage(rule, result),
      }
    }

    case 'dead_stock': {
      const result = await evaluateDeadStock(siteId, rule)
      return {
        itemCount: result.total,
        createdDocs: [],
        message: deadStockMessage(rule, result),
      }
    }

    case 'cashup_variance': {
      const result = await evaluateCashupVariance(siteId, rule)
      return {
        itemCount: result.total,
        createdDocs: [],
        message: cashupVarianceMessage(rule, result),
      }
    }

    case 'missing_cashup': {
      const result = await evaluateMissingCashup(siteId)
      return {
        itemCount: result.total,
        createdDocs: [],
        message: missingCashupMessage(rule, result),
      }
    }

    case 'credit_limit': {
      const result = await evaluateCreditLimit(siteId, rule)
      return {
        itemCount: result.total,
        createdDocs: [],
        message: creditLimitMessage(rule, result),
      }
    }

    case 'unprocessed_grvs': {
      const result = await evaluateUnprocessedGrvs(siteId, rule)
      return {
        itemCount: result.total,
        createdDocs: [],
        message: unprocessedGrvsMessage(rule, result),
      }
    }
  }

  /*
   * NO `default:` ON PURPOSE.
   *
   * A default branch would silently run SOME OTHER rule's check for a kind
   * whose evaluator has not been written — an alert reporting the wrong thing
   * under the right name, which is worse than one that does not run, because
   * somebody would believe it.
   *
   * With the switch exhaustive, TypeScript fails the build the moment a kind is
   * added to the union without a case. At runtime, a row written by a newer
   * build fails this ONE occurrence loudly rather than quietly misreporting.
   */
  throw new Error(`This alert's check ("${rule.kind}") is not available in this version.`)
}
