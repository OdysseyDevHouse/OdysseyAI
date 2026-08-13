'use client'

import { useReducer } from 'react'
import {
  addToBasket,
  lineFromProduct,
  removeBasketLine,
  stepQty,
  updateBasketLine,
  withInstructions,
  type BasketLine,
} from '@/lib/basket'
import type { ChosenOption } from '@/lib/instructionRules'
import type { TillProduct } from '@/lib/site/tillSearch'
import type { TillCustomer } from '@/lib/site/tillCustomers'

/**
 * Everything the till knows about the sale in front of it, in one reducer.
 *
 * ── WHY A REDUCER AND NOT useState ────────────────────────────────────────
 *
 * The screen this replaces holds fourteen useState calls, and the POS it is
 * modelled on holds hundreds inside a 10,569-line component. That is not a style
 * problem, it is a correctness one: "clear the basket" has to reset the lines AND
 * the customer AND the selected line AND the draft id, and any handler that
 * forgets one leaves a customer attached to the next sale. Here that is a single
 * `CLEAR` case and it cannot be half-done.
 *
 * ── PURE, AND SEPARATELY TESTABLE ─────────────────────────────────────────
 *
 * `saleReducer` is exported on its own and touches nothing but its arguments —
 * no fetch, no Date.now beyond what basket.ts needs for keys, no toasts. A test
 * drives it with no database and no browser.
 *
 * What is NOT here: money. Totals come from documentMath, discounts from
 * specialsEngine, tender arithmetic from tenderMath — all already pure and
 * already shared with the server, which is what makes an offline sale's figures
 * match what the server recomputes at sync. Duplicating any of it here is how
 * they would drift apart.
 */

/** Which pane of the catalogue is showing. */
export type CatalogView =
  /** The quick-key grid — the resting state. */
  | { kind: 'keys' }
  /** Drilled into the department tree. `path` is ids from the root down. */
  | { kind: 'departments'; path: number[] }
  /** Search results for a typed term. */
  | { kind: 'search'; term: string }

export type SaleState = {
  lines: BasketLine[]
  /** The line whose action row is open. One at a time — a till is not a form. */
  selectedKey: string | null
  /** The draft this basket was recalled from, if any. */
  documentId: number | null
  customer: TillCustomer | null
  /** A walk-in's name, typed. Not a customer record and creates no debtor. */
  customerName: string
  catalog: CatalogView
  /** The search box's live value, kept whether or not results are showing. */
  query: string
  /**
   * Whether this basket is a RETURN rather than a sale.
   *
   * A mode on the one basket rather than a second basket, because a return is
   * structurally the same thing: items, quantities, prices. The tiles, the reducer, the
   * line cards and the qty stepper all behave identically, and duplicating them to flip
   * one sign is how two baskets drift apart on discount ceilings and rounding.
   *
   * What the mode DOES change, and both matter:
   *
   *   · SPECIALS DO NOT APPLY. A "buy 2 get 1 free" that triggered on a return would
   *     credit a customer for a promotion they are handing back. See PosShell, which
   *     passes an empty specials list in this mode rather than filtering afterwards.
   *   · The sign is flipped at POSTING, not here. Lines stay positive in the basket
   *     because that is what a cashier types and what the screen shows; `createCreditNote`
   *     is what stores them negative, and it is the only thing that should know the
   *     convention.
   */
  returning: boolean
}

export const initialSaleState: SaleState = {
  lines: [],
  selectedKey: null,
  documentId: null,
  customer: null,
  customerName: '',
  catalog: { kind: 'keys' },
  query: '',
  returning: false,
}

