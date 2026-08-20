import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { customerExecute, customerQuery, customerQueryOne, customerTransaction } from './customerDb'
import { round, toNum } from '../decimals'
import { logActivity, logActivityTx, type Actor } from './activityLog'
import { postTransaction } from './customerLedger'
import { today } from './ledger'
import {
  calculateInterest,
  effectiveTerms,
  type InterestCalculation,
  type OverdueItem,
} from './interestRules'

/**
 * Charging interest on overdue accounts.
 *
 * Shaped like a payment run — propose, review, post — and for a stronger
 * reason. Interest is the charge most likely to be disputed, least likely to be
 * noticed before it goes out, and the one with a statute behind it. So a run
 * sits as a DRAFT showing exactly what each account will be charged and on
 * what, and posts only when someone says so.
 *
 * The workings are stored per item: base, rate and days. "Why am I being
 * charged R47.32" is the first question every interest charge produces, and
 * "the system calculated it" is not an answer that keeps a customer.
 *
 * See interestRules.ts for the arithmetic and the note on the National Credit
 * Act — in particular the in duplum cap, which is applied on every run.
 */

export type InterestRunStatus = 'draft' | 'posted' | 'cancelled'

export type InterestRun = {
  id: number
  asAtDate: string
  periodFrom: string
  periodTo: string
  status: InterestRunStatus
  totalAmount: number
  accountCount: number
  postedCount: number
  minimumCharge: number
  notes: string | null
  userName: string
  postedAt: Date | null
  createdAt: Date
}

export type InterestRunItem = {
  id: number
  runId: number
  customerId: number
  customerCode: string
  customerName: string
  baseAmount: number
  ratePct: number
  days: number
  amount: number
  status: 'pending' | 'posted' | 'skipped'
  skipReason: string | null
  transactionId: number | null
}

type Row = RowDataPacket & Record<string, unknown>

function mapRun(r: Row): InterestRun {
  return {
    id: Number(r.id),
    asAtDate: String(r.as_at_date),
    periodFrom: String(r.period_from),
    periodTo: String(r.period_to),
    status: String(r.status) as InterestRunStatus,
    totalAmount: toNum(r.total_amount),
    accountCount: Number(r.account_count),
    postedCount: Number(r.posted_count),
    minimumCharge: toNum(r.minimum_charge),
    notes: (r.notes as string | null) ?? null,
    userName: String(r.user_name ?? ''),
    postedAt: (r.posted_at as Date | null) ?? null,
    createdAt: r.created_at as Date,
  }
}

function mapItem(r: Row): InterestRunItem {
  return {
    id: Number(r.id),
    runId: Number(r.run_id),
    customerId: Number(r.customer_id),
    customerCode: String(r.customer_code),
    customerName: String(r.customer_name),
    baseAmount: toNum(r.base_amount),
    ratePct: toNum(r.rate_pct),
    days: Number(r.days),
    amount: toNum(r.amount),
    status: String(r.status) as InterestRunItem['status'],
    skipReason: (r.skip_reason as string | null) ?? null,
    transactionId: r.transaction_id === null ? null : Number(r.transaction_id),
  }
}

export async function getRun(siteId: number, id: number): Promise<InterestRun | null> {
  const row = await customerQueryOne<Row>(siteId, 'SELECT * FROM interest_runs WHERE id = ? LIMIT 1', [
    id,
  ])
  return row ? mapRun(row) : null
}

export async function listRuns(siteId: number, limit = 20): Promise<InterestRun[]> {
  const capped = Math.min(Math.max(limit, 1), 100)
  const rows = await customerQuery<Row>(
    siteId,
    `SELECT * FROM interest_runs ORDER BY created_at DESC LIMIT ${capped}`,
  )
  return rows.map(mapRun)
}

export async function listItems(
  siteId: number,
  runId: number,
  opts: { includeSkipped?: boolean } = {},
): Promise<InterestRunItem[]> {
  const rows = await customerQuery<Row>(
    siteId,
    `SELECT * FROM interest_run_items
      WHERE run_id = ? ${opts.includeSkipped === false ? "AND status <> 'skipped'" : ''}
      ORDER BY amount DESC, customer_name`,
    [runId],
  )
  return rows.map(mapItem)
}

/* ── Proposing ───────────────────────────────────────────────────────────── */

export type ProposeInput = {
  /** Interest is charged on balances overdue as at this date. */
  asAtDate?: string
  periodFrom: string
  periodTo: string
  /** Below this, the charge is skipped as not worth the argument. */
  minimumCharge?: number
  /** Limit to specific accounts. Empty means every eligible account. */
  customerIds?: number[]
  notes?: string | null
}

