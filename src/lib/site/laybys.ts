import 'server-only'
import { siteQuery, siteQueryOne, siteExecute, siteTransaction } from '@/lib/siteDb'
import { round, toNum } from '@/lib/decimals'
import { lineTotals, documentTotals } from '@/lib/documentMath'
import {
  cancellationOutcome,
  outstanding,
  isSettled,
  paymentRefusal,
  clampFeePct,
  type FeeWaiverReason,
} from '@/lib/laybyRules'
import { nextDocumentNumber } from './sequences'
import { getSettings } from './settings'
import { saveDraft, getDocument, todayIso } from './salesDocuments'
import { finaliseDocument } from './salesPosting'
import { shiftToBankInto } from './shifts'
import { logActivity, type Actor } from './activityLog'

/**
 * Lay-bys — goods set aside and paid off over time.
 *
 * ── THE THREE RULES THAT SHAPE EVERYTHING HERE ───────────────────────────
 *
 * 1. **The money is the customer's.** Section 62 of the Consumer Protection
 *    Act says payments remain the consumer's property until delivery. So a
 *    lay-by payment goes in `layby_payments`, never in
 *    `customer_transactions` — every row there moves the debtor balance, and
 *    this is not a debt. A customer with R2 000 on lay-by owes nothing.
 *
 * 2. **The goods stay put, but are spoken for.** Stock is RESERVED, exactly
 *    as a sales order reserves it: a derived figure, no movement written, so
 *    `Σ qty_change = stock_on_hand` still holds. The reservation is not
 *    decorative — failing to deliver after full payment costs the shop DOUBLE
 *    what was paid, and a stock shortage is explicitly not an excuse.
 *
 * 3. **No sale until delivery.** A deposit sits outside VAT until it is
 *    applied or forfeited, so no invoice, no VAT and no stock movement until
 *    the final payment. Then an ordinary invoice is raised through the
 *    ORDINARY finalise path, so every existing guard runs unchanged.
 *
 * ── WHAT THAT MEANS FOR THE CASH-UP ──────────────────────────────────────
 *
 * Lay-by money physically arrives in the drawer, so payments carry a tender
 * type and a shift. The drawer must balance against everything that came in,
 * whether or not it was a sale — which is exactly why the cash-up counts
 * tenders rather than reading the sales total.
 */

type Row = Record<string, unknown>

export const LAYBY_STATUSES = ['open', 'completed', 'cancelled', 'expired'] as const
export type LaybyStatus = (typeof LAYBY_STATUSES)[number]

export const LAYBY_STATUS_LABELS: Record<LaybyStatus, string> = {
  open: 'Open',
  completed: 'Completed',
  cancelled: 'Cancelled',
  expired: 'Expired',
}

export type LaybyLine = {
  id: number
  productId: number | null
  productCode: string | null
  description: string
  productType: string
  departmentId: number | null
  qty: number
  unitPriceIncl: number
  discountPct: number
  vatRatePct: number
  lineTotalIncl: number
  lineTotalExcl: number
  lineVat: number
  unitCostExcl: number
}

export type LaybyPayment = {
  id: number
  kind: 'deposit' | 'instalment' | 'refund' | 'forfeit'
  amount: number
  tenderTypeId: number | null
  tenderName: string
  reference: string | null
  paidOn: string
  userName: string
  note: string | null
  createdAt: Date
}

export type Layby = {
  id: number
  laybyNumber: string | null
  customerId: number
  customerCode: string | null
  customerName: string | null
  status: LaybyStatus
  totalIncl: number
  paidTotal: number
  /** Derived: what is left before the goods may be handed over. */
  outstanding: number
  dueDate: string | null
  invoiceDocId: number | null
  invoiceNumber: string | null
  completedAt: Date | null
  cancelledAt: Date | null
  cancelReason: string | null
  cancellationFee: number
  feeWaivedReason: string | null
  userName: string
  note: string | null
  createdAt: Date
  lines: LaybyLine[]
  payments: LaybyPayment[]
}

const SELECT_LAYBY = `
  SELECT l.*, c.code AS customer_code, c.name AS customer_name,
         d.document_number AS invoice_number
    FROM laybys l
    JOIN customers c            ON c.id = l.customer_id
    LEFT JOIN sales_documents d ON d.id = l.invoice_doc_id
`

