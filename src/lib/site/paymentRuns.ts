import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute, siteTransaction } from '../siteDb'
import { round, toNum } from '../decimals'
import { postSupplierTransaction, allocateSupplier, openSupplierDebits } from './supplierLedger'
import { discountFor, addDays } from './interestRules'
import { logActivity, type Actor } from './activityLog'

/**
 * Paying suppliers.
 *
 * THE POINT IS THE ALLOCATION. A supplier who receives R14 320.55 with no
 * explanation has to guess which of their invoices it settles, and will guess
 * differently from us. Recording which invoices each payment covers — before
 * posting, so it can be reviewed — is what a remittance advice exists to
 * communicate.
 *
 * ── HOW A RUN WORKS ──────────────────────────────────────────────────────
 *
 *   1. Propose: pick suppliers, and per supplier pick the invoices to settle.
 *   2. Review: the run sits as a draft; nothing has been paid.
 *   3. Post: one payment per supplier hits the ledger, allocated against
 *      exactly the invoices chosen. Never a guess.
 *
 * Step 2 is why this is a table rather than a single action. Money leaving the
 * business deserves a look before it goes.
 */

export type PaymentRunStatus = 'draft' | 'posted' | 'cancelled'

export type PaymentRun = {
  id: number
  paymentDate: string
  reference: string | null
  status: PaymentRunStatus
  totalAmount: number
  supplierCount: number
  userName: string
  postedAt: Date | null
  notes: string | null
  createdAt: Date
}

export type PaymentItem = {
  id: number
  runId: number
  supplierId: number
  supplierCode: string
  supplierName: string
  email: string | null
  amount: number
  /** Settlement discount earned across this supplier's invoices. */
  discountAmount: number
  transactionId: number | null
  /** The credit note raised for the discount. Null when none was taken. */
  discountTxnId: number | null
  remittanceStatus: 'none' | 'queued' | 'sent' | 'failed'
  remittanceError: string | null
  remittanceSentAt: Date | null
  allocations: PaymentAllocation[]
}

export type PaymentAllocation = {
  id: number
  txnId: number
  docNumber: string | null
  docDate: string | null
  docAmount: number
  amount: number
  /** Discount taken on this invoice, so a remittance can show it line by line. */
  discountAmount: number
}

type Row = RowDataPacket & Record<string, unknown>

function mapRun(r: Row): PaymentRun {
  return {
    id: Number(r.id),
    paymentDate: String(r.payment_date),
    reference: (r.reference as string | null) ?? null,
    status: String(r.status) as PaymentRunStatus,
    totalAmount: toNum(r.total_amount),
    supplierCount: Number(r.supplier_count),
    userName: String(r.user_name ?? ''),
    postedAt: (r.posted_at as Date | null) ?? null,
    notes: (r.notes as string | null) ?? null,
    createdAt: r.created_at as Date,
  }
}

function mapAllocation(r: Row): PaymentAllocation {
  return {
    id: Number(r.id),
    txnId: Number(r.txn_id),
    docNumber: (r.doc_number as string | null) ?? null,
    docDate: r.doc_date === null ? null : String(r.doc_date),
    docAmount: toNum(r.doc_amount),
    amount: toNum(r.amount),
    discountAmount: toNum(r.discount_amount),
  }
}

export async function getPaymentRun(siteId: number, id: number): Promise<PaymentRun | null> {
  const row = await siteQueryOne<Row>(
    siteId,
    'SELECT * FROM supplier_payment_runs WHERE id = ? LIMIT 1',
    [id],
  )
  return row ? mapRun(row) : null
}

