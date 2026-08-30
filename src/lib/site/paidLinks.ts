import 'server-only'
import { getTenderByCode } from './tenderTypes'
import { formatMoney } from '../decimals'
import { postTransaction } from './customerLedger'
import { takePayment } from './laybys'
import { takeDeposit } from './deposits'
import { defaultAccount } from './bankAccounts'
import { takeDeposit as takeJobDeposit } from './jobDeposits'
import type { Actor } from './activityLog'

/**
 * What a settled pay-link MEANS, per purpose.
 *
 * The debtor-invoice and storefront-order cases live in paidInvoices.ts and
 * paidOrders.ts; this is the other four. Called ONLY from the PayFast ITN
 * handler, and only after it has verified the payload — signature, source IP,
 * post-back, merchant and amount — and successfully claimed the intent. Every
 * function here trusts what it is told, exactly as its two siblings do, because
 * the checking has already happened upstream.
 *
 * ── THE RULE THAT SHAPES ALL FOUR ─────────────────────────────────────────
 *
 * A pay-link COLLECTS MONEY. It never advances a document's state.
 *
 * Nothing here converts a quote, delivers an order, completes a lay-by or
 * closes a job. Each of those is a commercial judgement with its own guards —
 * prices may have moved, stock may be short, the goods may not be ready — and a
 * payment is not evidence about any of them. Money arriving is one fact; what
 * to do about it is a decision, and it stays with a person.
 *
 * The concrete failure this avoids: converting a paid quote automatically would
 * take the cash and only then discover the stock is not there, leaving the shop
 * holding money against goods it cannot supply and the customer holding a paid
 * invoice for them. Quotes reserve nothing, so several open quotes for the last
 * unit are all payable at once — the ordinary case, not a corner.
 *
 * ── AND WHY NONE OF THEM DECLARE VAT ──────────────────────────────────────
 *
 * A receipt carries no VAT. Every one of these is either money against a debt
 * whose tax point has already passed (the statement) or money held before any
 * supply has happened at all (the three deposits). Declaring output VAT here
 * would overstate the return by the full value of every online payment.
 */

export type SettleResult = { ok: true; detail: string } | { ok: false; error: string }

/** What each purpose is called in a notification, in the shop's words. */
const PURPOSE_LABEL: Record<string, string> = {
  debtor_invoice: 'invoice',
  customer_account: 'account',
  layby: 'lay-by',
  document_deposit: 'deposit',
  job_deposit: 'job deposit',
  online_order: 'online order',
}

/**
 * Tell the shop money arrived, and record it on the customer's timeline.
 *
 * ── THE GAP THIS CLOSES ───────────────────────────────────────────────────
 *
 * Every other part of a pay link was DISCOVERABLE — the receipt sits on the
 * account, the deposit sits on the document — and none of it was ANNOUNCED. So
 * a customer could pay at eleven at night and the business would find out by
 * happening to look at the right screen. A shop that cannot tell whether it has
 * been paid keeps phoning to ask, which is the call the feature existed to stop.
 *
 * ── IT NEVER THROWS, AND IS ALWAYS CALLED LAST ────────────────────────────
 *
 * The money has already arrived and the posting has already happened by the
 * time this runs. A failure here must not turn a settled payment into an error
 * the callback reports — PayFast would retry a payment that is already
 * recorded. Both writes swallow their own failures for the same reason.
 */
export async function announcePayment(
  siteId: number,
  input: {
    purpose: string
    /** What was paid — "INV000123", "Lay-by LAY-88", an account code. */
    what: string
    amount: number
    /** PayFast's own id, so a query to the gateway can be matched up. */
    providerRef: string
    /** Where the bell should take somebody. */
    href?: string | null
    /** The account it belongs to, where there is one. */
    customerId?: number | null
  },
): Promise<void> {
  const label = PURPOSE_LABEL[input.purpose] ?? 'payment'
  const money = formatMoney(input.amount)

  try {
    const { notify } = await import('./notifications')
    await notify(siteId, {
      event: 'online_payment_received',
      // Whoever may see sales may see that a sale was paid for. Not a narrower
      // right: the person who raised the invoice is rarely the one chasing it.
      audience: 'sales.view',
      title: `${money} received — ${input.what}`,
      body: `Paid online against this ${label}. PayFast reference ${input.providerRef}.`,
      href: input.href ?? null,
    })
  } catch (error) {
    console.error('[pay-links] notify failed for', input.what, error)
  }

  // The customer's own timeline. Nothing else on the money paths writes this
  // for an online payment, so an account's history simply skipped them.
  if (input.customerId) {
    try {
      const { logActivity } = await import('./activityLog')
      await logActivity(
        siteId,
        { userId: 0, userName: 'Online payment' },
        {
          entity: 'customer',
          entityId: input.customerId,
          action: 'online_payment',
          detail: `${money} paid online against ${input.what} — PayFast ${input.providerRef}`,
        },
      )
    } catch (error) {
      console.error('[pay-links] activity log failed for', input.what, error)
    }
  }
}

