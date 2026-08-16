'use server'

import { actorForOrThrow, actorFor, withTillOperator } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { recordCustomerReceipt } from '@/lib/site/cashbook'
import { defaultAccount } from '@/lib/site/bankAccounts'
import { getTenderType } from '@/lib/site/tenderTypes'
import { openShiftFor, openShiftForUser, cashupMode, recordDrawerMovement } from '@/lib/site/shifts'
import { getTillCustomer } from '@/lib/site/tillCustomers'
import { openDebits } from '@/lib/site/customerLedger'

/**
 * Taking money against a customer's account, at the till.
 *
 * ── WHY THIS IS NOT THE CASHBOOK'S receiptAction ──────────────────────────
 *
 * That one gates on `cashbook.edit`, which is a back-office right a cashier does
 * not hold and should not be given: it is the right to touch bank transactions
 * generally. What a cashier needs is much narrower — take money from a person
 * standing in front of them and put it against their account — so this asks for
 * `sales.till` and does exactly that one thing, with the destination account and
 * the allocation decided here rather than by the caller.
 *
 * The ARITHMETIC is not duplicated. `recordCustomerReceipt` still writes the
 * ledger row, the bank row and the link between them, and still mirrors to the
 * GL. Everything below is about what a till may ask it for.
 *
 * ── THE DRAWER, WHICH IS THE PART THAT IS EASY TO GET WRONG ───────────────
 *
 * Cash handed over the counter is physically in the drawer. If the receipt only
 * reaches the cashbook, the cash-up expects a figure that does not include it and
 * the cashier is told they are OVER by exactly the amount they took — a variance
 * they cannot explain and did not cause, on every account payment, forever.
 *
 * So a cash receipt writes TWO records: the receipt itself, and a `payin` on the
 * open shift so the drawer's expected position includes it. Non-cash receipts
 * write only the first, because a card payment never touches the drawer and a
 * pay-in for it would leave the shift over by the same amount in the other
 * direction. The tender's own `countsAsDrawerCash` decides which, so a shop that
 * defines a new cash-like tender gets the right behaviour without a code change.
 *
 * The drawer movement is written AFTER the receipt and cannot roll it back. A
 * failure there leaves a correct receipt and a cash-up that is over — visible,
 * explainable, and fixable with a drawer movement by hand. The reverse ordering
 * would risk a drawer adjustment for money that was never receipted, which is
 * the same variance plus a lie about where it came from.
 */

type Denied = { ok: false; error: string }

/** What the till needs to show before taking money: who they are, what they owe. */
export type ReceiptCustomer = {
  id: number
  code: string
  name: string
  /** What they owe right now. Positive means they are in debt. */
  balance: number
  /** The open invoices this receipt would go against, oldest first. */
  openInvoices: { id: number; documentNumber: string | null; date: string; outstanding: number }[]
}

/**
 * The account as the payment dialog needs to see it.
 *
 * Read fresh rather than taken from whatever the basket is holding: this dialog
 * is explicitly for ANY customer, not the one on the sale, and a balance is the
 * one figure here that must not be stale — somebody is about to hand over money
 * based on it.
 */
export async function receiptCustomerAction(customerId: number): Promise<ReceiptCustomer | null> {
  const { siteId } = await actorForOrThrow('sales.till')

  const customer = await getTillCustomer(siteId, customerId)
  if (!customer) return null

  const open = await openDebits(siteId, customerId)
  return {
    id: customer.id,
    code: customer.code,
    name: customer.name,
    balance: customer.balance,
    openInvoices: open.map((line) => ({
      id: line.id,
      documentNumber: line.docNumber,
      date: line.docDate,
      outstanding: line.amountOutstanding,
    })),
  }
}

export type TillReceiptResult =
  | { ok: true; customerTxnId: number; newBalance: number; wentToDrawer: boolean }
  | Denied

/**
 * Records money taken against an account.
 *
 * `allocate` is the difference between paying a bill and topping up:
 *
 *   true  — put it against the oldest open invoices. Paying off what is owed.
 *   false — leave it sitting as an unapplied credit. A deposit, or money on
 *           account before there is anything to apply it to.
 *
 * Both are ordinary, and a till cannot guess which one somebody meant — a
 * customer with a zero balance handing over R500 is topping up, but so is one
 * with R200 outstanding who says "put the rest on my account". So the dialog asks
 * and this obeys, rather than inferring from the balance and being wrong.
 */
export async function tillCustomerReceiptAction(input: {
  customerId: number
  amount: number
  tenderTypeId: number
  reference?: string | null
  allocate: boolean
  terminalId?: number | null
}): Promise<TillReceiptResult> {
  const base = await actorFor('sales.till')
  if ('ok' in base) return base
  const ctx = await withTillOperator(base)
  const { siteId, actor } = ctx

  /* `cashbook.edit` is NOT required — see the header. But taking money is not
     something every till user should do either, so it rides on the same right
     that lets somebody sell: if they can take R500 for goods they can take R500
     for a bill. What they cannot do is anything else in the cashbook. */
  if (!can(ctx.capabilities, 'sales.till')) {
    return { ok: false, error: 'Taking a payment needs the till right.' }
  }

  const amount = Number(input.amount)
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: 'Enter an amount.' }
  }

  const tender = await getTenderType(siteId, input.tenderTypeId)
  if (!tender || !tender.isActive) {
    return { ok: false, error: 'Choose how they are paying.' }
  }
  /* An ACCOUNT tender here would be paying an account with the account. The pad
     refuses the same thing for the same reason; re-checked because this is a
     public endpoint and the pad is only a screen. */
  if (tender.postsToDebtor) {
    return { ok: false, error: `${tender.name} cannot pay off an account.` }
  }
  if (tender.requiresReference && !input.reference?.trim()) {
    return { ok: false, error: `${tender.referenceLabel ?? 'A reference'} is required.` }
  }

  const account = await defaultAccount(siteId, 'receipts')
  if (!account) {
    return { ok: false, error: 'No bank account is set up to receive money. Ask the office.' }
  }

  const receipt = await recordCustomerReceipt(siteId, actor, {
    customerId: input.customerId,
    bankAccountId: account.id,
    amount,
    reference: input.reference?.trim() || null,
    /* Names the tender and the till, because a bank statement line reading
       "Customer receipt" against a day of them is not reconcilable by anybody. */
    description: `${tender.name} at the till`,
    autoAllocate: input.allocate,
  })
  if (!receipt.ok) return receipt

  /* ── The drawer half. Cash only, and never allowed to undo the receipt. ── */
  let wentToDrawer = false
  if (tender.countsAsDrawerCash) {
    try {
      const mode = await cashupMode(siteId)
      const shift =
        mode === 'terminal'
          ? input.terminalId
            ? await openShiftFor(siteId, input.terminalId)
            : null
          : await openShiftForUser(siteId, actor.userId)

      if (shift) {
        const moved = await recordDrawerMovement(siteId, actor, shift.id, {
          type: 'payin',
          amount,
          reason: 'Account payment',
          terminalId: input.terminalId ?? null,
        })
        wentToDrawer = moved.ok
      }
    } catch {
      /* Swallowed on purpose. The money is receipted and the customer's balance is
         right; what is wrong is a cash-up that will read over by this amount, and
         that is a correctable variance rather than a reason to fail a payment
         somebody has already handed over. */
    }
  }

  const after = await getTillCustomer(siteId, input.customerId)
  return {
    ok: true,
    customerTxnId: receipt.customerTxnId,
    newBalance: after?.balance ?? 0,
    wentToDrawer,
  }
}