export async function listPaymentRuns(siteId: number, limit = 20): Promise<PaymentRun[]> {
  const capped = Math.min(Math.max(limit, 1), 100)
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT * FROM supplier_payment_runs ORDER BY created_at DESC LIMIT ${capped}`,
  )
  return rows.map(mapRun)
}

export async function listPaymentItems(siteId: number, runId: number): Promise<PaymentItem[]> {
  const [items, allocations] = await Promise.all([
    siteQuery<Row>(
      siteId,
      'SELECT * FROM supplier_payment_items WHERE run_id = ? ORDER BY supplier_name',
      [runId],
    ),
    siteQuery<Row>(
      siteId,
      `SELECT a.* FROM supplier_payment_allocations a
         JOIN supplier_payment_items i ON i.id = a.item_id
        WHERE i.run_id = ? ORDER BY a.doc_date, a.id`,
      [runId],
    ),
  ])

  const byItem = new Map<number, PaymentAllocation[]>()
  for (const row of allocations) {
    const itemId = Number(row.item_id)
    const list = byItem.get(itemId) ?? []
    list.push(mapAllocation(row))
    byItem.set(itemId, list)
  }

  return items.map((r) => ({
    id: Number(r.id),
    runId: Number(r.run_id),
    supplierId: Number(r.supplier_id),
    supplierCode: String(r.supplier_code),
    supplierName: String(r.supplier_name),
    email: (r.email as string | null) ?? null,
    amount: toNum(r.amount),
    discountAmount: toNum(r.discount_amount),
    transactionId: r.transaction_id === null ? null : Number(r.transaction_id),
    discountTxnId: r.discount_txn_id === null ? null : Number(r.discount_txn_id),
    remittanceStatus: String(r.remittance_status) as PaymentItem['remittanceStatus'],
    remittanceError: (r.remittance_error as string | null) ?? null,
    remittanceSentAt: (r.remittance_sent_at as Date | null) ?? null,
    allocations: byItem.get(Number(r.id)) ?? [],
  }))
}

/* ── Proposing a run ─────────────────────────────────────────────────────── */

export type PayableInvoice = {
  txnId: number
  docNumber: string | null
  docDate: string
  dueDate: string | null
  amount: number
  outstanding: number
  daysOverdue: number
  /** What paying by the deadline below would save. Zero when nothing is on offer. */
  discountAvailable: number
  /** The last date the discount can still be earned. Null when there is none. */
  discountDeadline: string | null
  /** Days until that deadline. Negative once missed. */
  discountDaysRemaining: number
}

export type PayableSupplier = {
  supplierId: number
  code: string
  name: string
  email: string | null
  balance: number
  invoices: PayableInvoice[]
  /** Everything already past its due date — the sensible default to pay. */
  overdueTotal: number
  /**
   * What could still be saved by paying this supplier's invoices early.
   *
   * The single most valuable thing a creditors ledger knows and the reason
   * settlement terms were added in 037: "paying these six invoices by Thursday
   * saves R4 200" is actionable in a way that an age analysis is not.
   */
  discountAvailable: number
  /** The soonest discount deadline across their invoices, for sorting by urgency. */
  nextDiscountDeadline: string | null
}

/**
 * What could be paid, grouped by supplier.
 *
 * Ordered by how overdue the oldest item is, so the suppliers most likely to
 * stop supplying appear first — which is the actual question behind "who should
 * we pay this week".
 */
export async function payableSuppliers(
  siteId: number,
  opts: { asAt?: string; overdueOnly?: boolean } = {},
): Promise<PayableSupplier[]> {
  const asAt = opts.asAt ?? todayIso()

  const rows = await siteQuery<Row>(
    siteId,
    `SELECT s.id AS supplier_id, s.code, s.name, s.email, s.balance,
            s.settlement_discount_days, s.settlement_discount_pct,
            t.id AS txn_id, t.doc_number, t.doc_date, t.due_date,
            t.amount_signed, t.amount_outstanding,
            DATEDIFF(?, COALESCE(t.due_date, t.doc_date)) AS days_overdue
       FROM supplier_transactions t
       JOIN suppliers s ON s.id = t.supplier_id
      WHERE t.amount_outstanding > 0
        AND s.status IN ('active','on_hold')
      ORDER BY s.name, t.doc_date`,
    [asAt],
  )

  const bySupplier = new Map<number, PayableSupplier>()

  for (const row of rows) {
    const supplierId = Number(row.supplier_id)
    let entry = bySupplier.get(supplierId)
    if (!entry) {
      entry = {
        supplierId,
        code: String(row.code),
        name: String(row.name),
        email: (row.email as string | null) ?? null,
        balance: toNum(row.balance),
        invoices: [],
        overdueTotal: 0,
        discountAvailable: 0,
        nextDiscountDeadline: null,
      }
      bySupplier.set(supplierId, entry)
    }

    const daysOverdue = Number(row.days_overdue ?? 0)
    const outstanding = toNum(row.amount_outstanding)

    if (opts.overdueOnly && daysOverdue <= 0) continue

    // What paying this invoice early would still earn. discountFor returns zero
    // once the window has passed — the cliff is deliberate, see interestRules.ts.
    const terms = {
      days: Number(row.settlement_discount_days ?? 0),
      pct: toNum(row.settlement_discount_pct),
    }
    const discount = discountFor(String(row.doc_date), outstanding, terms, asAt)

    entry.invoices.push({
      txnId: Number(row.txn_id),
      docNumber: (row.doc_number as string | null) ?? null,
      docDate: String(row.doc_date),
      dueDate: row.due_date === null ? null : String(row.due_date),
      amount: toNum(row.amount_signed),
      outstanding,
      daysOverdue: Math.max(daysOverdue, 0),
      discountAvailable: discount.discount,
      discountDeadline: discount.discount > 0 ? discount.deadline : null,
      discountDaysRemaining: discount.daysRemaining,
    })

    if (daysOverdue > 0) entry.overdueTotal = round(entry.overdueTotal + outstanding, 2)

    if (discount.discount > 0) {
      entry.discountAvailable = round(entry.discountAvailable + discount.discount, 2)
      if (!entry.nextDiscountDeadline || discount.deadline < entry.nextDiscountDeadline) {
        entry.nextDiscountDeadline = discount.deadline
      }
    }
  }

  return [...bySupplier.values()]
    .filter((s) => s.invoices.length > 0)
    .sort((a, b) => {
      // An expiring discount outranks an old invoice: the overdue one will
      // still be payable tomorrow, the discount will not. Only real money
      // jumps the queue, so a token saving does not displace a supplier who is
      // about to stop supplying.
      const aUrgent = a.discountAvailable > 0 && (a.nextDiscountDeadline ?? '') <= addDays(asAt, 7)
      const bUrgent = b.discountAvailable > 0 && (b.nextDiscountDeadline ?? '') <= addDays(asAt, 7)
      if (aUrgent !== bUrgent) return aUrgent ? -1 : 1

      const aOldest = Math.max(...a.invoices.map((i) => i.daysOverdue), 0)
      const bOldest = Math.max(...b.invoices.map((i) => i.daysOverdue), 0)
      return bOldest - aOldest || b.overdueTotal - a.overdueTotal
    })
}

export type CreateRunInput = {
  paymentDate: string
  reference?: string | null
  notes?: string | null
  payments: {
    supplierId: number
    /**
     * Which invoices this payment settles, and by how much each.
     *
     * `discount` is settlement discount taken on that invoice. Payment plus
     * discount must equal what is outstanding — the invoice settles in FULL or
     * not at all. See the note on postPaymentRun for why a discount cannot
     * simply be a smaller payment.
     */
    allocations: { txnId: number; amount: number; discount?: number }[]
  }[]
}

export type CreateResult = { ok: true; runId: number } | { ok: false; error: string }

export async function createPaymentRun(
  siteId: number,
  actor: Actor,
  input: CreateRunInput,
): Promise<CreateResult> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.paymentDate)) {
    return { ok: false, error: 'Choose a payment date.' }
  }
  if (input.payments.length === 0) return { ok: false, error: 'Choose at least one supplier.' }

  // Validate every allocation against what is actually outstanding, before
  // anything is written. Paying more than an invoice is worth would leave a
  // credit nobody asked for sitting on the supplier's account.
  const prepared: {
    supplierId: number
    code: string
    name: string
    email: string | null
    amount: number
    /** Settlement discount across this supplier's invoices, if any was taken. */
    discount: number
    allocations: {
      txnId: number
      amount: number
      discount: number
      docNumber: string | null
      docDate: string
      docAmount: number
    }[]
  }[] = []

  for (const payment of input.payments) {
    const supplier = await siteQueryOne<Row>(
      siteId,
      'SELECT id, code, name, email, status FROM suppliers WHERE id = ? LIMIT 1',
      [payment.supplierId],
    )
    if (!supplier) return { ok: false, error: 'One of those suppliers no longer exists.' }
    if (String(supplier.status) === 'closed') {
      return { ok: false, error: `${supplier.name}'s account is closed.` }
    }
    if (payment.allocations.length === 0) {
      return { ok: false, error: `Choose what to pay for ${supplier.name}.` }
    }

    const allocations: (typeof prepared)[number]['allocations'] = []
    let total = 0
    let discountTotal = 0

    for (const allocation of payment.allocations) {
      const txn = await siteQueryOne<Row>(
        siteId,
        `SELECT id, supplier_id, doc_number, doc_date, amount_signed, amount_outstanding
           FROM supplier_transactions WHERE id = ? LIMIT 1`,
        [allocation.txnId],
      )
      if (!txn) return { ok: false, error: 'One of those invoices no longer exists.' }
      if (Number(txn.supplier_id) !== payment.supplierId) {
        return { ok: false, error: 'An invoice does not belong to that supplier.' }
      }

      const outstanding = toNum(txn.amount_outstanding)
      const amount = round(allocation.amount, 2)
      const discount = round(allocation.discount ?? 0, 2)

      if (amount <= 0) return { ok: false, error: 'A payment amount must be positive.' }
      if (discount < 0) return { ok: false, error: 'A discount cannot be negative.' }
      if (amount > outstanding + 0.005) {
        return {
          ok: false,
          error: `${txn.doc_number ?? 'That invoice'} only has ${outstanding.toFixed(2)} outstanding.`,
        }
      }

      // Payment plus discount must settle the invoice EXACTLY. Anything else is
      // a discount that leaves a few rand outstanding forever, on an invoice
      // both sides consider closed — which is how a creditors ledger fills with
      // phantom balances nobody will ever pay or write off.
      if (discount > 0 && round(amount + discount, 2) !== round(outstanding, 2)) {
        return {
          ok: false,
          error: `${txn.doc_number ?? 'That invoice'} is ${outstanding.toFixed(2)}, but ${amount.toFixed(2)} plus ${discount.toFixed(2)} discount comes to ${round(amount + discount, 2).toFixed(2)}. A settlement discount must clear the invoice in full.`,
        }
      }

      allocations.push({
        txnId: Number(txn.id),
        amount,
        discount,
        docNumber: (txn.doc_number as string | null) ?? null,
        docDate: String(txn.doc_date),
        docAmount: toNum(txn.amount_signed),
      })
      total = round(total + amount, 2)
      discountTotal = round(discountTotal + discount, 2)
    }

    prepared.push({
      supplierId: payment.supplierId,
      code: String(supplier.code),
      name: String(supplier.name),
      email: (supplier.email as string | null) ?? null,
      amount: total,
      discount: discountTotal,
      allocations,
    })
  }

  const grandTotal = prepared.reduce((sum, p) => round(sum + p.amount, 2), 0)

  return siteTransaction(siteId, async (tx) => {
    const [res] = await tx.execute(
      `INSERT INTO supplier_payment_runs
         (payment_date, reference, total_amount, supplier_count, user_id, user_name, notes)
       VALUES (?,?,?,?,?,?,?)`,
      [
        input.paymentDate,
        input.reference?.trim() || null,
        grandTotal.toFixed(4),
        prepared.length,
        actor.userId,
        actor.userName.slice(0, 120),
        input.notes?.trim() || null,
      ] as never,
    )
    const runId = (res as { insertId: number }).insertId

    for (const payment of prepared) {
      const [itemRes] = await tx.execute(
        `INSERT INTO supplier_payment_items
           (run_id, supplier_id, supplier_code, supplier_name, email, amount, discount_amount)
         VALUES (?,?,?,?,?,?,?)`,
        [
          runId,
          payment.supplierId,
          payment.code,
          payment.name,
          payment.email,
          payment.amount.toFixed(4),
          payment.discount.toFixed(4),
        ] as never,
      )
      const itemId = (itemRes as { insertId: number }).insertId

      for (const allocation of payment.allocations) {
        await tx.execute(
          `INSERT INTO supplier_payment_allocations
             (item_id, txn_id, doc_number, doc_date, doc_amount, amount, discount_amount)
           VALUES (?,?,?,?,?,?,?)`,
          [
            itemId,
            allocation.txnId,
            allocation.docNumber,
            allocation.docDate,
            allocation.docAmount.toFixed(4),
            allocation.amount.toFixed(4),
            allocation.discount.toFixed(4),
          ] as never,
        )
      }
    }

    return { ok: true as const, runId }
  })
}