export type ProposeResult =
  | { ok: true; runId: number; charged: number; skipped: number; total: number }
  | { ok: false; error: string }

/**
 * Works out what everyone would be charged and saves it as a draft.
 *
 * Posts NOTHING. Every eligible account gets a row — including the ones that
 * will not be charged, with the reason — because "why did Harbour Cafe not get
 * interest" is a question the run should answer, exactly as createRun() in
 * statementRuns.ts queues its skips rather than dropping them.
 *
 * Accounts are eligible when interest is enabled on them or their group. That
 * is checked in SQL rather than by loading every customer, so a book of 5000
 * accounts with three on interest reads three rows.
 */
export async function proposeRun(
  siteId: number,
  actor: Actor,
  input: ProposeInput,
): Promise<ProposeResult> {
  const asAt = input.asAtDate ?? today()

  for (const [label, value] of [
    ['as-at date', asAt],
    ['period start', input.periodFrom],
    ['period end', input.periodTo],
  ] as const) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return { ok: false, error: `Choose a valid ${label}.` }
  }
  if (input.periodFrom > input.periodTo) {
    return { ok: false, error: 'The period starts after it ends.' }
  }

  const ids = [...new Set(input.customerIds ?? [])].filter((id) => Number.isFinite(id) && id > 0)
  const scoped = ids.length > 0

  // Eligible accounts, with their terms resolved against the group's defaults.
  const customers = await customerQuery<Row>(
    siteId,
    `SELECT c.id, c.code, c.name, c.balance,
            c.interest_rate_pct, c.interest_enabled, c.interest_grace_days,
            g.default_interest_rate_pct, g.default_interest_enabled, g.default_interest_grace_days
       FROM customers c
       LEFT JOIN customer_groups g ON g.id = c.group_id
      WHERE c.status IN ('active','on_hold')
        AND (c.interest_enabled = TRUE OR g.default_interest_enabled = TRUE)
        ${scoped ? `AND c.id IN (${ids.map(() => '?').join(',')})` : ''}
      ORDER BY c.name`,
    scoped ? ids : [],
  )

  if (customers.length === 0) {
    return {
      ok: false,
      error: 'No accounts have interest enabled. Switch it on for an account or a group first.',
    }
  }

  // Overdue open items for exactly those accounts, in one query.
  const customerIds = customers.map((c) => Number(c.id))
  const openItems = await customerQuery<Row>(
    siteId,
    `SELECT customer_id, id, amount_outstanding, doc_type,
            DATEDIFF(?, due_date) AS days_overdue
       FROM customer_transactions
      WHERE customer_id IN (${customerIds.map(() => '?').join(',')})
        AND amount_outstanding > 0
        AND due_date IS NOT NULL
        AND due_date < ?`,
    [asAt, ...customerIds, asAt],
  )

  const itemsByCustomer = new Map<number, OverdueItem[]>()
  // Interest already charged and still unpaid, for the in duplum ceiling.
  const interestByCustomer = new Map<number, number>()

  for (const row of openItems) {
    const customerId = Number(row.customer_id)
    const list = itemsByCustomer.get(customerId) ?? []
    const outstanding = toNum(row.amount_outstanding)

    // Interest does not itself attract interest — that would be compounding,
    // which requires an agreement this system cannot verify. It counts toward
    // the in duplum cap instead.
    if (String(row.doc_type) === 'interest') {
      interestByCustomer.set(customerId, round((interestByCustomer.get(customerId) ?? 0) + outstanding, 2))
      continue
    }

    list.push({
      id: Number(row.id),
      outstanding,
      daysOverdue: Number(row.days_overdue ?? 0),
    })
    itemsByCustomer.set(customerId, list)
  }

  const minimum = round(input.minimumCharge ?? 0, 2)

  const planned = customers.map((c) => {
    const terms = effectiveTerms(
      {
        ratePct: toNum(c.interest_rate_pct),
        enabled: Boolean(c.interest_enabled),
        graceDays: Number(c.interest_grace_days ?? 0),
      },
      c.default_interest_rate_pct === null && c.default_interest_enabled === null
        ? null
        : {
            ratePct: toNum(c.default_interest_rate_pct),
            enabled: Boolean(c.default_interest_enabled),
            graceDays: Number(c.default_interest_grace_days ?? 0),
          },
    )

    const calculation = calculateInterest(itemsByCustomer.get(Number(c.id)) ?? [], terms, {
      minimumCharge: minimum,
      interestAlreadyCharged: interestByCustomer.get(Number(c.id)) ?? 0,
    })

    return { customer: c, calculation }
  })

  const total = planned.reduce((sum, p) => round(sum + p.calculation.amount, 2), 0)
  const charged = planned.filter((p) => p.calculation.amount > 0).length

  const runId = await customerTransaction(siteId, async (tx) => {
    const [res] = await tx.execute(
      `INSERT INTO interest_runs
         (as_at_date, period_from, period_to, total_amount, account_count,
          minimum_charge, notes, user_id, user_name)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        asAt,
        input.periodFrom,
        input.periodTo,
        total.toFixed(4),
        charged,
        minimum.toFixed(4),
        input.notes?.trim() || null,
        actor.userId,
        actor.userName.slice(0, 120),
      ] as never,
    )
    const id = (res as { insertId: number }).insertId

    for (const { customer, calculation } of planned) {
      await tx.execute(
        `INSERT INTO interest_run_items
           (run_id, customer_id, customer_code, customer_name,
            base_amount, rate_pct, days, amount, status, skip_reason)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [
          id,
          Number(customer.id),
          String(customer.code),
          String(customer.name),
          calculation.base.toFixed(4),
          calculation.ratePct.toFixed(4),
          calculation.days,
          calculation.amount.toFixed(4),
          calculation.amount > 0 ? 'pending' : 'skipped',
          calculation.skipReason,
        ] as never,
      )
    }

    return id
  })

  return { ok: true, runId, charged, skipped: planned.length - charged, total }
}