/**
 * The tender every online payment is banked against.
 *
 * ONLINE, created by 038_payments.sql with counts_as_drawer_cash = 0 — which is
 * the load-bearing flag. The money never went into a drawer and never went
 * through the shop's card machine, so banking it as cash or card would make
 * every cash-up and tender report claim takings that are not physically there,
 * and the person counting the drawer would be short with no explanation.
 */
async function onlineTender(siteId: number): Promise<{ id: number; name: string } | null> {
  const tender = await getTenderByCode(siteId, 'ONLINE')
  return tender ? { id: tender.id, name: tender.name } : null
}

/**
 * A payment against a STATEMENT.
 *
 * ── WHY NOT settlePaidInvoice ─────────────────────────────────────────────
 *
 * Because a statement is a BALANCE, not a document. Its target_id is a customer
 * id, and there is no single invoice the money is against — that is the whole
 * difference between paying a statement and paying an invoice.
 *
 * Routing it through settlePaidInvoice would mean choosing an invoice to
 * receipt for the entire amount, which is wrong twice over: it credits one
 * document with money meant for several, and it leaves the rest showing as open
 * while the balance says otherwise.
 *
 * So it posts an ordinary receipt and lets `autoAllocate` settle the open items
 * oldest-first — which is exactly what "a payment against a statement" has
 * always meant on a debtors ledger, and what balance_fwd accounts do by default
 * (see 023_customer_account_types.sql).
 */
export async function settleAccountPayment(
  siteId: number,
  actor: Actor,
  customerId: number,
  amountPaid: number,
  providerRef: string,
): Promise<SettleResult> {
  const posted = await postTransaction(siteId, actor, {
    customerId,
    docType: 'payment',
    // No document number: this money is not a document. Giving it one would
    // trip the ledger's duplicate-number guard against a real invoice.
    docNumber: null,
    docDate: undefined,
    reference: providerRef,
    description: 'Online payment — statement',
    amount: Math.abs(amountPaid),
    // No VAT on a receipt. See the header.
    vatRatePct: 0,
    source: 'payfast',
    // Oldest-first. Without it the balance is right and every document still
    // reads as open, so the age analysis keeps chasing what has been paid.
    autoAllocate: true,
  })

  if (!posted.ok) return { ok: false, error: posted.error }
  return { ok: true, detail: `receipt #${posted.id} on customer ${customerId}` }
}

/**
 * A lay-by instalment.
 *
 * ── THE CASE THIS FEATURE REALLY EXISTS FOR ───────────────────────────────
 *
 * A lay-by customer is frequently a `cash` account — a person on file who was
 * never granted credit — and until now the only way to pay one off was to stand
 * at the counter with a card. This is the nearest thing to "a walk-in pays
 * remotely" that the system can actually express, because a finalised invoice
 * with money owing is by definition an account sale.
 *
 * ── IT DOES NOT COMPLETE THE LAY-BY ───────────────────────────────────────
 *
 * takePayment moves no stock, raises no invoice and declares no VAT; that all
 * happens at completeLayby, when the goods are handed over. A final instalment
 * paid online means the customer may now collect — not that they have. Somebody
 * has to give them the goods, and that person completes it.
 */