/* ── Posting ─────────────────────────────────────────────────────────────── */

export type PostResult =
  | { ok: true; paid: number; total: number; discount: number }
  | { ok: false; error: string }

/**
 * Posts a run: one payment per supplier, allocated against the chosen invoices.
 *
 * Allocation is EXPLICIT here, never auto. The whole run exists so that the
 * remittance can say which invoices were settled; falling back to oldest-first
 * at posting time would make the advice a guess again.
 *
 * ── WHY A DISCOUNT IS A CREDIT NOTE, NOT A SMALLER PAYMENT ───────────────
 *
 * Take 2% on a R1 000 invoice and pay R980. If that is all that happens, the
 * invoice keeps R20 outstanding for ever: we consider it closed, the supplier
 * considers it closed, and the ledger disagrees with both. Multiply by every
 * discounted invoice and the creditors book fills with phantom balances nobody
 * will pay and nobody will write off.
 *
 * So the discount is posted as its own CREDIT NOTE and allocated against the
 * same invoices. The invoice settles in full — R980 of payment plus R20 of
 * credit — and the saving is a visible document rather than a silent shortfall.
 *
 * One credit note per supplier rather than per invoice: it is a single
 * commercial event on their account, and their remittance shows the split.
 */
export async function postPaymentRun(
  siteId: number,
  actor: Actor,
  runId: number,
): Promise<PostResult> {
  const run = await getPaymentRun(siteId, runId)
  if (!run) return { ok: false, error: 'That run no longer exists.' }
  if (run.status === 'posted') return { ok: false, error: 'That run has already been paid.' }
  if (run.status === 'cancelled') return { ok: false, error: 'That run was cancelled.' }

  const items = await listPaymentItems(siteId, runId)
  if (items.length === 0) return { ok: false, error: 'There is nothing to pay.' }

  let paid = 0
  let total = 0
  let discountTotal = 0

  for (const item of items) {
    // Posted outside a wrapping transaction, per supplier: the ledger keeps its
    // own invariant, and one supplier failing must not roll back payments to
    // the others that already went to the bank.
    const posted = await postSupplierTransaction(siteId, actor, {
      supplierId: item.supplierId,
      docType: 'payment',
      amount: item.amount,
      docDate: run.paymentDate,
      reference: run.reference,
      description: `Payment run ${run.paymentDate}${run.reference ? ` · ${run.reference}` : ''}`,
      source: 'payment_run',
      sourceDocId: runId,
    })

    if (!posted.ok) continue

    // Allocate against exactly what was chosen.
    for (const allocation of item.allocations) {
      await allocateSupplier(siteId, actor, allocation.txnId, posted.id, allocation.amount)
    }

    // The discount, as its own credit note against the same invoices. Posted
    // after the payment so a failure here leaves a payment short rather than a
    // credit floating against nothing — the first is visible on the age
    // analysis, the second is not.
    let discountTxnId: number | null = null
    if (item.discountAmount > 0) {
      const credit = await postSupplierTransaction(siteId, actor, {
        supplierId: item.supplierId,
        docType: 'credit_note',
        amount: item.discountAmount,
        docDate: run.paymentDate,
        reference: run.reference,
        description: `Settlement discount · payment run ${run.paymentDate}`,
        source: 'payment_run_discount',
        sourceDocId: runId,
      })

      if (credit.ok) {
        discountTxnId = credit.id
        for (const allocation of item.allocations) {
          if (allocation.discountAmount > 0) {
            await allocateSupplier(
              siteId,
              actor,
              allocation.txnId,
              credit.id,
              allocation.discountAmount,
            )
          }
        }
        discountTotal = round(discountTotal + item.discountAmount, 2)
      }
    }

    await siteExecute(
      siteId,
      'UPDATE supplier_payment_items SET transaction_id = ?, discount_txn_id = ? WHERE id = ?',
      [posted.id, discountTxnId, item.id],
    )

    paid++
    total = round(total + item.amount, 2)
  }

  await siteExecute(
    siteId,
    "UPDATE supplier_payment_runs SET status = 'posted', posted_at = NOW() WHERE id = ?",
    [runId],
  )

  await logActivity(siteId, actor, {
    entity: 'supplier',
    entityId: null,
    action: 'payment_run',
    detail:
      `Paid ${paid} supplier${paid === 1 ? '' : 's'}, ${total.toFixed(2)} total` +
      (discountTotal > 0 ? `, ${discountTotal.toFixed(2)} settlement discount earned` : ''),
  })

  return { ok: true, paid, total, discount: discountTotal }
}