export type SaleAction =
  /**
   * `resolvedIncl` is the price after any scheduled change that is due — see
   * lib/priceSchedules. Resolved by the caller, which holds the clock and the
   * pending list, rather than here: a reducer that read the time would not be
   * a pure function of its arguments.
   */
  | { type: 'ADD'; product: TillProduct; qty?: number; resolvedIncl?: number }
  /**
   * The same, but with the product's questions already answered.
   *
   * Its own action rather than ADD-then-UPDATE so the line is never on screen at
   * the unanswered price, even for one frame — a burger flashing at R60 before
   * becoming R64.50 is a thing a cashier will report, and with a customer
   * watching the screen it is worse than a bug that only developers notice.
   */
  | {
      type: 'ADD_WITH_INSTRUCTIONS'
      product: TillProduct
      qty: number
      resolvedIncl?: number
      instructions: ChosenOption[]
      note: string
    }
  | { type: 'SELECT'; key: string | null }
  | { type: 'STEP'; key: string; delta: number }
  | { type: 'UPDATE'; key: string; changes: Partial<BasketLine> }
  | { type: 'REMOVE'; key: string }
  | { type: 'CLEAR' }
  | { type: 'SET_CUSTOMER'; customer: TillCustomer | null }
  | { type: 'SET_CUSTOMER_NAME'; name: string }
  | { type: 'SET_QUERY'; query: string }
  | { type: 'SHOW_KEYS' }
  | { type: 'DRILL'; departmentId: number }
  | { type: 'DRILL_TO'; path: number[] }
  | { type: 'SHOW_SEARCH'; term: string }
  /**
   * Switch between ringing up a sale and taking a return.
   *
   * CLEARS THE BASKET, always, in both directions. A sale and a return are separate
   * documents — `sales_documents.doc_type` is one value per row — so a basket holding
   * both could not post as either. Silently keeping the lines would let a cashier build
   * a mixed basket and only discover at Pay that half of it cannot go anywhere.
   *
   * Clearing on the way OUT as well is the less obvious half, and it is deliberate:
   * leaving a return's lines behind when someone taps back to Sale would ring them up as
   * a SALE of the goods just handed in. Same items, same prices, opposite direction, and
   * nothing on the screen would look wrong.
   */
  | { type: 'SET_RETURNING'; returning: boolean }
  /**
   * The basket now has a server document, without changing anything in it.
   *
   * For a table's first item: the bill is created on the server, and the reducer has to
   * learn its id so every later save UPDATES that document rather than creating a second
   * bill for the same table. Distinct from LOAD, which replaces the lines — here the
   * lines are already right and only the id is new.
   */
  | { type: 'ATTACH_DOCUMENT'; documentId: number }
  /** A recalled draft replaces the basket wholesale. */
  | {
      type: 'LOAD'
      /**
       * The server document this basket came from, or null.
       *
       * Null for one parked on the till itself while it had no network: there is no
       * document, and the next save must therefore CREATE one rather than update an
       * id that does not exist. `saveDraft` already treats an absent id that way, so
       * null is the correct value rather than a placeholder.
       */
      documentId: number | null
      lines: BasketLine[]
      customer?: TillCustomer | null
      /** The name on the parked document, kept even when the account is not. */
      customerName?: string
    }

