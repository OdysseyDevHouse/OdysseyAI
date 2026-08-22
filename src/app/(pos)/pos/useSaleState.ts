'use client'

import { useReducer } from 'react'
import {
  addToBasket,
  lineFromProduct,
  removeBasketLine,
  stepQty,
  updateBasketLine,
  withInstructions,
  withRewards,
  type BasketLine,
  type EarnedReward,
} from '@/lib/basket'
import { captureBaseline, type SessionBaseline } from '@/lib/lineSession'
import type { ChosenOption } from '@/lib/instructionRules'
import type { TillProduct } from '@/lib/site/tillSearch'
import type { TillCustomer } from '@/lib/site/tillCustomers'
import type { TillMember } from '@/lib/site/loyalty'
import type { SalesDocType } from '@/lib/site/salesDocuments'

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
  /**
   * Who earns and spends loyalty on this sale.
   *
   * SEPARATE FROM `customer`, and the separation is the point. A customer is a
   * debtors account: terms, a credit limit, a price structure. A member is a
   * loyalty identity. Most shops have people who are one and not the other —
   * the regular who pays cash and collects points has no account, and the trade
   * account never joined the programme.
   *
   * Set together with the customer when that customer is linked to a member, so
   * scanning either one is enough. Cleared with the sale, like the customer.
   */
  member: TillMember | null
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
  /**
   * WHAT KIND of document this basket will be saved as.
   *
   * Separate from `returning` rather than folded into it, and the distinction is
   * real: `returning` says which DIRECTION the goods are going, and carries rules
   * with it — specials are suppressed, the sign is flipped at posting. `docType`
   * says what the paperwork IS. A return is always a credit sale, but a sale can
   * be an invoice, a quote or an order without anything about the basket changing.
   *
   * 'invoice' is the resting state and what every till wrote before this existed,
   * so a basket that never mentions it behaves exactly as it always did.
   *
   * The lines do not care. A quote line and an invoice line are the same line —
   * see BasketLine, which has no idea what document it is destined for. What this
   * changes is where the basket goes when it is saved, and whether it is tendered
   * at all: a quote is an offer and an order is a promise, so neither takes money.
   */
  docType: SalesDocType
  /**
   * How many lines have been undone on THIS basket.
   *
   * State on the sale rather than a ref beside it, for the same reason everything
   * else here is: the allowance belongs to the basket, so it has to reset exactly
   * when the basket does. A counter held outside the reducer would survive a CLEAR
   * that emptied the lines, and the next customer would inherit the last one's
   * spent undos — which reads to a cashier as the till refusing a correction they
   * have not made yet.
   *
   * Counts every undo, including ones the limit will later refuse to allow again.
   * The limit itself is NOT here: it is a shop setting read by the shell, and a
   * reducer that knew about it would have to be re-created when it changed.
   */
  undoCount: number
  /**
   * What the basket looked like when it was LOADED — the session baseline.
   *
   * Set by exactly one action, `LOAD`, and cleared by the two that start a
   * basket over. Never re-taken while a basket is on screen: refreshing it after
   * an edit would turn every `modified` line back into `unmodified`, which is
   * precisely the signal a waiter reopening a table relies on. See lib/lineSession.
   *
   * Null on a counter sale, which was loaded from nowhere and whose every line
   * is therefore new.
   */
  baseline: SessionBaseline
}