export async function cancelPaymentRun(
  siteId: number,
  runId: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const run = await getPaymentRun(siteId, runId)
  if (!run) return { ok: false, error: 'That run no longer exists.' }
  if (run.status === 'posted') {
    return {
      ok: false,
      error: 'That run has already been paid. Reverse the individual payments instead.',
    }
  }

  await siteExecute(
    siteId,
    "UPDATE supplier_payment_runs SET status = 'cancelled' WHERE id = ?",
    [runId],
  )
  return { ok: true }
}

/**
 * Proposes paying everything overdue, oldest first.
 *
 * A starting point for the screen, not a decision — the run sits as a draft so
 * someone can take suppliers out before the money moves.
 */
export async function proposeOverdueRun(
  siteId: number,
  paymentDate: string,
): Promise<CreateRunInput> {
  const suppliers = await payableSuppliers(siteId, { overdueOnly: true })

  return {
    paymentDate,
    payments: suppliers.map((supplier) => ({
      supplierId: supplier.supplierId,
      allocations: supplier.invoices
        .filter((invoice) => invoice.daysOverdue > 0)
        .map((invoice) => ({
          // Pay the outstanding LESS any discount still on offer, and record
          // the discount so posting raises the credit note that closes the
          // invoice. An invoice that is both overdue and inside its discount
          // window is unusual but not impossible — short discount terms on long
          // payment terms — and paying full price there is throwing money away.
          txnId: invoice.txnId,
          amount: round(invoice.outstanding - invoice.discountAvailable, 2),
          discount: invoice.discountAvailable,
        })),
    })),
  }
}

