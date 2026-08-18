import 'server-only'
import type { AlertMessage } from './message'
import type { AlertRule } from './types'
import { evaluateNegativeStock, negativeStockMessage } from './kinds/negativeStock'

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
  /** What the check DID: document numbers created in the owner's name. */
  createdDocs: string[]
  message: AlertMessage
}

export async function evaluateRule(siteId: number, rule: AlertRule): Promise<Finding> {
  switch (rule.kind) {
    case 'negative_stock': {
      const result = await evaluateNegativeStock(siteId)
      return {
        itemCount: result.total,
        createdDocs: [],
        message: negativeStockMessage(rule, result),
      }
    }

    // Not yet written. Listed rather than left to the default branch below, so
    // adding a kind to the union is a compile error here until its evaluator
    // exists — which is the point of having no default.
    case 'low_stock':
    case 'price_below_cost':
    case 'dead_stock':
    case 'cashup_variance':
    case 'missing_cashup':
    case 'credit_limit':
    case 'unprocessed_grvs':
      break
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