export async function settleLaybyPayment(
  siteId: number,
  actor: Actor,
  laybyId: number,
  amountPaid: number,
  providerRef: string,
): Promise<SettleResult> {
  const tender = await onlineTender(siteId)
  if (!tender) return { ok: false, error: 'No ONLINE tender type is configured.' }

  const result = await takePayment(siteId, actor, laybyId, {
    amount: Math.abs(amountPaid),
    tenderTypeId: tender.id,
    tenderName: tender.name,
    reference: providerRef,
    // No terminal: nobody was at a till. shiftToBankInto resolves this to the
    // site's own banking rather than a cashier's drawer, which is right — the
    // money is in the bank, not in anybody's float.
    terminalId: null,
    note: 'Paid online',
  })

  if (!result.ok) return { ok: false, error: result.error }
  return {
    ok: true,
    detail: result.settled
      ? `lay-by ${laybyId} paid in full — ready to collect`
      : `lay-by ${laybyId}, ${result.outstanding.toFixed(2)} still to pay`,
  }
}

/**
 * A deposit against a QUOTE or a SALES ORDER.
 *
 * ── ONE HANDLER FOR BOTH, DELIBERATELY ────────────────────────────────────
 *
 * They differ upstream of the money and not at all here: both target a
 * sales_documents id, and both take a deposit held against that document until
 * somebody converts or delivers it. Two purposes would be two names for one
 * function.
 *
 * ── WHAT IT REFUSES TO DO ─────────────────────────────────────────────────
 *
 * It does not convert the quote and it does not deliver the order. See the
 * header: convertToInvoice raises a draft plus three warnings a person must
 * read, and deliverOrder invoices an order in PARTS — a payment does not say
 * which delivery it settles, so invoicing on receipt would bill for goods that
 * have not shipped.
 *
 * The deposit is applied by applyDepositsTx when the invoice is finally
 * raised, which is the same path an over-the-counter deposit takes. Nothing
 * here is a special case of anything.
 */
export async function settleDocumentDeposit(
  siteId: number,
  actor: Actor,
  documentId: number,
  amountPaid: number,
  providerRef: string,
): Promise<SettleResult> {
  const tender = await onlineTender(siteId)
  if (!tender) return { ok: false, error: 'No ONLINE tender type is configured.' }

  const result = await takeDeposit(siteId, actor, {
    documentId,
    amount: Math.abs(amountPaid),
    tenderTypeId: tender.id,
    tenderName: tender.name,
    reference: providerRef,
    terminalId: null,
    note: 'Paid online',
  })

  if (!result.ok) return { ok: false, error: result.error }
  return {
    ok: true,
    detail: `deposit ${result.depositId} on document ${documentId} — ${result.held.toFixed(2)} held`,
  }
}

/**
 * A deposit against a JOB CARD.
 *
 * ── WHY THIS ONE NEEDS A BANK ACCOUNT AND THE OTHERS DO NOT ───────────────
 *
 * jobDeposits posts to the CASHBOOK — the money lands in a named account rather
 * than being held against a document — so it needs to be told which one. There
 * is nobody signed in at a callback to choose, so it takes the site's default
 * account, which is the same one every unattended posting path uses.
 *
 * If a shop has no default account the deposit is refused rather than guessed
 * at. Money in the wrong account is a reconciliation somebody has to unpick by
 * hand, and it is discovered a month later; a refusal is discovered now, and
 * the payment itself still stands.
 *
 * ── A WALK-IN JOB CANNOT TAKE ONE ─────────────────────────────────────────
 *
 * takeDeposit refuses a job with no customer, because a cashbook deposit has to
 * land on an account. That refusal is inherited on purpose — the fix is to put
 * a customer on the job, which is a person's decision.
 */
export async function settleJobDeposit(
  siteId: number,
  actor: Actor,
  jobId: number,
  amountPaid: number,
  providerRef: string,
): Promise<SettleResult> {
  // 'receipts' — money coming IN. The payments account is where the shop pays
  // suppliers from, and banking a customer's deposit there would put a receipt
  // in the account somebody reconciles as outgoings.
  const account = await defaultAccount(siteId, 'receipts')
  if (!account) {
    return { ok: false, error: 'No default bank account, so there is nowhere to bank it.' }
  }

  const result = await takeJobDeposit(siteId, actor, jobId, {
    amount: Math.abs(amountPaid),
    bankAccountId: account.id,
    reference: providerRef,
    description: 'Paid online',
  })

  if (!result.ok) return { ok: false, error: result.error }
  return { ok: true, detail: `deposit ${result.transactionId} on job ${jobId}` }
}