/**
 * Proposes paying everything with a discount deadline inside the next `days`.
 *
 * The other half of "who should we pay this week", and the more valuable one:
 * an overdue invoice stays payable tomorrow, a discount does not. Every invoice
 * here settles in full — payment plus discount — so nothing is left dangling.
 */
export async function proposeDiscountRun(
  siteId: number,
  paymentDate: string,
  withinDays = 7,
): Promise<CreateRunInput> {
  const suppliers = await payableSuppliers(siteId, { asAt: paymentDate })
  const deadline = addDays(paymentDate, Math.max(withinDays, 0))

  return {
    paymentDate,
    payments: suppliers
      .map((supplier) => ({
        supplierId: supplier.supplierId,
        allocations: supplier.invoices
          .filter(
            (invoice) =>
              invoice.discountAvailable > 0 &&
              invoice.discountDeadline !== null &&
              invoice.discountDeadline <= deadline,
          )
          .map((invoice) => ({
            txnId: invoice.txnId,
            amount: round(invoice.outstanding - invoice.discountAvailable, 2),
            discount: invoice.discountAvailable,
          })),
      }))
      .filter((p) => p.allocations.length > 0),
  }
}

/** Open invoices for one supplier, for the payment screen's per-supplier panel. */
export async function payableInvoicesFor(
  siteId: number,
  supplierId: number,
): Promise<PayableInvoice[]> {
  const [lines, supplier] = await Promise.all([
    openSupplierDebits(siteId, supplierId),
    siteQueryOne<Row>(
      siteId,
      'SELECT settlement_discount_days, settlement_discount_pct FROM suppliers WHERE id = ? LIMIT 1',
      [supplierId],
    ),
  ])
  const today = todayIso()

  const terms = {
    days: Number(supplier?.settlement_discount_days ?? 0),
    pct: toNum(supplier?.settlement_discount_pct),
  }

  return lines.map((line) => {
    const discount = discountFor(line.docDate, line.amountOutstanding, terms, today)
    return {
      txnId: line.id,
      docNumber: line.docNumber,
      docDate: line.docDate,
      dueDate: line.dueDate,
      amount: line.amountSigned,
      outstanding: line.amountOutstanding,
      daysOverdue: line.daysOverdue ?? 0,
      discountAvailable: discount.discount,
      discountDeadline: discount.discount > 0 ? discount.deadline : null,
      discountDaysRemaining: discount.daysRemaining,
    }
  })
    // Oldest first: the order anyone settles a supplier account in.
    .sort((a, b) => (a.docDate < b.docDate ? -1 : a.docDate > b.docDate ? 1 : 0))
}

function todayIso(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')}`
}