export const initialSaleState: SaleState = {
  lines: [],
  selectedKey: null,
  documentId: null,
  customer: null,
  member: null,
  customerName: '',
  catalog: { kind: 'keys' },
  query: '',
  returning: false,
  docType: 'invoice',
  undoCount: 0,
  baseline: null,
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
  /**
   * Put the basket's earned rewards on it — the free garlic bread.
   *
   * ── WHY THE CALLER SENDS THE WHOLE ANSWER, NOT A CHANGE ──────────────────
   *
   * The specials engine does not emit events. It answers, from scratch, "what
   * does this basket earn right now", and that answer shrinks as well as grows:
   * take a pizza off and the free bread goes with it. So this action carries
   * the CURRENT full answer and `withRewards` works out the difference.
   *
   * That makes it idempotent, which matters more than it looks: the caller
   * dispatches it from an effect that runs after every basket change, so it
   * will frequently be sent an answer identical to the one already applied.
   * `withRewards` returns the very same array in that case, and the reducer
   * hands back the very same state — so no render loop can start here.
   *
   * The reducer stays pure: the caller resolves the reward products, because
   * only it holds the specials and the clock.
   */
  | { type: 'SYNC_REWARDS'; rewards: EarnedReward[]; describe: (productId: number) => BasketLine | null }
  /**
   * Take the last line back off — the Undo key.
   *
   * Its own action rather than a REMOVE of the last key, because the two differ in
   * what they MEAN. A REMOVE is a cashier editing a line they are looking at, the
   * ordinary way a basket is corrected; an undo is a rung-up line disappearing, and
   * the shop has asked to count and record those. Folding them together would
   * either count every line edit against the allowance or count none of the undos.
   *
   * The reducer decides WHICH line — the last one — so the caller cannot pass a key
   * and quietly turn an undo into a removal of anything it likes. A no-op on an
   * empty basket, which the shell also guards against but the reducer must survive
   * on its own.
   */
  | { type: 'UNDO' }
  | { type: 'CLEAR' }
  /**
   * Attach or clear the customer, and with them their membership.
   *
   * `member` is what the caller found for this customer — see PosShell, which
   * looks it up. Passing it here rather than resolving it in the reducer keeps
   * the reducer synchronous, and keeps the two attachments in one action so a
   * handler cannot set a customer and forget their member.
   */
  | { type: 'SET_CUSTOMER'; customer: TillCustomer | null; member?: TillMember | null }
  /**
   * Attach a member on their own — a scanned card from someone with no account.
   *
   * Deliberately does NOT touch the customer: a member who is also an account
   * holder may be buying on their account or with cash, and the till must not
   * decide that for them.
   */
  | { type: 'SET_MEMBER'; member: TillMember | null }
  | { type: 'SET_CUSTOMER_NAME'; name: string }
  | { type: 'SET_QUERY'; query: string }
  | { type: 'SHOW_KEYS' }
  /**
   * Open a department.
   *
   * `root` distinguishes the two callers, which mean different things by it:
   * the department RAIL always names a top-level department, so its pick
   * REPLACES the path; a tile inside the grid is a child of the level being
   * shown, so its pick extends it.
   *
   * Without that distinction, tapping the rail's Wood-Fired Pizza while already
   * inside Wood-Fired Pizza appended it again, and a cashier who tapped it a few
   * times got a breadcrumb reading "Wood-Fired Pizza › Wood-Fired Pizza › …"
   * that wrapped over three lines.
   */
  | { type: 'DRILL'; departmentId: number; root?: boolean }
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
   * Start a basket of a different KIND — a quote rather than an invoice.
   *
   * Clears, like SET_RETURNING and for the same reason: the lines cannot follow
   * the change across, because what a cashier has rung up so far was rung up as
   * one kind of document and the prices, discounts and promises attached to it
   * are not automatically true of another.
   */
  | { type: 'SET_DOC_TYPE'; docType: SalesDocType }
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
      /**
       * What the recalled document IS.
       *
       * Absent means invoice, which is what every parked basket was before other
       * types could be saved. Carried rather than inherited: LOAD replaces the sale
       * in place, so without this a till that had just written a quote would recall
       * somebody's parked invoice and still believe it was holding a quote.
       */
      docType?: SalesDocType
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

    case 'SYNC_REWARDS': {
      const lines = withRewards(state.lines, action.rewards, action.describe)
      // The SAME array back means nothing was earned or given up, which is the
      // usual case on the usual keystroke. Returning the same state object is
      // what stops the effect that dispatches this from looping.
      if (lines === state.lines) return state
      return {
        ...state,
        lines,
        // A selected line that was a reward can vanish underneath the cursor —
        // the goods that earned it were removed. Clear the selection rather
        // than leave it pointing at a key no row has.
        selectedKey: lines.some((l) => l.key === state.selectedKey) ? state.selectedKey : null,
      }
    }

    case 'UNDO': {
      const last = state.lines[state.lines.length - 1]
      /* Nothing to undo is not an undo. Counting it would let a cashier spend the
         allowance on an empty basket and then be refused a real correction. */
      if (!last) return state
      return {
        ...state,
        lines: removeBasketLine(state.lines, last.key),
        selectedKey: state.selectedKey === last.key ? null : state.selectedKey,
        undoCount: state.undoCount + 1,
      }
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
        /* Survives for the same reason the mode does: a till put into quote mode
           stays there when a mis-keyed quote is cleared. Leaving is an explicit
           SET_DOC_TYPE, which is the only thing that should do it. */
        docType: state.docType,
      }

    case 'SET_RETURNING':
      /* Clears in BOTH directions — see the action's docblock. The lines cannot follow
         the mode across, because a sale and a return are different documents and the
         same lines mean the opposite thing in each. */
      return {
        ...initialSaleState,
        catalog: state.catalog.kind === 'search' ? { kind: 'keys' } : state.catalog,
        returning: action.returning,
        /* A return is a credit sale, whatever the till was writing before it.
           Coming back OUT of return mode lands on an invoice rather than on
           whatever was set two baskets ago, which is the least surprising place
           for a cashier to find themselves. */
        docType: 'invoice',
      }

    case 'SET_DOC_TYPE':
      return {
        ...initialSaleState,
        catalog: state.catalog.kind === 'search' ? { kind: 'keys' } : state.catalog,
        docType: action.docType,
      }

    case 'SET_CUSTOMER':
      return {
        ...state,
        customer: action.customer,
        // The customer's membership comes with them, and goes with them.
        //
        // `undefined` means the caller did not look one up, which is not the
        // same claim as "this customer is not a member" — so it leaves an
        // already-scanned card alone. Clearing the customer clears the member
        // outright: a card scanned as part of attaching an account should not
        // outlive it.
        member: action.customer ? (action.member ?? state.member) : null,
        // A real account's name replaces whatever was typed, so the slip and the
        // ledger cannot disagree about who this is.
        customerName: action.customer ? '' : state.customerName,
      }

    case 'SET_MEMBER':
      return { ...state, member: action.member }

    case 'SET_CUSTOMER_NAME':
      return { ...state, customerName: action.name }

    case 'SET_QUERY':
      return { ...state, query: action.query }

    case 'SHOW_KEYS':
      return { ...state, catalog: { kind: 'keys' }, query: '' }

    case 'DRILL': {
      const current = state.catalog.kind === 'departments' ? state.catalog.path : []
      /*
       * The rail replaces the path; a tile extends it.
       *
       * And either way the same department cannot appear twice in a row. Re-opening
       * the level already shown is a no-op, not another crumb: the grid would not
       * change, so appending only grows the trail. That is the whole of the bug
       * where spamming one department built a breadcrumb of a dozen copies of it.
       */
      const path = action.root
        ? [action.departmentId]
        : current[current.length - 1] === action.departmentId
          ? current
          : [...current, action.departmentId]
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
        // Dropped with the account, and re-found when it is re-attached. A
        // membership recalled from yesterday's parked basket would quote a
        // balance nobody has re-read.
        member: null,
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
        /* The recalled document's own kind, not whatever this till was last set
           to. Absent means invoice — see the action. */
        docType: action.docType ?? 'invoice',
        selectedKey: null,
        /*
         * A recalled basket brings back its lines, not the last basket's spent undos.
         *
         * Not covered by the CLEAR spread above: LOAD replaces the sale in place,
         * without passing through initialSaleState. Leaving the count alone would
         * mean a cashier who used their two undos, parked, and pulled a different
         * sale back could not correct a scan on it — the till refusing over
         * somebody else's basket.
         */
        undoCount: 0,
        /*
         * THE session baseline is taken here and only here.
         *
         * This is the moment a tab comes back on screen, so this is what
         * "unmodified" means for the rest of the sitting: every line the waiter
         * has just been handed. Anything added after this is new, anything
         * changed after this is modified, and nothing may re-take the snapshot
         * until the basket is cleared. See lib/lineSession.
         */
        baseline: captureBaseline(action.lines),
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
