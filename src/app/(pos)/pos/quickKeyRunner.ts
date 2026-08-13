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
  /** Opens the shift modal — float, payouts, and the blind cash-up count. */
  showShift: () => void
  /** Opens the whole-sale discount dialog. */
  docDiscount: () => void
  /** Reprints the last slip this machine printed. */
  reprintLastSlip: () => void
  /** Prints the NEW lines of the open tab on the kitchen printer. */
  sendToKitchen: () => void
  /**
   * Switches the pane into return mode. CLEARS the basket — see SET_RETURNING.
   *
   * Not "open the refund pad": there is nothing to credit until the cashier has scanned
   * what came back, so the key does what the Sale/Return toggle does.
   */
  startReturn: () => void
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
  /**
   * True when a customer is attached.
   *
   * Needed by the points key: a loyalty standing is looked up per customer, so an
   * unattached basket has no balance to spend and the useful message is "attach the
   * customer first" rather than a flat refusal.
   */
  hasCustomer: boolean
  /** True when the basket is already a return, so the refund key does not re-clear it. */
  returning: boolean
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
  /* With a line selected it discounts THAT line (the editor already holds the
     rules); with none it discounts the whole sale — which is what the key's
     name has promised all along. */
  'global-discount': ({ handlers, hasSelection, hasLines }) =>
    hasSelection
      ? handlers.editLine()
      : hasLines
        ? handlers.docDiscount()
        : handlers.say('Ring something up first.', 'info'),

  'price-change': ({ handlers, hasSelection }) =>
    hasSelection
      ? handlers.editLine()
      : handlers.say('Tap the line whose price you want to change.', 'info'),

  'credit-sale': ({ handlers }) => handlers.pickCustomer(),

  /*
   * Switches the pane into return mode rather than opening anything.
   *
   * A key that jumped straight to a refund pad would be a refund with no lines — there
   * is nothing to credit until the cashier has scanned what came back. So the key does
   * what a cashier would otherwise do with the Sale/Return toggle, and the basket they
   * then build is credited by the same Refund button.
   *
   * Says so when already in return mode rather than silently re-clearing: SET_RETURNING
   * empties the basket, and a key that wiped a half-scanned return because somebody
   * pressed it twice would be worse than one that did nothing.
   */
  refund: ({ handlers, returning }) =>
    returning
      ? handlers.say('Already taking a return — scan what is coming back.', 'info')
      : handlers.startReturn(),

  /* Online, the shift modal handles the whole thing at the till. Offline, the
     outbox is where "can I cash up yet" is answered — it shows what is still
     waiting to send, and closeShift's expected figure is wrong until it is empty. */
  cashup: ({ handlers, online }) =>
    online
      ? handlers.showShift()
      : handlers.showOutbox(),

  /* Reprints THIS machine's last slip — no hunting through the invoicing
     list. The reprint counts through recordPrint, so the paper says COPY. */
  'reprint-last-slip': ({ handlers, online }) =>
    online
      ? handlers.reprintLastSlip()
      : handlers.say('A reprint needs the connection. The sale is safe on this till.', 'info'),

  'reprint-invoice': ({ handlers, online }) =>
    online
      ? handlers.navigate('/sales/invoicing?status=finalised')
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

  /*
   * ── VOUCHERS AND POINTS LIVE ON THE TENDER PAD ──────────────────────────
   *
   * Both of these used to sit in NOT_WIRED saying "use the desk till" — and that
   * instruction became WRONG twice over: loyalty was ported onto this pad in phase 7,
   * and the desk till was deleted in the same phase. A cashier following it would go
   * looking for a screen that redirects them straight back here.
   *
   * They are not routed to the pad directly because a tender only means something
   * against a basket that is ready to pay, and the pad opens from Pay for exactly that
   * reason. So these say where the thing is and what it needs first — which is the
   * useful half of a key that cannot act on its own.
   */
  'redeem-voucher': ({ handlers, online }) =>
    online
      ? handlers.say('Tap Pay — voucher codes are entered on the payment screen.', 'info')
      : handlers.say('Vouchers need the connection. Take another payment method.', 'info'),

  /* Points need a CUSTOMER as well as a connection: the standing is looked up per
     customer, so an unattached basket has no balance to spend. Saying which one is
     missing beats a generic refusal. */
  'loyalty-payment': ({ handlers, online, hasCustomer }) => {
    if (!online) {
      return handlers.say('Paying with points needs the connection.', 'info')
    }
    return hasCustomer
      ? handlers.say('Tap Pay — points show as a payment method on the payment screen.', 'info')
      : handlers.say('Attach the customer first, then their points show up under Pay.', 'info')
  },

  /*
   * Both of these SHIPPED after the unbuilt list was written, and sat in it
   * telling cashiers a working feature did not exist — the same trap the
   * voucher key fell into above. Like the voucher key, they cannot act on
   * their own (a split needs a saved table, a tip belongs to a payment), so
   * they say where the built thing lives.
   */
  'split-table': ({ handlers }) =>
    handlers.say('Save the table, then tap “Split a bill” on the floor and pick it.', 'info'),

  'add-tip': ({ handlers }) =>
    handlers.say('Tips are declared on the payment screen — tap Pay, then add the tip against the payment method.', 'info'),

  /* Like split-table above: the gesture starts from the floor, where both tables
     are visible — a key on the till cannot know which pair the waiter means. */
  'table-transfer': ({ handlers }) =>
    handlers.say('Tap “Move a table” on the floor, then pick the table that is moving.', 'info'),

  /* The bill button lives beside the basket, where the tab it prints is open. */
  'bill-print': ({ handlers, online }) =>
    online
      ? handlers.say('Open the table, then tap Bill beside the basket to print it.', 'info')
      : handlers.say('Printing a bill needs the connection — the tab lives on the server.', 'info'),

  /* Prints what the kitchen has NOT seen yet — the delta since the last send.
     Needs the connection (the tab and its sent-state live on the server) and
     a kitchen printer on this till's bridge, which the handler checks. */
  'send-to-kitchen': ({ handlers, online }) =>
    online
      ? handlers.sendToKitchen()
      : handlers.say('Sending to the kitchen needs the connection — the tab lives on the server.', 'info'),
}