export function saleReducer(state: SaleState, action: SaleAction): SaleState {
  switch (action.type) {
    case 'ADD': {
      const lines = addToBasket(
        state.lines,
        action.product,
        action.qty ?? 1,
        action.resolvedIncl ?? action.product.priceIncl,
        // The attached account's standing discount rides every add — capped
        // per product inside the basket rules. A walk-in adds at zero.
        state.customer?.discountPct ?? 0,
      )
      return {
        ...state,
        lines,
        // Adding closes any open action row. Leaving it open means the next tap
        // on + or − lands on the line the cashier stopped looking at.
        selectedKey: null,
        // The search BOX is cleared so the next scan starts clean — a scanner
        // appends, and a barcode landing after "milk" resolves to nothing.
        query: '',
        /*
         * But the RESULTS stay on screen.
         *
         * An earlier version reset the pane to the quick keys here, on the
         * reasoning that the cashier had got what they came for. Watching it
         * work showed the opposite: two of the same item, or two things found by
         * one search, is ordinary, and dropping the results made the cashier
         * retype the word they had just typed. The pane now holds its place and
         * the cashier leaves it when they choose to.
         */
        catalog: state.catalog,
      }
    }

    case 'ADD_WITH_INSTRUCTIONS': {
      /*
       * Built rather than merged: `lineFromProduct` straight to a line, with no
       * trip through `addToBasket`.
       *
       * A line carrying answers never merges with another anyway (see the fourth
       * rule in basket.ts), so going through the merge path would only look for
       * a match that cannot exist. Building it here also means the answers and
       * their folded price arrive together, in one state update.
       */
      const base = lineFromProduct(
        action.product,
        action.qty,
        state.lines.length,
        action.resolvedIncl ?? action.product.priceIncl,
        state.customer?.discountPct ?? 0,
      )
      return {
        ...state,
        lines: [...state.lines, withInstructions(base, action.instructions, action.note)],
        selectedKey: null,
        query: '',
        catalog: state.catalog,
      }
    }

    case 'SELECT':
      // Tapping the open line closes it — the row is a toggle, not a radio.
      return {
        ...state,
        selectedKey: state.selectedKey === action.key ? null : action.key,
      }

    case 'STEP': {
      const lines = stepQty(state.lines, action.key, action.delta)
      // stepQty removes a line at zero, so the selection has to let go of a key
      // that no longer exists or the action row stays open over nothing.
      const gone = !lines.some((l) => l.key === action.key)
      return { ...state, lines, selectedKey: gone ? null : state.selectedKey }
    }

    case 'UPDATE':
      return { ...state, lines: updateBasketLine(state.lines, action.key, action.changes) }

    case 'REMOVE':
      return {
        ...state,
        lines: removeBasketLine(state.lines, action.key),
        selectedKey: state.selectedKey === action.key ? null : state.selectedKey,
      }

    case 'CLEAR':
      // Everything about the sale, in one place. The customer especially: an
      // attached account surviving into the next sale is how a walk-in's goods
      // end up on somebody's statement.
      return {
        ...initialSaleState,
        // The catalogue view is the cashier's place in the shop, not part of the
        // sale, so it survives. Ringing up the next customer from the same
        // department is the common case.
        catalog: state.catalog.kind === 'search' ? { kind: 'keys' } : state.catalog,
        /*
         * Return mode survives a CLEAR, and this is not the obvious choice.
         *
         * Spreading initialSaleState resets it to false, which would drop a cashier back
         * into SALE mode the moment they cleared a mis-keyed return — and the next item
         * they scanned would be rung up rather than credited, with nothing on screen
         * saying so. Clearing a basket means "start this one again", not "I have changed
         * my mind about which direction the goods are going".
         *
         * Leaving the mode is an explicit SET_RETURNING, which is also the only thing
         * that should do it.
         */
        returning: state.returning,
      }

    case 'SET_RETURNING':
      /* Clears in BOTH directions — see the action's docblock. The lines cannot follow
         the mode across, because a sale and a return are different documents and the
         same lines mean the opposite thing in each. */
      return {
        ...initialSaleState,
        catalog: state.catalog.kind === 'search' ? { kind: 'keys' } : state.catalog,
        returning: action.returning,
      }

    case 'SET_CUSTOMER':
      return {
        ...state,
        customer: action.customer,
        // A real account's name replaces whatever was typed, so the slip and the
        // ledger cannot disagree about who this is.
        customerName: action.customer ? '' : state.customerName,
      }

    case 'SET_CUSTOMER_NAME':
      return { ...state, customerName: action.name }

    case 'SET_QUERY':
      return { ...state, query: action.query }

    case 'SHOW_KEYS':
      return { ...state, catalog: { kind: 'keys' }, query: '' }

    case 'DRILL': {
      const path =
        state.catalog.kind === 'departments'
          ? [...state.catalog.path, action.departmentId]
          : [action.departmentId]
      return { ...state, catalog: { kind: 'departments', path }, query: '' }
    }

    case 'DRILL_TO':
      // An empty path means the top of the tree, which is the department rail
      // itself rather than a level of it.
      return {
        ...state,
        catalog: action.path.length ? { kind: 'departments', path: action.path } : { kind: 'keys' },
        query: '',
      }

    case 'SHOW_SEARCH':
      // Idempotent: this fires on every debounced keystroke, and returning the
      // same object for the same term is what stops React re-rendering the whole
      // grid while somebody is still typing.
      if (state.catalog.kind === 'search' && state.catalog.term === action.term) return state
      return { ...state, catalog: { kind: 'search', term: action.term } }

    /* Only the id. The lines are already what the server just saved, so replacing them
       would throw away anything rung up while that round trip was in flight. */
    case 'ATTACH_DOCUMENT':
      return { ...state, documentId: action.documentId }

    case 'LOAD':
      return {
        ...state,
        documentId: action.documentId,
        lines: action.lines,
        customer: action.customer ?? null,
        /*
         * The NAME survives even when the account does not.
         *
         * A basket parked for "Harbour Cafe" comes back showing Harbour Cafe on
         * the slip, so the cashier knows whose it is — but not attached as a
         * debtor account, because offering credit needs a live balance and the one
         * parked yesterday is not it. Re-attaching re-reads it. Dropping the name
         * too would make every recalled basket anonymous.
         */
        customerName: action.customer ? '' : (action.customerName ?? '').trim(),
        selectedKey: null,
      }

    default: {
      // Exhaustiveness: a new action added to the union without a case here is a
      // compile error rather than a silent no-op at the till.
      const never: never = action
      return never
    }
  }
}

export function useSaleState() {
  return useReducer(saleReducer, initialSaleState)
}
