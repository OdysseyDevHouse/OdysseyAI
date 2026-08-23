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
  /**
   * Saves the basket the way Close does — but ASKS what to call it when it has no
   * name yet, rather than parking it anonymously.
   *
   * Replaced `park`, which is still what happens underneath. The difference is the
   * naming step: a basket saved without a name is one nobody can find again.
   */
  saveSale: () => void
  /**
   * Writes the basket as a SALES ORDER rather than an invoice.
   *
   * The same lines, the same prices, the same customer — an order is an invoice
   * at an earlier moment in its life, which is why this is one call rather than a
   * second basket. What differs is that nothing is tendered and stock is reserved
   * rather than moved: the goods are promised, not handed over.
   *
   * Needs a customer, and the handler says so rather than refusing flatly. An
   * order is a promise, and a promise to "Walk-in" cannot be delivered against.
   */
  saveAsOrder: () => void
  /** Removes the last line added. */
  undo: () => void
  /** Opens the customer picker. */
  pickCustomer: () => void
  /** Opens the line editor on the selected line, for a price or discount change. */
  editLine: () => void
  /**
   * Opens the price-type list — which of the shop's price lists this sale rings at.
   *
   * Distinct from `editLine`, and the distinction is the point: that changes one
   * line's figure as an exception, this changes which price list the sale follows.
   */
  pickPriceType: () => void
  /**
   * Opens the price-check dialog — what something costs on every price type.
   *
   * A third distinct thing from the two above, and the reason all three exist:
   * `editLine` changes one line as an exception, `pickPriceType` changes what the
   * sale rings at, and this changes NOTHING. It answers a question.
   */
  priceCheck: () => void
  /**
   * Opens the account-payment dialog — money against a debtor, outside any sale.
   *
   * Deliberately not `pickCustomer`: that attaches an account to the BASKET, and
   * the account being paid here has nothing to do with what is on screen.
   */
  takePayment: () => void
  /**
   * Opens the deposit dialog — money held against the BASKET on screen.
   *
   * The opposite of `takePayment` in the one way that matters: this one is about
   * the sale in front of the cashier, and the money settles it later rather than
   * settling an account now. Saves the basket first, because a deposit is held
   * against a document and an unsaved basket is not one.
   */
  takeDeposit: () => void
  /** Opens the past-sales list, to print one again. */
  showReprints: () => void
  /** Opens the web-order queue, to bring one onto the till and be paid for. */
  showOnlineOrders: () => void
  /**
   * Puts the BASKET aside as a lay-by.
   *
   * Distinct from the lay-by list in the module menu, which finds an existing
   * one to pay against. This one turns what is on screen into a new one, which
   * is why it is a basket key rather than a way to another screen.
   */
  startLayby: () => void
  /**
   * Opens the clock pad — a PIN in, a shift started or ended.
   *
   * The PIN is the credential rather than the till session, because the person
   * clocking on is usually not the person signed in. See ClockModal.
   */
  showClock: () => void
  /** Drills the catalogue into a department. */
  openDepartment: (departmentId: number) => void
  /** Adds a product by id — the till resolves it against its own catalogue. */
  addProduct: (productId: number) => void
  /** Opens the outbox, which is also where a cash-up warning lives. */
  showOutbox: () => void
  /** Opens the shift modal — the float, and the blind cash-up count. */
  showShift: () => void
  /**
   * Opens one of the three drawer movements — money out, in, or to the safe.
   *
   * One handler taking the kind, rather than three: they are one dialog with
   * three sets of words (see DrawerMovementModal), and three handlers would be
   * three lines in the shell doing the identical thing.
   */
  showDrawerMovement: (type: 'payout' | 'payin' | 'drop') => void
  /** Opens the DETAILED cash-up: denominations, every tender, banking. */
  showDeclaration: () => void
  /** Opens the whole-sale discount dialog. */
  docDiscount: () => void
  /** Reprints the last slip this machine printed. */
  reprintLastSlip: () => void
  /** Opens the gift-card balance prompt (147). */
  giftCardBalance: () => void
  /** Prints the NEW lines of the open tab on the kitchen printer. */
  sendToKitchen: () => void
  /** Prints the pro-forma bill for the open tab, and marks the table asked. */
  printBill: () => void
  /**
   * Sends the waiter to the floor with the SPLIT mode already armed.
   *
   * Two steps in one handler because the gesture genuinely needs two taps: a split
   * moves lines between two bills, and neither the key nor the basket knows which
   * pair is meant. So the key does the part it can — open the floor, arm the mode —
   * and the floor asks the question only it can ask.
   *
   * This replaced the pair of buttons that used to sit on the gate's header. The
   * gesture is unchanged; what moved is where it is STARTED from, so a shop decides
   * whether it is on the till at all by putting the key on a bar or leaving it off.
   */
  armSplit: () => void
  /** The same, for moving a whole tab to another table. */
  armTransfer: () => void
  /**
   * Switches the pane into return mode. CLEARS the basket — see SET_RETURNING.
   *
   * Not "open the refund pad": there is nothing to credit until the cashier has scanned
   * what came back, so the key does what the Sale/Return toggle does.
   *
   * No longer what the `refund` key calls — see `armRefund` below. It stays on the
   * contract because the Sale/Return toggle on the pane is the same act, and a shop
   * that wants the whole-basket behaviour on a key has one to bind to.
   */
  startReturn: () => void
  /**
   * Opens the receipt finder — today's sales, listed, with the older windows and a
   * search a tap away.
   *
   * What the `credit-sale` key does. See the note on that key for why.
   */
  findReceipt: () => void
  /**
   * Arms the NEXT item as a refund on the sale in progress, or disarms it.
   *
   * What the `refund` key does. The basket is untouched: this is the mid-sale
   * case, where a customer hands one thing back at the same counter they are
   * buying at, and the pair belongs on one slip with one total.
   *
   * Takes the flag rather than toggling internally so the key and any other route
   * in agree about what "off" means — a toggle that each caller flipped for itself
   * is how an armed till ends up with two disagreeing indicators.
   */
  armRefund: (armed: boolean) => void
  /*
   * There is deliberately no `navigate` any more.
   *
   * Five keys used to push the browser at a back-office screen — payments,
   * reprints, online orders, the clock. Every one of them took the till off the
   * display with a basket possibly half-scanned on it, and landed a cashier in a
   * dense screen built for a manager, sometimes behind a right they do not hold.
   * All five now open a dialog over the till.
   *
   * Left out rather than kept "just in case": a navigation handler in this
   * contract is an invitation for the next key to take the easy route, and the
   * easy route is the one that was wrong five times.
   */
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
  /** True when the next item is already armed as a refund, so the key can disarm it. */
  refundArmed: boolean
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

  /*
   * ── SAVE IS CLOSE ───────────────────────────────────────────────────────
   *
   * The same act, so the same code path. A basket that already knows what it is
   * called — a seated table, a named tab — is saved under that name with nothing
   * asked; one that does not gets the create-table dialog, because a basket saved
   * anonymously cannot be found again once it leaves the screen, and "saved" that
   * loses the sale is worse than a question.
   *
   * It used to call `park` directly, which parked unnamed and left a cashier
   * hunting a list of identical "Walk-in" rows for the one they meant. Two keys
   * doing the same job differently is also two places to fix when the job changes.
   */
  'save-sale': ({ handlers, hasLines }) =>
    hasLines ? handlers.saveSale() : handlers.say('Add something before saving the sale.', 'info'),

  /*
   * ── SAVE AS ORDER ───────────────────────────────────────────────────────
   *
   * Needs the CONNECTION, and that is a decision rather than an oversight. An
   * order reserves stock, and a reservation made on a till that cannot see what
   * anybody else has reserved is a promise the shop may not be able to keep. An
   * invoice offline is safe because the goods leave the counter in the customer's
   * hands; an order offline is a claim on stock that might already be gone.
   *
   * The customer check lives in the handler rather than here: the shell knows
   * whether one is attached, and the useful reply is "attach the customer first"
   * rather than a flat no.
   */
  'save-as-order': ({ handlers, hasLines, online }) => {
    if (!hasLines) {
      handlers.say('Add something before saving it as an order.', 'info')
      return
    }
    if (!online) {
      handlers.say('An order reserves stock, so it needs the connection.', 'info')
      return
    }
    handlers.saveAsOrder()
  },

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

  /*
   * ── A PRICE TYPE, NOT A PRICE ───────────────────────────────────────────
   *
   * This used to open the line editor to override one line's figure. It now
   * switches which of the shop's PRICE LISTS the rest of the sale rings up at —
   * wholesale, staff, whatever the shop has set up — because that is the act a
   * cashier at a counter actually performs. "This customer is on trade" is a
   * decision about the sale, not about a line, and doing it through per-line
   * overrides meant retyping a figure for every item and getting one wrong.
   *
   * The line override is still there and is still the right tool for a one-item
   * exception: tap the line. That path keeps the override rights and the product's
   * discount ceiling, which a price-list switch does not need — a shop's own
   * wholesale price is not a departure from anything.
   *
   * Unconditional. There is nothing to select and no basket required: switching
   * before the first scan is the ordinary way to use it.
   */
  'price-change': ({ handlers }) => handlers.pickPriceType(),

  /*
   * ── CREDIT SALE: REVERSE A DOCUMENT THAT EXISTS ───────────────────────────
   *
   * Opens the receipt finder. This is what the `refund` key used to do, and it is
   * the right act — it just had the wrong name on it.
   *
   * Return mode was the original binding, and that was the wrong end of the job.
   * Return mode is the NO-RECEIPT path: the cashier re-scans the goods and the
   * credit comes out at today's shelf price, which is right when there is no slip
   * and wrong every other time — the customer gets back something other than what
   * they paid, and a discounted sale refunds at full price.
   *
   * So the key goes where the money is: find the sale, pick the lines, credit at
   * the prices on it. The finder opens on today's sales already listed, because
   * "which one is theirs" is answerable from the till and "what is the invoice
   * number" usually is not — the slip is faded, folded or gone.
   *
   * Online only, and refused with the reason: the over-credit guard needs every
   * credit note ever raised against the invoice, which a till cannot know offline.
   * Sending a cashier somewhere else instead would be answering a different
   * question than the one they asked — so it says what to do.
   */
  'credit-sale': ({ handlers, online }) =>
    online
      ? handlers.findReceipt()
      : handlers.say(
          'Finding a receipt needs the connection. Use Refund to take an item back without one.',
          'error',
        ),

  /*
   * ── REFUND: ARM THE NEXT ITEM ─────────────────────────────────────────────
   *
   * One press arms one line. The cashier presses Refund, scans the thing coming
   * back, and it lands on the slip as a negative line — then the till is selling
   * again with nothing to switch off. See `refundArmed` in useSaleState for why
   * a one-shot rather than a mode.
   *
   * Pressing it again disarms, which is the only way out that does not involve
   * crediting something. A cashier who armed it by mistake needs an escape.
   *
   * ── WORKS OFFLINE, UNLIKE THE KEY ABOVE ───────────────────────────────────
   *
   * Deliberately no `online` guard. This path asks the server nothing: the goods
   * are in front of the cashier, the price comes off the cached catalogue, and the
   * whole slip queues like any other offline sale. That makes it the honest thing
   * to point a disconnected till at, which is exactly what `credit-sale` does
   * above when it refuses.
   *
   * ── REFUSED INSIDE RETURN MODE ────────────────────────────────────────────
   *
   * A basket that is ALREADY a credit note has every line going back; arming one
   * more inside it would flip that line to positive and quietly sell the customer
   * something in the middle of their return. Two ways of saying the same thing,
   * one of them inverted, is worth a refusal rather than a clever merge.
   */
  refund: ({ handlers, returning, refundArmed }) => {
    if (returning) {
      handlers.say('This whole sale is already a return — every line goes back.', 'info')
      return
    }
    handlers.armRefund(!refundArmed)
  },

  /*
   * The full declaration, not the quick count.
   *
   * This key used to open the drawer-controls modal, whose count face is a flat
   * list of one box per tender. That answers "does it balance" and nothing
   * else — a cashier pressing "Cash up" is starting the count a supervisor
   * signs, which needs the notes and coin counted pile by pile, the machine
   * slips declared one at a time, and the banking. So the key opens THAT, and
   * the drawer's own controls (float, payout, drop) stay on their own modal.
   *
   * Offline, the outbox is where "can I cash up yet" is answered — it shows
   * what is still waiting to send, and every expected figure is wrong until it
   * is empty.
   */
  cashup: ({ handlers, online }) =>
    online
      ? handlers.showDeclaration()
      : handlers.showOutbox(),

  /*
   * The three drawer movements, each one press.
   *
   * Online only, and refused with the REASON rather than silently: a movement
   * has to land on the shift it belongs to, and the shift lives on the server.
   * Queueing one offline would bank it into whichever shift happened to be open
   * when the line came back — which could be the next day's.
   *
   * The dialog says the same thing when it is opened offline. Both, because
   * this is the cheaper refusal (no dialog to dismiss) and that one is the
   * backstop for every other way in.
   */
  payout: ({ handlers, online }) =>
    online
      ? handlers.showDrawerMovement('payout')
      : handlers.say('A payout has to land on a shift, and that needs the connection.', 'info'),

  payin: ({ handlers, online }) =>
    online
      ? handlers.showDrawerMovement('payin')
      : handlers.say('A pay-in has to land on a shift, and that needs the connection.', 'info'),

  'drop-to-safe': ({ handlers, online }) =>
    online
      ? handlers.showDrawerMovement('drop')
      : handlers.say('A drop has to land on a shift, and that needs the connection.', 'info'),

  /* Reprints THIS machine's last slip — no hunting through the invoicing
     list. The reprint counts through recordPrint, so the paper says COPY. */
  'reprint-last-slip': ({ handlers, online }) =>
    online
      ? handlers.reprintLastSlip()
      : handlers.say('A reprint needs the connection. The sale is safe on this till.', 'info'),

  /*
   * Opens the sale history HERE rather than pushing the browser to the invoicing
   * list. Same reason as the payment key: leaving the till abandons whatever is on
   * screen and lands a cashier in a back-office table built for a different job.
   *
   * Distinct from `reprint-last-slip` above, which needs no list at all — it prints
   * the one this machine just did. This is for any sale, which is the harder case
   * and the one somebody holding an old slip actually has.
   */
  'reprint-invoice': ({ handlers, online }) =>
    online
      ? handlers.showReprints()
      : handlers.say('A reprint needs the connection — past sales live on the server.', 'info'),

  /*
   * A real dialog now, where this used to be a sentence telling the cashier to
   * do it themselves ("search above — the tile shows its price").
   *
   * The tile shows ONE price: the one on whichever structure the till is sitting
   * on. The question actually being asked at a counter is comparative — what is
   * this on trade, what do I pay on my account — and the old answer forced the
   * cashier to switch the till's price type to find out, which silently changes
   * what the next scan rings up. A price CHECK must not be able to mis-price a
   * sale. See PriceCheckModal.
   *
   * Online-only. The offline catalogue is priced on one structure — whichever
   * the till last cached — so the ladder this dialog exists to show is the exact
   * thing that is not there. Quoting a wholesale customer a retail price from a
   * stale cache is worse than saying the connection is needed.
   */
  'price-enquiry': ({ handlers, online }) =>
    online
      ? handlers.priceCheck()
      : handlers.say('A price check needs the connection — it reads every price type.', 'info'),

  'gift-card-balance': ({ handlers, online }) =>
    online
      ? handlers.giftCardBalance()
      : handlers.say('Gift card balances need the connection.', 'info'),

  /*
   * The order queue on the till, not in the back office.
   *
   * A web order collected in store is a counter act — the customer is standing
   * there — so the list belongs on the screen the cashier is already using. The
   * old navigation opened a manager's pipeline view and took the till, basket and
   * all, off the display.
   */
  'online-orders': ({ handlers, online }) =>
    online
      ? handlers.showOnlineOrders()
      : handlers.say('Online orders need the connection — they live on the server.', 'info'),

  /*
   * The basket, put aside for somebody to pay off.
   *
   * ONLINE ONLY, like the order queue and for a stronger reason: a lay-by
   * issues a LAY number from the shared sequence the moment it opens, and the
   * customer walks out holding a document that refers to it. A till that
   * invented one offline would hand out a number another till may already have
   * used, against goods no other machine knows are spoken for.
   */
  'start-layby': ({ handlers, online }) =>
    online
      ? handlers.startLayby()
      : handlers.say('A lay-by needs the connection — it takes a number from the server.', 'info'),

  /*
   * The pad on the till rather than the back office's clock page.
   *
   * Clocking on is something somebody does ON their way to the counter, often
   * while another person is mid-sale on the same machine — so it has to be a
   * dialog over the till rather than a navigation that takes the basket off
   * screen. The PIN identifies who is clocking, which is what makes that safe:
   * the person tapping is usually not the one signed in.
   */
  'clock-in-out': ({ handlers, online }) =>
    online
      ? handlers.showClock()
      : handlers.say('The time clock needs the connection — hours are kept on the server.', 'info'),

  /*
   * Opens a dialog on the till rather than navigating to /cashbook.
   *
   * That navigation was a dead end twice over: the cashbook needs `cashbook.edit`,
   * which a cashier does not hold, and it is a back-office screen on a machine that
   * may have no keyboard. A customer paying their account at the counter is an
   * ordinary counter act and belongs here.
   *
   * Still online-only, and that is not a limitation to remove later: a receipt moves
   * a real balance, and taking one against a stale offline copy is how somebody pays
   * R2,000 twice.
   */
  'customer-payment': ({ handlers, online }) =>
    online
      ? handlers.takePayment()
      : handlers.say('Taking a payment against an account needs the connection.', 'info'),

  /*
   * A deposit against the basket on screen (172).
   *
   * Online-only, for a different reason than the one above. A basket parked
   * while the line is down exists only as a uid on this till and never syncs, so
   * money held against it would have no record anywhere else — a hole in the
   * reconciliation rather than a feature. The dialog says so itself; this
   * refuses earlier so the cashier is not led into it.
   */
  'take-deposit': ({ handlers, online }) =>
    online
      ? handlers.takeDeposit()
      : handlers.say('Taking a deposit needs the connection.', 'info'),

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
   * ── THESE TWO ARE NOW THE ONLY WAY IN ─────────────────────────────────────
   *
   * They used to be signposts, pointing at a pair of buttons on the table gate's
   * header: "tap Split a bill on the floor". Those buttons are gone — a gesture
   * every shop paid for in header space whether or not it served tables — so the
   * keys DO the thing now instead of describing it.
   *
   * Still two taps, and that is the gesture rather than a shortcoming: a split
   * moves lines between two bills and neither the key nor the basket knows which
   * pair the waiter means. The key opens the floor with the mode armed; the floor
   * asks which bill, because it is the only screen that can.
   */
  'split-table': ({ handlers }) => handlers.armSplit(),

  /* `add-tip` was here and only ever said "go and use the payment screen", which
     is where tips are actually declared — a tip and change divide one excess, and
     the tender pad is where that excess is. Removed from the catalogue; see
     QUICK_KEY_ACTIONS in lib/quickKeys. */

  'table-transfer': ({ handlers }) => handlers.armTransfer(),

  /* This key IS the bill now. It used to point at a button beside the basket —
     a pair of keys the basket carried whether or not the shop served tables —
     so the slip header lost them and the key does the printing itself. */
  'bill-print': ({ handlers, online }) =>
    online
      ? handlers.printBill()
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
   * `save-as-order` used to sit here, pointing at the back office. It is now in RUN
   * — the till writes the order itself — and its entry was removed the moment that
   * landed, per the rule stated below: an entry left behind lies to a cashier about
   * a feature that works.
   *
   * Lay-bys stay. A lay-by is a payment schedule against stock held over weeks, and
   * the deposit taken to open one is money changing hands — so it is a bigger thing
   * than a doc type on the basket, and the back office is still where it is done.
   */
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

  /* A recall key pressed on a restaurant till. Reachable when a shop set the key up
     before switching to hospitality, so it explains itself rather than opening a
     second list of the same bills the floor is already showing. */
  if (action.retailOnly && ctx.hospitality) {
    handlers.say('The floor lists every open bill — tap the table to bring it back.', 'info')
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
  /* Recalling on a restaurant till: the gate already lists every open bill, so a
     saved-sales key is a second floor beside the real one. Saving is NOT in this
     bucket any more — it runs the same path as Close, so it works on both. */
  if (action.retailOnly && ctx.hospitality) return false
  return true
}