/**
 * Why a slug is not wired, in words a cashier can act on.
 *
 * Each of these is a real gap rather than a bug. Saying so is the point: "Refunds are
 * done from Returns in the back office" tells somebody what to do next, where a dead
 * button tells them the till is broken.
 */
const NOT_WIRED: Record<string, string> = {
  /*
   * These two still say "the desk till", and unlike the voucher and points keys that is
   * still TRUE in substance — orders and lay-bys were never ported. But the desk till
   * itself is gone (phase 7), so the wording points at a screen that no longer exists.
   * Reworded to name the back office, which is where /sales/orders and /sales/laybys
   * actually live.
   */
  'save-as-order': 'Turning a basket into an order is done from Orders in the back office.',
  'save-as-layby': 'Starting a lay-by is done from Lay-bys in the back office.',
}

/**
 * The hospitality five, on a RETAIL till.
 *
 * Not "not built" — a counter has no tables, so a key to move one between them is
 * meaningless here rather than missing. Saying "turn tables on" points at the actual
 * remedy; saying "not built yet" would send somebody looking for a release note.
 */
const HOSPITALITY_MESSAGE =
  'This only works on a till that serves tables. Turn that on in Setup → Tables.'

/**
 * The hospitality keys that have no behaviour YET, even with tables on.
 *
 * Separate from NOT_WIRED because the reason differs: those are things this app does
 * elsewhere, while these are genuinely unbuilt. Split bills and tips USED to be here
 * and shipped without their entries being removed — a cashier pressing them was told
 * a working feature did not exist. They now live in RUN, pointing at where each one
 * is. Remove an entry here the moment its feature lands, or it lies.
 *
 * Send-to-kitchen is here by a decision rather than an omission: whether "send" means a
 * physical ESC-POS ticket or a mark-and-display stamp is a question about the shop's
 * hardware, and building the wrong one would be worse than building neither.
 */
// Empty since send-to-kitchen shipped — kept so the next hospitality slug has
// somewhere honest to wait, per the rule above: remove entries the moment the
// feature lands, or the key lies.
const HOSPITALITY_UNBUILT: Record<string, string> = {}

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

  /* A parking key pressed on a restaurant till. Reachable when a shop set the key
     up before switching to hospitality, so it explains itself rather than doing
     something surprising to a live tab. */
  if (action.retailOnly && ctx.hospitality) {
    handlers.say(
      'On a restaurant till, Close saves the table — and the floor lists every open one.',
      'info',
    )
    return
  }

  if (action.hospitalityOnly) {
    /* Two different messages, and the order matters: on a retail till the key is
       meaningless, so say that first. Telling somebody a feature is unbuilt when really
       their shop is not set up for it sends them to the wrong place. */
    if (!ctx.hospitality) {
      handlers.say(HOSPITALITY_MESSAGE, 'info')
      return
    }
    const unbuilt = HOSPITALITY_UNBUILT[key.actionSlug]
    if (unbuilt) {
      handlers.say(unbuilt, 'info')
      return
    }
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
  /* Parking keys on a restaurant till: Close already parks the tab and the gate
     already lists every open one, so these two would be a second route to a job
     that is done — and "Saved sales" a second floor beside the real one. */
  if (action.retailOnly && ctx.hospitality) return false
  return true
}