/* ── Posting ─────────────────────────────────────────────────────────────── */

export type PostRunResult =
  | { ok: true; posted: number; total: number }
  | { ok: false; error: string }

/**
 * Charges the interest.
 *
 * One transaction per account, posted through the sub-ledger's own function so
 * the balance invariant and the audit trail behave exactly as they do
 * everywhere else. Each is posted independently rather than inside one wrapping
 * transaction: an account that fails must not roll back charges already made to
 * others, mirroring postPaymentRun().
 *
 * The description carries the workings, because the customer's statement is
 * where this charge will be read and it must explain itself there.
 */
export async function postRun(
  siteId: number,
  actor: Actor,
  runId: number,
): Promise<PostRunResult> {
  const run = await getRun(siteId, runId)
  if (!run) return { ok: false, error: 'That run no longer exists.' }
  if (run.status === 'posted') return { ok: false, error: 'That run has already been charged.' }
  if (run.status === 'cancelled') return { ok: false, error: 'That run was cancelled.' }

  const items = (await listItems(siteId, runId)).filter((i) => i.status === 'pending')
  if (items.length === 0) return { ok: false, error: 'There is nothing to charge on this run.' }

  let posted = 0
  let total = 0

  for (const item of items) {
    const result = await postTransaction(siteId, actor, {
      customerId: item.customerId,
      docType: 'interest',
      amount: item.amount,
      docDate: run.asAtDate,
      description: `Interest at ${item.ratePct.toFixed(2)}% on ${item.baseAmount.toFixed(2)} for ${item.days} day${item.days === 1 ? '' : 's'}`,
      source: 'interest_run',
      sourceDocId: runId,
    })

    if (!result.ok) {
      await customerExecute(
        siteId,
        "UPDATE interest_run_items SET status = 'skipped', skip_reason = ? WHERE id = ?",
        [result.error.slice(0, 190), item.id],
      )
      continue
    }

    await customerExecute(
      siteId,
      "UPDATE interest_run_items SET status = 'posted', transaction_id = ? WHERE id = ?",
      [result.id, item.id],
    )

    // Debit debtors, credit interest received. Cannot fail the charge.
    const { mirrorInterest } = await import('./glPosting')
    await mirrorInterest(siteId, actor, {
      transactionId: result.id,
      date: run.asAtDate,
      customerId: item.customerId,
      amount: item.amount,
    })

    posted++
    total = round(total + item.amount, 2)
  }

  await customerExecute(
    siteId,
    "UPDATE interest_runs SET status = 'posted', posted_at = NOW(), posted_count = ?, total_amount = ? WHERE id = ?",
    [posted, total.toFixed(4), runId],
  )

  await logActivity(siteId, actor, {
    entity: 'customer',
    entityId: null,
    action: 'interest_run',
    detail: `Charged interest to ${posted} account${posted === 1 ? '' : 's'}, ${total.toFixed(2)} total`,
  })

  return { ok: true, posted, total }
}