function mapLayby(r: Row, lines: LaybyLine[], payments: LaybyPayment[]): Layby {
  const totalIncl = toNum(r.total_incl)
  const paidTotal = toNum(r.paid_total)
  return {
    id: Number(r.id),
    laybyNumber: (r.document_number as string | null) ?? null,
    customerId: Number(r.customer_id),
    customerCode: (r.customer_code as string | null) ?? null,
    customerName: (r.customer_name as string | null) ?? null,
    status: r.status as LaybyStatus,
    totalIncl,
    paidTotal,
    outstanding: outstanding({ totalIncl, paidTotal }),
    dueDate: (r.due_date as string | null) ?? null,
    invoiceDocId: r.invoice_doc_id === null ? null : Number(r.invoice_doc_id),
    invoiceNumber: (r.invoice_number as string | null) ?? null,
    completedAt: (r.completed_at as Date | null) ?? null,
    cancelledAt: (r.cancelled_at as Date | null) ?? null,
    cancelReason: (r.cancel_reason as string | null) ?? null,
    cancellationFee: toNum(r.cancellation_fee),
    feeWaivedReason: (r.fee_waived_reason as string | null) ?? null,
    userName: String(r.user_name ?? ''),
    note: (r.note as string | null) ?? null,
    createdAt: r.created_at as Date,
    lines,
    payments,
  }
}

function mapLine(r: Row): LaybyLine {
  return {
    id: Number(r.id),
    productId: r.product_id === null ? null : Number(r.product_id),
    productCode: (r.product_code as string | null) ?? null,
    description: String(r.description),
    productType: String(r.product_type),
    departmentId: r.department_id === null ? null : Number(r.department_id),
    qty: toNum(r.qty),
    unitPriceIncl: toNum(r.unit_price_incl),
    discountPct: toNum(r.discount_pct),
    vatRatePct: toNum(r.vat_rate_pct),
    lineTotalIncl: toNum(r.line_total_incl),
    lineTotalExcl: toNum(r.line_total_excl),
    lineVat: toNum(r.line_vat),
    unitCostExcl: toNum(r.unit_cost_excl),
  }
}

function mapPayment(r: Row): LaybyPayment {
  return {
    id: Number(r.id),
    kind: r.kind as LaybyPayment['kind'],
    amount: toNum(r.amount),
    tenderTypeId: r.tender_type_id === null ? null : Number(r.tender_type_id),
    tenderName: String(r.tender_name ?? ''),
    reference: (r.reference as string | null) ?? null,
    paidOn: String(r.paid_on),
    userName: String(r.user_name ?? ''),
    note: (r.note as string | null) ?? null,
    createdAt: r.created_at as Date,
  }
}

export async function getLayby(siteId: number, id: number): Promise<Layby | null> {
  const [header, lines, payments] = await Promise.all([
    siteQueryOne<Row>(siteId, `${SELECT_LAYBY} WHERE l.id = ? LIMIT 1`, [id]),
    siteQuery<Row>(siteId, 'SELECT * FROM layby_lines WHERE layby_id = ? ORDER BY line_number, id', [id]),
    siteQuery<Row>(siteId, 'SELECT * FROM layby_payments WHERE layby_id = ? ORDER BY id', [id]),
  ])
  return header ? mapLayby(header, lines.map(mapLine), payments.map(mapPayment)) : null
}

export type LaybyListOptions = {
  status?: LaybyStatus | 'active'
  customerId?: number
  q?: string
  /** Only those past their due date and still open. */
  overdueOnly?: boolean
  limit?: number
  offset?: number
}

