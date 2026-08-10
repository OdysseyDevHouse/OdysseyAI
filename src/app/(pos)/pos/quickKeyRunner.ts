'use client'

import { actionForSlug, type QuickKeyRow } from '@/lib/quickKeys'

/**
 * What pressing a quick key does.
 *
 * ── A DISPATCH TABLE, NOT A SWITCH INSIDE PosShell ────────────────────────
 *
 * Twenty-four slugs handled inline would put twenty-four more branches into the file
 * that already owns the reducer and every round trip. Here they are data, so adding a
 * key is one entry and the shell only has to know how to call it.
 *
 * ── WHAT "NOT WIRED" MEANS, AND WHY IT IS EXPLICIT ────────────────────────
 *
 * Several slugs describe things this till cannot do yet — the hospitality five, and a
 * handful whose screens live only in the back office. Each one is listed with a REASON
 * rather than falling through to a silent no-op, because a key that does nothing when
 * pressed is the worst outcome available: a cashier presses it twice, then stops
 * trusting the till.
 *
 * So an unwired key says what it needs, on screen, at the moment it is pressed. That is
 * also what stops the designer offering keys nobody can use — `QUICK_KEY_ACTIONS` is
 * one list, and this file is the record of which of them have arrived.
 */

/**
 * What the shell can be asked to do.
 *
 * Deliberately narrow. A runner that could reach into the reducer directly would be a
 * second place that decides what a basket is; these are the same operations the on-screen
 * buttons already trigger, so a quick key can never do something the till itself cannot.
 */
export type QuickKeyHandlers = {
  /** Opens the tender pad. */
  pay: () => void
  /** Clears the basket, with the confirm dialog. */
  clear: () => void
  /** Parks the basket. */
  park: () => void
  /** Opens the saved-sales list. */
  showSaved: () => void
  /** Removes the last line added. */
  undo: () => void
  /** Opens the customer picker. */
  pickCustomer: () => void
  /** Opens the line editor on the selected line, for a price or discount change. */
  editLine: () => void
  /** Drills the catalogue into a department. */
  openDepartment: (departmentId: number) => void
  /** Adds a product by id — the till resolves it against its own catalogue. */
  addProduct: (productId: number) => void
  /** Opens the outbox, which is also where a cash-up warning lives. */
  showOutbox: () => void
  /** Navigates the browser, for the screens that live in the back office. */
  navigate: (href: string) => void
  /** Says something to the cashier. Used for every refusal. */
  say: (message: string, tone: 'info' | 'error') => void
}

/** Whether the operator may press this key at all. */
export type CapabilityCheck = (capability: string) => boolean

export type RunContext = {
  handlers: QuickKeyHandlers
  can: CapabilityCheck
  /** True on a restaurant till. Gates the hospitality slugs. */
  hospitality: boolean
  /** Whether the till can reach the server right now. */
  online: boolean
  /** True when a line is selected — several keys act on one. */
  hasSelection: boolean
  /** True when the basket has anything in it. */
  hasLines: boolean
}

/**
 * Slugs this till genuinely runs, and how.
 *
 * Anything absent from here is handled by `notWired` below, which names what it is
 * waiting for. Keeping the two apart means "is this key live" is answerable by reading
 * one object rather than by tracing a switch.
 */
const RUN: Record<string, (ctx: RunContext) => void> = {
  'void-sale': ({ handlers, hasLines }) =>
    hasLines ? handlers.clear() : handlers.say('There is nothing to clear.', 'info'),

  'save-sale': ({ handlers, hasLines }) =>
    hasLines ? handlers.park() : handlers.say('Add something before saving the sale.', 'info'),

  'view-saved-sales': ({ handlers }) => handlers.showSaved(),

  undo: ({ handlers, hasLines }) =>
    hasLines ? handlers.undo() : handlers.say('Nothing to undo.', 'info'),

  /*
   * Both of these open the LINE EDITOR rather than a dialog of their own.
   *
   * That editor already holds the discount and price fields, already checks the
   * operator's override rights, and already reads the product's own discount ceiling. A
   * second route to the same change is a second place for those three rules to drift.
   */
  'global-discount': ({ handlers, hasSelection }) =>
    hasSelection
      ? handlers.editLine()
      : handlers.say('Tap the line you want to discount first.', 'info'),

  'price-change': ({ handlers, hasSelection }) =>
    hasSelection
      ? handlers.editLine()
      : handlers.say('Tap the line whose price you want to change.', 'info'),

  'credit-sale': ({ handlers }) => handlers.pickCustomer(),

  /* The outbox is where "can I cash up yet" is answered — it shows what is still
     waiting to send, and closeShift's expected figure is wrong until it is empty. */
  cashup: ({ handlers, online }) =>
    online
      ? handlers.navigate('/sales/cashup')
      : handlers.showOutbox(),

  'reprint-last-slip': ({ handlers, online }) =>
    online
      ? handlers.navigate('/sales')
      : handlers.say('A reprint needs the connection. The sale is safe on this till.', 'info'),

  'reprint-invoice': ({ handlers, online }) =>
    online
      ? handlers.navigate('/sales')
      : handlers.say('A reprint needs the connection.', 'info'),

  'price-enquiry': ({ handlers }) =>
    handlers.say('Search for the product above — the tile shows its price.', 'info'),

  'online-orders': ({ handlers, online }) =>
    online
      ? handlers.navigate('/online-store/orders')
      : handlers.say('Online orders need the connection.', 'info'),

  'clock-in-out': ({ handlers, online }) =>
    online
      ? handlers.navigate('/staff/clock')
      : handlers.say('The time clock needs the connection.', 'info'),

  'customer-payment': ({ handlers, online }) =>
    online
      ? handlers.navigate('/cashbook')
      : handlers.say('Taking a payment against an account needs the connection.', 'info'),
}