export async function cancelRun(
  siteId: number,
  actor: Actor,
  runId: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const run = await getRun(siteId, runId)
  if (!run) return { ok: false, error: 'That run no longer exists.' }
  if (run.status === 'posted') {
    return {
      ok: false,
      error: 'That run has been charged. Reverse the individual interest charges instead.',
    }
  }

  await customerExecute(siteId, "UPDATE interest_runs SET status = 'cancelled' WHERE id = ?", [runId])
  await logActivity(siteId, actor, {
    entity: 'customer',
    entityId: null,
    action: 'interest_run_cancelled',
    detail: `Cancelled a draft interest run of ${run.totalAmount.toFixed(2)}`,
  })
  return { ok: true }
}

/**
 * Removes an account from a draft run.
 *
 * The commonest review action by far: an account is in dispute, or a payment
 * arrived after the as-at date and the charge is no longer fair. Marking it
 * skipped keeps it visible with its reason rather than making it vanish.
 */
export async function excludeItem(
  siteId: number,
  actor: Actor,
  itemId: number,
  reason: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const item = await customerQueryOne<Row>(
    siteId,
    `SELECT i.*, r.status AS run_status FROM interest_run_items i
       JOIN interest_runs r ON r.id = i.run_id WHERE i.id = ? LIMIT 1`,
    [itemId],
  )
  if (!item) return { ok: false, error: 'That line no longer exists.' }
  if (String(item.run_status) !== 'draft') {
    return { ok: false, error: 'That run is no longer a draft.' }
  }

  await customerTransaction(siteId, async (tx) => {
    await tx.execute(
      "UPDATE interest_run_items SET status = 'skipped', skip_reason = ? WHERE id = ?",
      [reason.trim().slice(0, 190) || 'Excluded during review', itemId] as never,
    )
    await tx.execute(
      `UPDATE interest_runs r
          SET r.total_amount = (SELECT COALESCE(SUM(amount), 0) FROM interest_run_items
                                 WHERE run_id = r.id AND status = 'pending'),
              r.account_count = (SELECT COUNT(*) FROM interest_run_items
                                  WHERE run_id = r.id AND status = 'pending')
        WHERE r.id = ?`,
      [Number(item.run_id)] as never,
    )
    await logActivityTx(tx, actor, {
      entity: 'customer',
      entityId: Number(item.customer_id),
      action: 'interest_excluded',
      detail: `Excluded from interest run — ${reason.trim() || 'no reason given'}`,
    })
  })

  return { ok: true }
}

/**
 * What one account would be charged, without creating a run.
 *
 * For the account's own screen: "if I ran interest today, this customer would
 * be charged R47.32, on this base, for these days." Shows the workings so the
 * figure can be explained before anyone commits to charging it.
 */
export async function previewForCustomer(
  siteId: number,
  customerId: number,
  asAtDate?: string,
): Promise<InterestCalculation | null> {
  const asAt = asAtDate ?? today()

  const customer = await customerQueryOne<Row>(
    siteId,
    `SELECT c.id, c.interest_rate_pct, c.interest_enabled, c.interest_grace_days,
            g.default_interest_rate_pct, g.default_interest_enabled, g.default_interest_grace_days
       FROM customers c
       LEFT JOIN customer_groups g ON g.id = c.group_id
      WHERE c.id = ? LIMIT 1`,
    [customerId],
  )
  if (!customer) return null

  const rows = await customerQuery<Row>(
    siteId,
    `SELECT id, amount_outstanding, doc_type, DATEDIFF(?, due_date) AS days_overdue
       FROM customer_transactions
      WHERE customer_id = ? AND amount_outstanding > 0 AND due_date IS NOT NULL AND due_date < ?`,
    [asAt, customerId, asAt],
  )

  const items: OverdueItem[] = []
  let alreadyCharged = 0
  for (const row of rows) {
    const outstanding = toNum(row.amount_outstanding)
    if (String(row.doc_type) === 'interest') {
      alreadyCharged = round(alreadyCharged + outstanding, 2)
      continue
    }
    items.push({
      id: Number(row.id),
      outstanding,
      daysOverdue: Number(row.days_overdue ?? 0),
    })
  }

  const terms = effectiveTerms(
    {
      ratePct: toNum(customer.interest_rate_pct),
      enabled: Boolean(customer.interest_enabled),
      graceDays: Number(customer.interest_grace_days ?? 0),
    },
    customer.default_interest_rate_pct === null
      ? null
      : {
          ratePct: toNum(customer.default_interest_rate_pct),
          enabled: Boolean(customer.default_interest_enabled),
          graceDays: Number(customer.default_interest_grace_days ?? 0),
        },
  )

  return calculateInterest(items, terms, { interestAlreadyCharged: alreadyCharged })
}