export async function listLaybys(
  siteId: number,
  options: LaybyListOptions = {},
): Promise<{ items: Layby[]; total: number }> {
  const where: string[] = []
  const params: unknown[] = []

  if (options.status === 'active') {
    where.push("l.status = 'open'")
  } else if (options.status) {
    where.push('l.status = ?')
    params.push(options.status)
  }
  if (options.customerId) {
    where.push('l.customer_id = ?')
    params.push(options.customerId)
  }
  if (options.overdueOnly) {
    where.push("l.status = 'open' AND l.due_date IS NOT NULL AND l.due_date < CURDATE()")
  }
  if (options.q?.trim()) {
    where.push('(l.document_number LIKE ? OR c.name LIKE ? OR c.code LIKE ?)')
    const like = `%${options.q.trim()}%`
    params.push(like, like, like)
  }

  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
  const offset = Math.max(options.offset ?? 0, 0)

  const [rows, countRow] = await Promise.all([
    siteQuery<Row>(
      siteId,
      `${SELECT_LAYBY} ${clause} ORDER BY l.status, l.due_date IS NULL, l.due_date, l.id DESC
        LIMIT ${limit} OFFSET ${offset}`,
      params,
    ),
    siteQueryOne<Row>(
      siteId,
      `SELECT COUNT(*) AS total FROM laybys l JOIN customers c ON c.id = l.customer_id ${clause}`,
      params,
    ),
  ])

  // Lines and payments are not loaded for a list — the header carries every
  // figure the list shows, and N queries per row is how a list screen dies.
  return {
    items: rows.map((r) => mapLayby(r, [], [])),
    total: Number(countRow?.total ?? 0),
  }
}

export type LaybyLineInput = {
  productId: number | null
  productCode?: string | null
  description: string
  productType?: string
  departmentId?: number | null
  qty: number
  unitPriceIncl: number
  discountPct?: number
  vatRatePct: number
  unitCostExcl?: number
}

export type CreateInput = {
  customerId: number
  lines: LaybyLineInput[]
  /** The first payment. The law does not require one, but every shop takes one. */
  deposit?: { amount: number; tenderTypeId: number; tenderName: string; reference?: string | null }
  dueDate?: string | null
  terminalId?: number | null
  note?: string | null
}

export type CreateResult =
  | { ok: true; laybyId: number; laybyNumber: string; totalIncl: number; outstanding: number }
  | { ok: false; error: string }

/**
 * Opens a lay-by.
 *
 * Issues a LAY number immediately, unlike a sale — the customer walks out with
 * a document referring to goods they cannot take, so it needs an identifier
 * from the first moment. No stock moves, no ledger entry, no VAT: the goods
 * are still the shop's and the money is still the customer's.
 */