/**
 * Why a slug is not wired, in words a cashier can act on.
 *
 * Each of these is a real gap rather than a bug. Saying so is the point: "Refunds are
 * done from Returns in the back office" tells somebody what to do next, where a dead
 * button tells them the till is broken.
 */
const NOT_WIRED: Record<string, string> = {
  refund: 'Refunds are done from Returns in the back office, where the original sale can be found.',
  'save-as-order': 'Saving as an order is on the desk till for now.',
  'save-as-layby': 'Starting a lay-by is on the desk till for now.',
  'redeem-voucher': 'Vouchers are not on this till yet — use the desk till.',
  'loyalty-payment': 'Paying with points is not on this till yet — use the desk till.',
}

/** The hospitality five, all waiting on the same thing. */
const HOSPITALITY_MESSAGE = 'This needs the restaurant screens, which are not built yet.'

/**
 * Presses a key.
 *
 * Every refusal goes through `say`, so a cashier always learns something. The order of
 * the checks matters: capability first, because "you may not do this" is a different
 * message from "this is not built", and telling somebody a feature is missing when
 * really they lack the right sends them to the wrong person.
 */
export function runQuickKey(key: QuickKeyRow, ctx: RunContext): void {
  const { handlers, can } = ctx

  if (key.kind === 'group') {
    // Handled by the panel, which opens the folder. Reaching here means a group was
    // pressed through some other path.
    return
  }

  if (key.kind === 'product') {
    if (key.productId == null) {
      handlers.say('That key points at a product that no longer exists.', 'error')
      return
    }
    handlers.addProduct(key.productId)
    return
  }

  if (key.kind === 'department') {
    if (key.departmentId == null) {
      handlers.say('That key points at a department that no longer exists.', 'error')
      return
    }
    handlers.openDepartment(key.departmentId)
    return
  }

  const action = actionForSlug(key.actionSlug)
  if (!action) {
    handlers.say('That key does something this till does not recognise.', 'error')
    return
  }

  /* The capability the KEY carries, not the catalogue's — they are the same today, and
     the stored one is what the designer validated and what a manager can see. */
  if (key.capability && !can(key.capability)) {
    handlers.say(`You do not have permission to ${action.label.toLowerCase()}.`, 'error')
    return
  }

  if (action.hospitalityOnly && !ctx.hospitality) {
    handlers.say(HOSPITALITY_MESSAGE, 'info')
    return
  }

  const notWired = NOT_WIRED[key.actionSlug]
  if (notWired) {
    handlers.say(notWired, 'info')
    return
  }

  const run = RUN[key.actionSlug]
  if (!run) {
    /* Reachable only if a slug is added to QUICK_KEY_ACTIONS without a line in either
       table above. Named as the omission it is, rather than a silent no-op. */
    handlers.say(`${action.label} is not on this till yet.`, 'info')
    return
  }

  run(ctx)
}

/**
 * Whether a key would do something if pressed — for greying it out.
 *
 * A key that will refuse is better shown dimmed than pressed and rejected: the cashier
 * learns before they commit, and a bar of live keys is faster to read than one where
 * every tile might or might not work.
 */
export function quickKeyEnabled(
  key: QuickKeyRow,
  ctx: Pick<RunContext, 'can' | 'hospitality'>,
): boolean {
  if (key.kind === 'group') return true
  if (key.kind !== 'action') return true

  const action = actionForSlug(key.actionSlug)
  if (!action) return false
  if (key.capability && !ctx.can(key.capability)) return false
  if (action.hospitalityOnly && !ctx.hospitality) return false
  return true
}