export async function createLayby(
  siteId: number,
  actor: Actor,
  input: CreateInput,
): Promise<CreateResult> {
  if (input.lines.length === 0) return { ok: false, error: 'Add at least one item to put aside.' }

  const customer = await siteQueryOne<Row>(
    siteId,
    'SELECT id, name, status FROM customers WHERE id = ? LIMIT 1',
    [input.customerId],
  )
  if (!customer) return { ok: false, error: 'Choose a customer — a lay-by is held for someone.' }
  if (String(customer.status) === 'closed') {
    return { ok: false, error: `${customer.name}'s account is closed.` }
  }

  for (const line of input.lines) {
    if (!Number.isFinite(line.qty) || line.qty <= 0) {
      return { ok: false, error: `${line.description}: enter a quantity.` }
    }
    if (!Number.isFinite(line.unitPriceIncl) || line.unitPriceIncl < 0) {
      return { ok: false, error: `${line.description}: enter a price.` }
    }
  }

  const computed = input.lines.map((line) => ({
    ...lineTotals({
      qty: line.qty,
      unitPriceIncl: line.unitPriceIncl,
      discountPct: line.discountPct ?? 0,
      vatRatePct: line.vatRatePct,
    }),
    vatRatePct: line.vatRatePct,
  }))
  const totals = documentTotals(computed)

  if (totals.totalIncl <= 0) return { ok: false, error: 'A lay-by must be worth something.' }

  const deposit = input.deposit
  if (deposit && round(deposit.amount, 2) > round(totals.totalIncl, 2)) {
    return { ok: false, error: 'The deposit is more than the lay-by is worth.' }
  }

  const settings = await getSettings(siteId, ['layby_default_days'])
  const dueDate = input.dueDate ?? defaultDueDate(Number(settings.layby_default_days) || 90)

  const shiftId = await shiftToBankInto(siteId, input.terminalId ?? null, actor.userId ?? null)

  const created = await siteTransaction(siteId, async (tx) => {
    const laybyNumber = await nextDocumentNumber(tx, 'layby')

    const [res] = await tx.execute(
      `INSERT INTO laybys
         (document_number, customer_id, status, total_incl, paid_total, due_date,
          terminal_id, user_id, user_name, note)
       VALUES (?,?,'open',?,0,?,?,?,?,?)`,
      [
        laybyNumber,
        input.customerId,
        totals.totalIncl.toFixed(4),
        dueDate,
        input.terminalId ?? null,
        actor.userId,
        actor.userName.slice(0, 120),
        input.note?.trim()?.slice(0, 400) ?? null,
      ] as never,
    )
    const laybyId = (res as { insertId: number }).insertId

    for (const [index, line] of input.lines.entries()) {
      const c = computed[index]
      await tx.execute(
        `INSERT INTO layby_lines
           (layby_id, line_number, product_id, product_code, description, product_type,
            department_id, qty, unit_price_incl, discount_pct, discount_incl, vat_rate_pct,
            line_total_incl, line_total_excl, line_vat, unit_cost_excl)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          laybyId,
          index + 1,
          line.productId,
          line.productCode ?? null,
          line.description.slice(0, 190),
          line.productType ?? 'normal',
          line.departmentId ?? null,
          round(line.qty, 3).toFixed(3),
          round(line.unitPriceIncl, 4).toFixed(4),
          round(line.discountPct ?? 0, 3).toFixed(3),
          c.discountIncl.toFixed(4),
          round(line.vatRatePct, 3).toFixed(3),
          c.lineTotalIncl.toFixed(4),
          c.lineTotalExcl.toFixed(4),
          c.lineVat.toFixed(4),
          round(line.unitCostExcl ?? 0, 4).toFixed(4),
        ] as never,
      )
    }

    if (deposit && deposit.amount > 0) {
      await tx.execute(
        `INSERT INTO layby_payments
           (layby_id, kind, amount, tender_type_id, tender_name, reference, paid_on,
            terminal_id, shift_id, user_id, user_name)
         VALUES (?, 'deposit', ?, ?, ?, ?, CURDATE(), ?, ?, ?, ?)`,
        [
          laybyId,
          round(deposit.amount, 2).toFixed(4),
          deposit.tenderTypeId,
          deposit.tenderName.slice(0, 60),
          deposit.reference?.slice(0, 120) ?? null,
          input.terminalId ?? null,
          shiftId,
          actor.userId,
          actor.userName.slice(0, 120),
        ] as never,
      )
      await tx.execute('UPDATE laybys SET paid_total = ? WHERE id = ?', [
        round(deposit.amount, 2).toFixed(4),
        laybyId,
      ] as never)
    }

    return { laybyId, laybyNumber }
  })

  return {
    ok: true,
    laybyId: created.laybyId,
    laybyNumber: created.laybyNumber,
    totalIncl: totals.totalIncl,
    outstanding: round(totals.totalIncl - (deposit?.amount ?? 0), 2),
  }
}

export type PaymentResult =
  | { ok: true; paidTotal: number; outstanding: number; settled: boolean }
  | { ok: false; error: string }

/**
 * Takes an instalment.
 *
 * Still not a sale. The money goes into `layby_payments` and the drawer, and
 * nothing else moves — no ledger entry, no VAT, no stock. When the last
 * instalment brings the balance to zero the caller should complete the lay-by,
 * which is the moment all three of those finally happen.
 */
export async function takePayment(
  siteId: number,
  actor: Actor,
  laybyId: number,
  input: {
    amount: number
    tenderTypeId: number
    tenderName: string
    reference?: string | null
    terminalId?: number | null
    note?: string | null
  },
): Promise<PaymentResult> {
  const layby = await getLayby(siteId, laybyId)
  if (!layby) return { ok: false, error: 'That lay-by no longer exists.' }

  const refusal = paymentRefusal(layby, input.amount)
  if (refusal) return { ok: false, error: refusal }

  const shiftId = await shiftToBankInto(siteId, input.terminalId ?? null, actor.userId ?? null)
  const amount = round(input.amount, 2)

  await siteTransaction(siteId, async (tx) => {
    await tx.execute(
      `INSERT INTO layby_payments
         (layby_id, kind, amount, tender_type_id, tender_name, reference, paid_on,
          terminal_id, shift_id, user_id, user_name, note)
       VALUES (?, 'instalment', ?, ?, ?, ?, CURDATE(), ?, ?, ?, ?, ?)`,
      [
        laybyId,
        amount.toFixed(4),
        input.tenderTypeId,
        input.tenderName.slice(0, 60),
        input.reference?.slice(0, 120) ?? null,
        input.terminalId ?? null,
        shiftId,
        actor.userId,
        actor.userName.slice(0, 120),
        input.note?.slice(0, 190) ?? null,
      ] as never,
    )
    // Recomputed from the payments rather than incremented, so the stored
    // figure can never drift from the rows it summarises.
    await tx.execute(
      `UPDATE laybys SET paid_total = (
         SELECT COALESCE(SUM(amount), 0) FROM layby_payments WHERE layby_id = ?
       ) WHERE id = ?`,
      [laybyId, laybyId] as never,
    )
  })

  const after = await getLayby(siteId, laybyId)
  return {
    ok: true,
    paidTotal: after?.paidTotal ?? 0,
    outstanding: after?.outstanding ?? 0,
    settled: after ? isSettled(after) : false,
  }
}

export type CompleteResult =
  | { ok: true; documentId: number; documentNumber: string }
  | { ok: false; error: string }

/**
 * Hands the goods over: the moment a lay-by becomes a sale.
 *
 * NOW the invoice is raised, the VAT is declared and the stock moves — all
 * three at once, through the ORDINARY finalise path so every guard that
 * protects a normal sale runs unchanged. That is the whole reason lay-by does
 * not get its own posting engine.
 *
 * The tender is the money already collected. It is not arriving now; it has
 * been in the drawer all along, and the cash-ups that counted it were right.
 * The invoice records it as paid so the customer's account is not left owing
 * for goods they have paid for in full.
 *
 * ── AND THAT IS WHY THE TENDER MUST NOT BE DRAWER CASH ────────────────────
 *
 * Settling with CASH would write a cash tender for the whole lay-by value on
 * the day the goods go out, and `expectedCash` counts cash tenders. The
 * instalments are already counted — they are real money that went into the
 * drawer weeks ago, and the cash-up now sees them. Recording the settlement as
 * cash too would count every rand of that lay-by a second time and leave the
 * drawer reading over by the whole amount.
 *
 * `DEPOSIT` — "Deposit paid", `counts_as_drawer_cash = 0` — is the tender that
 * says "this was settled by money already taken". So the caller's choice is
 * validated rather than trusted: the back office offers a picker defaulted to
 * the first active tender, which is Cash, and nothing stopped somebody
 * confirming it.
 */
export async function completeLayby(
  siteId: number,
  actor: Actor,
  laybyId: number,
  tenderTypeId: number,
): Promise<CompleteResult> {
  const layby = await getLayby(siteId, laybyId)
  if (!layby) return { ok: false, error: 'That lay-by no longer exists.' }
  if (layby.status === 'completed') return { ok: false, error: 'This lay-by is already completed.' }
  if (layby.status !== 'open') return { ok: false, error: `A ${layby.status} lay-by cannot be completed.` }

  /* Refused here, at the boundary, rather than by hiding the option on one
     screen: the till reaches this too, and a rule about money belongs where
     every caller passes through. */
  const settlement = await siteQueryOne<Row>(
    siteId,
    'SELECT counts_as_drawer_cash FROM tender_types WHERE id = ? LIMIT 1',
    [tenderTypeId],
  )
  if (!settlement) return { ok: false, error: 'That payment method no longer exists.' }
  if (settlement.counts_as_drawer_cash) {
    return {
      ok: false,
      error:
        'Settle a lay-by with a method that does not add to the drawer — the instalments are already counted. Use "Deposit paid".',
    }
  }
  if (!isSettled(layby)) {
    return {
      ok: false,
      error: `${layby.outstanding.toFixed(2)} is still outstanding. Take the balance before handing the goods over.`,
    }
  }

  const draft = await saveDraft(siteId, actor, {
    docType: 'invoice',
    customerId: layby.customerId,
    customerName: layby.customerName,
    reference: layby.laybyNumber,
    notes: `Lay-by ${layby.laybyNumber} paid in full`,
    lines: layby.lines.map((line) => ({
      productId: line.productId,
      productCode: line.productCode,
      description: line.description,
      productType: line.productType as never,
      departmentId: line.departmentId,
      qty: line.qty,
      unitPriceIncl: line.unitPriceIncl,
      discountPct: line.discountPct,
      vatRatePct: line.vatRatePct,
      unitCostExcl: line.unitCostExcl,
    })),
  })
  if (!draft.ok) return { ok: false, error: draft.error }

  const posted = await finaliseDocument(siteId, actor, {
    documentId: draft.id,
    customerId: layby.customerId,
    tenders: [{ tenderTypeId, amount: layby.totalIncl, reference: layby.laybyNumber }],
  })
  if (!posted.ok) return { ok: false, error: posted.error }

  await siteExecute(
    siteId,
    `UPDATE laybys SET status = 'completed', invoice_doc_id = ?, completed_at = NOW()
      WHERE id = ?`,
    [posted.documentId, laybyId],
  )

  return { ok: true, documentId: posted.documentId, documentNumber: posted.documentNumber }
}

export type CancelResult =
  | { ok: true; fee: number; refund: number; noFeeReason: string | null }
  | { ok: false; error: string }

/**
 * Ends a lay-by early.
 *
 * The default is a FULL refund — the money was never the shop's. A fee is the
 * exception and every condition in `cancellationOutcome` must hold before a
 * cent is kept: disclosed, past due, sixty business days elapsed, no
 * statutory waiver.
 *
 * A forfeited fee IS consideration for VAT purposes, so it is recorded as its
 * own payment row rather than quietly netted off the refund. That leaves a
 * figure an accountant can find and declare.
 */
export async function cancelLayby(
  siteId: number,
  actor: Actor,
  laybyId: number,
  input: {
    reason: string
    waiverReason?: FeeWaiverReason | null
    tenderTypeId?: number | null
    tenderName?: string | null
    terminalId?: number | null
  },
): Promise<CancelResult> {
  if (!input.reason?.trim()) return { ok: false, error: 'Give a reason for the cancellation.' }

  const layby = await getLayby(siteId, laybyId)
  if (!layby) return { ok: false, error: 'That lay-by no longer exists.' }
  if (layby.status === 'completed') {
    return { ok: false, error: 'This lay-by was completed — credit the invoice instead.' }
  }
  if (layby.status !== 'open') return { ok: false, error: `This lay-by is already ${layby.status}.` }

  const settings = await getSettings(siteId, [
    'layby_cancellation_fee_pct',
    'layby_max_fee_pct',
    'layby_terms_text',
  ])
  // Clamped at the point of use as well as on save: a value that reached the
  // database another way must not charge a customer more than the store's own
  // policy allows.
  const configured = clampFeePct(
    Number(settings.layby_cancellation_fee_pct) || 0,
    Number(settings.layby_max_fee_pct) || 0,
  ).pct

  // A fee that was never written into the terms was never disclosed, and an
  // undisclosed fee is not chargeable. Enforced rather than trusted, because
  // the store that forgets to write terms is exactly the one that will charge
  // the fee anyway.
  const disclosed = (settings.layby_terms_text ?? '').trim().length > 0
  const waiver = input.waiverReason ?? (configured > 0 && !disclosed ? 'not_disclosed' : null)

  const outcome = cancellationOutcome({
    totalIncl: layby.totalIncl,
    paidTotal: layby.paidTotal,
    dueDate: layby.dueDate,
    asAt: todayIso(),
    feePct: configured,
    waiverReason: waiver,
  })

  const shiftId = await shiftToBankInto(siteId, input.terminalId ?? null, actor.userId ?? null)

  await siteTransaction(siteId, async (tx) => {
    if (outcome.refund > 0) {
      await tx.execute(
        `INSERT INTO layby_payments
           (layby_id, kind, amount, tender_type_id, tender_name, paid_on,
            terminal_id, shift_id, user_id, user_name, note)
         VALUES (?, 'refund', ?, ?, ?, CURDATE(), ?, ?, ?, ?, ?)`,
        [
          laybyId,
          round(-outcome.refund, 2).toFixed(4),
          input.tenderTypeId ?? null,
          (input.tenderName ?? 'Refund').slice(0, 60),
          input.terminalId ?? null,
          shiftId,
          actor.userId,
          actor.userName.slice(0, 120),
          'Refunded on cancellation',
        ] as never,
      )
    }

    if (outcome.fee > 0) {
      await tx.execute(
        `INSERT INTO layby_payments
           (layby_id, kind, amount, tender_name, paid_on, user_id, user_name, note)
         VALUES (?, 'forfeit', ?, 'Cancellation fee', CURDATE(), ?, ?, ?)`,
        [
          laybyId,
          round(-outcome.fee, 2).toFixed(4),
          actor.userId,
          actor.userName.slice(0, 120),
          `${outcome.appliedPct}% of ${layby.totalIncl.toFixed(2)} — kept on cancellation`,
        ] as never,
      )
    }

    await tx.execute(
      `UPDATE laybys
          SET status = 'cancelled', cancelled_at = NOW(), cancel_reason = ?,
              cancellation_fee = ?, cancellation_fee_pct = ?, fee_waived_reason = ?,
              paid_total = (SELECT COALESCE(SUM(amount), 0) FROM layby_payments WHERE layby_id = ?)
        WHERE id = ?`,
      [
        input.reason.trim().slice(0, 190),
        outcome.fee.toFixed(4),
        outcome.appliedPct.toFixed(3),
        outcome.noFeeReason?.slice(0, 190) ?? null,
        laybyId,
        laybyId,
      ] as never,
    )
  })

  return { ok: true, fee: outcome.fee, refund: outcome.refund, noFeeReason: outcome.noFeeReason }
}

export type LaybyDrift = {
  laybyId: number
  laybyNumber: string | null
  stored: number
  computed: number
  drift: number
}

/**
 * Proves `paid_total` equals the payments behind it.
 *
 * The same promise `reconcileStock` and `reconcileBalances` make. Any row is a
 * bug in a posting path, not rounding — both sides are DECIMAL.
 */
export async function reconcileLaybys(siteId: number): Promise<LaybyDrift[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT l.id, l.document_number, l.paid_total,
            COALESCE((SELECT SUM(p.amount) FROM layby_payments p WHERE p.layby_id = l.id), 0) AS computed
       FROM laybys l
      HAVING ABS(l.paid_total - computed) > 0.005`,
  )
  return rows.map((r) => ({
    laybyId: Number(r.id),
    laybyNumber: (r.document_number as string | null) ?? null,
    stored: toNum(r.paid_total),
    computed: toNum(r.computed),
    drift: round(toNum(r.paid_total) - toNum(r.computed), 2),
  }))
}

/**
 * Sweeps lay-bys nobody came back for.
 *
 * Marks them expired rather than cancelling them: expiry is the shop noticing,
 * not the customer asking, and the exception report should be able to tell the
 * two apart. No money moves — the customer's money is still theirs, and
 * cancelling properly (with its refund) remains a deliberate act.
 */
export async function expireStaleLaybys(
  siteId: number,
  graceDays = 30,
): Promise<{ id: number; laybyNumber: string | null; customerName: string | null }[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT l.id, l.document_number, c.name AS customer_name
       FROM laybys l JOIN customers c ON c.id = l.customer_id
      WHERE l.status = 'open'
        AND l.due_date IS NOT NULL
        AND l.due_date < DATE_SUB(CURDATE(), INTERVAL ? DAY)`,
    [Math.max(graceDays, 0)],
  )

  for (const row of rows) {
    await siteExecute(siteId, "UPDATE laybys SET status = 'expired' WHERE id = ?", [Number(row.id)])
  }

  return rows.map((r) => ({
    id: Number(r.id),
    laybyNumber: (r.document_number as string | null) ?? null,
    customerName: (r.customer_name as string | null) ?? null,
  }))
}

/**
 * Texts everyone whose lay-by is coming due (or already overdue) — the nudge
 * that keeps expireStaleLaybys from ever needing to run.
 *
 * `reminded_at` is the throttle: a lay-by nudged in the last seven days is
 * left alone, so pressing the button daily cannot nag anybody daily. The
 * stamp is written even when the send fails? No — ONLY on success, because
 * an unsent reminder did not remind anyone, and stamping it would silently
 * swallow a dead number until the lay-by expires.
 *
 * Human-triggered from the lay-bys screen, like the expiry sweep beside it.
 */
export async function remindDueLaybys(
  siteId: number,
  actor: Actor,
  deps: { sendSms: (to: string, body: string) => Promise<{ ok: boolean; error?: string }> },
): Promise<{ sent: number; skipped: { laybyNumber: string | null; reason: string }[] }> {
  const settings = await getSettings(siteId, ['layby_reminder_days', 'layby_reminder_sms'])
  const horizon = Math.max(Number(settings.layby_reminder_days) || 7, 0)
  const template = settings.layby_reminder_sms

  const { normaliseSaPhone } = await import('../sms/phone')
  const { renderTemplate } = await import('../creditModel')
  const companyName = await getCompanyName(siteId)

  const rows = await siteQuery<Row>(
    siteId,
    `SELECT l.id, l.document_number, l.due_date, l.total_incl, l.paid_total,
            c.name AS customer_name, c.phone
       FROM laybys l JOIN customers c ON c.id = l.customer_id
      WHERE l.status = 'open'
        AND l.due_date IS NOT NULL
        AND l.due_date <= DATE_ADD(CURDATE(), INTERVAL ? DAY)
        AND (l.reminded_at IS NULL OR l.reminded_at < DATE_SUB(NOW(), INTERVAL 7 DAY))`,
    [horizon],
  )

  let sent = 0
  const skipped: { laybyNumber: string | null; reason: string }[] = []

  for (const r of rows) {
    const number = (r.document_number as string | null) ?? null
    const phone = normaliseSaPhone((r.phone as string | null) ?? null)
    if (!phone) {
      skipped.push({ laybyNumber: number, reason: 'No usable mobile number.' })
      continue
    }

    const balance = round(toNum(r.total_incl) - toNum(r.paid_total), 2)
    const body = renderTemplate(template, {
      customer: String(r.customer_name ?? ''),
      number: number ?? `#${r.id}`,
      due_date: String(r.due_date).slice(0, 10),
      balance: balance.toFixed(2),
      company: companyName,
    })

    const outcome = await deps.sendSms(phone, body)
    if (outcome.ok) {
      sent++
      await siteExecute(siteId, 'UPDATE laybys SET reminded_at = NOW() WHERE id = ?', [Number(r.id)])
      await logActivity(siteId, actor, {
        entity: 'customer',
        entityId: null,
        action: 'layby_reminded',
        detail: `${number ?? `#${r.id}`} — reminder texted, ${balance.toFixed(2)} outstanding`,
      }).catch(() => undefined)
    } else {
      skipped.push({ laybyNumber: number, reason: outcome.error ?? 'The message was refused.' })
    }
  }

  return { sent, skipped }
}

/** The trading name the reminder signs off as, from the control database. */
async function getCompanyName(siteId: number): Promise<string> {
  const { queryOne } = await import('../db')
  const row = await queryOne<{ company_name: string; trading_name: string | null }>(
    'SELECT company_name, trading_name FROM cp2_sites WHERE id = ? LIMIT 1',
    [siteId],
  ).catch(() => null)
  return row?.trading_name?.trim() || row?.company_name || 'the shop'
}

/** The store's fee percentage, clamped to the store's own ceiling. */
export async function cancellationFeePct(siteId: number): Promise<{ pct: number; clamped: boolean }> {
  const settings = await getSettings(siteId, ['layby_cancellation_fee_pct', 'layby_max_fee_pct'])
  return clampFeePct(
    Number(settings.layby_cancellation_fee_pct) || 0,
    Number(settings.layby_max_fee_pct) || 0,
  )
}

function defaultDueDate(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
