import 'server-only'
import type { PoolConnection } from 'mysql2/promise'
import { siteTransaction, siteQueryOne } from '../siteDb'
import { round } from '../decimals'
import { logActivity, type Actor } from './activityLog'
import { postTx } from './journals'
import { resolveAccount } from './chartOfAccounts'
import type { JournalLineInput } from '../glModel'

/**
 * Mirroring subledger events into the general ledger.
 *
 * ── WHAT THIS MODULE IS ──────────────────────────────────────────────────
 *
 * The translation layer. A sale knows about products, tenders and customers; the
 * ledger knows about accounts. This turns one into the other, and it is the
 * only place that knows both — every posting path calls a function here rather
 * than assembling journal lines itself.
 *
 * ── IT FAILS SOFT, DELIBERATELY ──────────────────────────────────────────
 *
 * If a mapping is missing or a journal cannot be built, the SUBLEDGER WRITE
 * STILL STANDS. A till must be able to take money when nobody has configured
 * the GL account for a new tender type. The consequence is a reporting gap that
 * ledgerHealth() reports and reconcileControlAccounts() quantifies — not a
 * refused sale.
 *
 * That is the direct consequence of the GL being a derived mirror rather than
 * the source of truth; see the note at the top of 045.
 *
 * ── EVERY ENTRY BALANCES BY CONSTRUCTION ─────────────────────────────────
 *
 * Each builder below produces its lines so they sum to zero, then postTx checks
 * it again. Belt and braces on purpose: the check is cheap and an unbalanced
 * batch poisons every statement built on it.
 */

/** Where a journal could not be built, and why. Never thrown at the caller. */
export type MirrorResult = { ok: true; batchId: number } | { ok: false; reason: string }

async function mapped(
  siteId: number,
  key: string,
  refId?: number | null,
): Promise<number | null> {
  return resolveAccount(siteId, key, refId)
}

/**
 * Runs a builder, swallowing failure into a reason.
 *
 * The swallow is the point — see the note above. It is logged rather than
 * silent, so a store whose GL is quietly not being written finds out.
 */
async function attempt(
  siteId: number,
  actor: Actor,
  label: string,
  build: () => Promise<{ batchId: number }>,
): Promise<MirrorResult> {
  try {
    const result = await build()
    return { ok: true, batchId: result.batchId }
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'The ledger entry could not be built.'
    await logActivity(siteId, actor, {
      entity: 'gl',
      entityId: null,
      action: 'mirror_failed',
      detail: `${label} did not reach the ledger — ${reason}`,
    }).catch(() => undefined)
    return { ok: false, reason }
  }
}

/* ── Sales ───────────────────────────────────────────────────────────────── */

export type SaleMirror = {
  documentId: number
  documentNumber: string | null
  documentDate: string
  isCreditNote: boolean
  /** Revenue excluding VAT, per department where known. */
  revenueLines: { departmentId: number | null; excl: number }[]
  vatTotal: number
  /** Cost of what was sold, at the cost the stock came in at. */
  costOfSales: number
  /** How the sale was settled. Account tenders go to the debtor instead. */
  tenders: { tenderTypeId: number | null; isAccount: boolean; amount: number }[]
  customerId?: number | null
  roundingAdjustment?: number
}

/**
 * The journal behind a sale.
 *
 *   DEBIT  bank/tender (or debtors, on account)   what was received
 *   CREDIT sales income                            revenue, excluding VAT
 *   CREDIT VAT output                              the VAT charged
 *   DEBIT  cost of sales                           what the goods cost
 *   CREDIT stock                                   the stock that left
 *
 * The last two are the pair that makes a P&L meaningful: without them revenue
 * appears with no cost against it and every month looks wildly profitable.
 *
 * A credit note is the same entry with every sign flipped, which is why one
 * builder handles both rather than two that can drift apart.
 */
export async function mirrorSale(
  siteId: number,
  actor: Actor,
  input: SaleMirror,
): Promise<MirrorResult> {
  const sign = input.isCreditNote ? -1 : 1
  const label = `${input.isCreditNote ? 'Credit note' : 'Sale'} ${input.documentNumber ?? `#${input.documentId}`}`

  return attempt(siteId, actor, label, async () => {
    const lines: JournalLineInput[] = []

    // Money in, by tender.
    for (const tender of input.tenders) {
      if (round(tender.amount, 2) === 0) continue

      const accountId = tender.isAccount
        ? await mapped(siteId, 'debtors_control')
        : await mapped(siteId, 'tender', tender.tenderTypeId)
      if (!accountId) throw new Error('No account is mapped for one of the tenders used.')

      lines.push({
        accountId,
        amount: round(sign * tender.amount, 2),
        description: tender.isAccount ? 'On account' : 'Received',
        customerId: tender.isAccount ? (input.customerId ?? null) : null,
      })
    }

    // Revenue, per department so a departmental P&L is possible.
    const incomeKey = input.isCreditNote ? 'sales_returns' : 'sales_income'
    for (const revenue of input.revenueLines) {
      if (round(revenue.excl, 2) === 0) continue
      const accountId =
        (await mapped(siteId, incomeKey, revenue.departmentId)) ??
        (await mapped(siteId, 'sales_income', revenue.departmentId))
      if (!accountId) throw new Error('No income account is mapped.')

      lines.push({
        accountId,
        amount: round(-sign * revenue.excl, 2),
        description: 'Revenue',
        departmentId: revenue.departmentId,
      })
    }

    if (round(input.vatTotal, 2) !== 0) {
      const vatAccount = await mapped(siteId, 'vat_output')
      if (!vatAccount) throw new Error('No VAT output account is mapped.')
      lines.push({
        accountId: vatAccount,
        amount: round(-sign * input.vatTotal, 2),
        description: 'VAT on sales',
      })
    }

    // Cash rounding, which exists so the drawer takes a round number. Small,
    // but the entry will not balance without it.
    if (input.roundingAdjustment && round(input.roundingAdjustment, 2) !== 0) {
      const roundingAccount = await mapped(siteId, 'rounding')
      if (!roundingAccount) throw new Error('No rounding account is mapped.')
      lines.push({
        accountId: roundingAccount,
        amount: round(-sign * input.roundingAdjustment, 2),
        description: 'Cash rounding',
      })
    }

    // Cost of sales and the stock that left. Skipped when cost is unknown —
    // better a P&L with no cost line than a journal that will not balance.
    if (round(input.costOfSales, 2) !== 0) {
      const [cosAccount, stockAccount] = await Promise.all([
        mapped(siteId, 'cost_of_sales'),
        mapped(siteId, 'stock_control'),
      ])
      if (cosAccount && stockAccount) {
        lines.push({
          accountId: cosAccount,
          amount: round(sign * input.costOfSales, 2),
          description: 'Cost of goods sold',
        })
        lines.push({
          accountId: stockAccount,
          amount: round(-sign * input.costOfSales, 2),
          description: 'Stock out',
        })
      }
    }

    return siteTransaction(siteId, async (tx) => {
      const posted = await postTx(tx, actor, {
        journalDate: input.documentDate,
        description: label,
        reference: input.documentNumber,
        source: input.isCreditNote ? 'credit_note' : 'sale',
        sourceDocId: input.documentId,
        lines,
      })
      return { batchId: posted.id }
    })
  })
}

/* ── Purchases ───────────────────────────────────────────────────────────── */

export type GrvMirror = {
  documentId: number
  documentNumber: string | null
  documentDate: string
  isReturn: boolean
  supplierId: number
  /** Stock value excluding VAT. */
  stockExcl: number
  vatTotal: number
}

/**
 * The journal behind goods received.
 *
 *   DEBIT  stock            what arrived, at cost
 *   DEBIT  VAT input        the VAT we may reclaim
 *   CREDIT creditors        what we now owe
 *
 * A supplier return is the same entry reversed.
 */
export async function mirrorGrv(
  siteId: number,
  actor: Actor,
  input: GrvMirror,
): Promise<MirrorResult> {
  const sign = input.isReturn ? -1 : 1
  const label = `${input.isReturn ? 'Supplier return' : 'Goods received'} ${input.documentNumber ?? `#${input.documentId}`}`

  return attempt(siteId, actor, label, async () => {
    const [stockAccount, vatAccount, creditorsAccount] = await Promise.all([
      mapped(siteId, 'stock_control'),
      mapped(siteId, 'vat_input'),
      mapped(siteId, 'creditors_control'),
    ])
    if (!stockAccount || !creditorsAccount) {
      throw new Error('The stock or creditors control account is not mapped.')
    }

    const lines: JournalLineInput[] = [
      {
        accountId: stockAccount,
        amount: round(sign * input.stockExcl, 2),
        description: 'Stock in',
      },
    ]

    if (round(input.vatTotal, 2) !== 0) {
      if (!vatAccount) throw new Error('No VAT input account is mapped.')
      lines.push({
        accountId: vatAccount,
        amount: round(sign * input.vatTotal, 2),
        description: 'VAT on purchases',
      })
    }

    lines.push({
      accountId: creditorsAccount,
      amount: round(-sign * (input.stockExcl + input.vatTotal), 2),
      description: 'Owed to supplier',
      supplierId: input.supplierId,
    })

    return siteTransaction(siteId, async (tx) => {
      const posted = await postTx(tx, actor, {
        journalDate: input.documentDate,
        description: label,
        reference: input.documentNumber,
        source: input.isReturn ? 'supplier_return' : 'grv',
        sourceDocId: input.documentId,
        lines,
      })
      return { batchId: posted.id }
    })
  })
}

/* ── Expenses ────────────────────────────────────────────────────────────── */

export type ExpenseMirror = {
  expenseId: number
  documentNumber: string | null
  expenseDate: string
  isBill: boolean
  supplierId: number | null
  bankAccountId: number | null
  /** Per category, so each lands in its own expense account. */
  lines: { categoryId: number; excl: number; vat: number; vatClaimable: boolean; departmentId: number | null }[]
  totalIncl: number
}

/**
 * The journal behind an expense.
 *
 *   DEBIT  the expense account(s)   the cost, excluding claimable VAT
 *   DEBIT  VAT input                only where it may be claimed
 *   CREDIT bank, or creditors       depending on how it was settled
 *
 * ── DENIED VAT GOES INTO THE COST ────────────────────────────────────────
 *
 * Where a category cannot claim input VAT — entertainment, salaries — the VAT
 * is not a separate asset, it is simply part of what the thing cost. So it is
 * added to the expense line rather than posted to VAT input. Doing otherwise
 * would both overstate the reclaimable VAT and understate the expense.
 */
export async function mirrorExpense(
  siteId: number,
  actor: Actor,
  input: ExpenseMirror,
): Promise<MirrorResult> {
  const label = `Expense ${input.documentNumber ?? `#${input.expenseId}`}`

  return attempt(siteId, actor, label, async () => {
    const lines: JournalLineInput[] = []
    let claimableVat = 0

    for (const line of input.lines) {
      const accountId = await mapped(siteId, 'expense_category', line.categoryId)
      if (!accountId) throw new Error('An expense category is not mapped to a ledger account.')

      // Denied VAT joins the cost; claimable VAT is separated out below.
      const cost = line.vatClaimable ? line.excl : round(line.excl + line.vat, 2)
      if (line.vatClaimable) claimableVat = round(claimableVat + line.vat, 2)

      lines.push({
        accountId,
        amount: round(cost, 2),
        description: 'Expense',
        departmentId: line.departmentId,
      })
    }

    if (claimableVat !== 0) {
      const vatAccount = await mapped(siteId, 'vat_input')
      if (!vatAccount) throw new Error('No VAT input account is mapped.')
      lines.push({ accountId: vatAccount, amount: claimableVat, description: 'VAT on expense' })
    }

    const creditAccount = input.isBill
      ? await mapped(siteId, 'creditors_control')
      : await mapped(siteId, 'bank_account', input.bankAccountId)
    if (!creditAccount) {
      throw new Error(
        input.isBill
          ? 'The creditors control account is not mapped.'
          : 'That bank account is not mapped to a ledger account.',
      )
    }

    lines.push({
      accountId: creditAccount,
      amount: round(-input.totalIncl, 2),
      description: input.isBill ? 'Owed to supplier' : 'Paid',
      supplierId: input.isBill ? input.supplierId : null,
    })

    return siteTransaction(siteId, async (tx) => {
      const posted = await postTx(tx, actor, {
        journalDate: input.expenseDate,
        description: label,
        reference: input.documentNumber,
        source: 'expense',
        sourceDocId: input.expenseId,
        lines,
      })
      return { batchId: posted.id }
    })
  })
}

/* ── Money movements ─────────────────────────────────────────────────────── */

export type ReceiptMirror = {
  transactionId: number
  date: string
  customerId: number
  bankAccountId: number
  amount: number
  reference?: string | null
}

/**
 * A customer paying.
 *
 *   DEBIT  bank       money in
 *   CREDIT debtors    they owe less
 *
 * No income here, and that trips people up: the revenue was recognised when the
 * invoice was raised. A receipt only moves the same money from one asset to
 * another. Posting income again would double-count every credit sale.
 */
export async function mirrorReceipt(
  siteId: number,
  actor: Actor,
  input: ReceiptMirror,
): Promise<MirrorResult> {
  return attempt(siteId, actor, `Receipt ${input.reference ?? `#${input.transactionId}`}`, async () => {
    const [bankAccount, debtorsAccount] = await Promise.all([
      mapped(siteId, 'bank_account', input.bankAccountId),
      mapped(siteId, 'debtors_control'),
    ])
    if (!bankAccount || !debtorsAccount) throw new Error('The bank or debtors account is not mapped.')

    return siteTransaction(siteId, async (tx) => {
      const posted = await postTx(tx, actor, {
        journalDate: input.date,
        description: 'Customer receipt',
        reference: input.reference,
        source: 'receipt',
        sourceDocId: input.transactionId,
        lines: [
          { accountId: bankAccount, amount: round(input.amount, 2), description: 'Received' },
          {
            accountId: debtorsAccount,
            amount: round(-input.amount, 2),
            description: 'Settled by customer',
            customerId: input.customerId,
          },
        ],
      })
      return { batchId: posted.id }
    })
  })
}

export type SupplierPaymentMirror = {
  transactionId: number
  date: string
  supplierId: number
  bankAccountId: number | null
  amount: number
  reference?: string | null
}

/**
 * Paying a supplier. The mirror of a receipt.
 *
 *   DEBIT  creditors   we owe less
 *   CREDIT bank        money out
 */
export async function mirrorSupplierPayment(
  siteId: number,
  actor: Actor,
  input: SupplierPaymentMirror,
): Promise<MirrorResult> {
  return attempt(siteId, actor, `Supplier payment #${input.transactionId}`, async () => {
    const [bankAccount, creditorsAccount] = await Promise.all([
      mapped(siteId, 'bank_account', input.bankAccountId),
      mapped(siteId, 'creditors_control'),
    ])
    if (!bankAccount || !creditorsAccount) {
      throw new Error('The bank or creditors account is not mapped.')
    }

    return siteTransaction(siteId, async (tx) => {
      const posted = await postTx(tx, actor, {
        journalDate: input.date,
        description: 'Supplier payment',
        reference: input.reference,
        source: 'payment',
        sourceDocId: input.transactionId,
        lines: [
          {
            accountId: creditorsAccount,
            amount: round(input.amount, 2),
            description: 'Paid to supplier',
            supplierId: input.supplierId,
          },
          { accountId: bankAccount, amount: round(-input.amount, 2), description: 'Paid' },
        ],
      })
      return { batchId: posted.id }
    })
  })
}

/* ── Debtor adjustments ──────────────────────────────────────────────────── */

export type InterestMirror = {
  transactionId: number
  date: string
  customerId: number
  amount: number
}

/**
 * Interest charged to a customer.
 *
 *   DEBIT  debtors            they owe more
 *   CREDIT interest received  income earned
 */
export async function mirrorInterest(
  siteId: number,
  actor: Actor,
  input: InterestMirror,
): Promise<MirrorResult> {
  return attempt(siteId, actor, `Interest #${input.transactionId}`, async () => {
    const [debtorsAccount, incomeAccount] = await Promise.all([
      mapped(siteId, 'debtors_control'),
      mapped(siteId, 'interest_received'),
    ])
    if (!debtorsAccount || !incomeAccount) {
      throw new Error('The debtors or interest income account is not mapped.')
    }

    return siteTransaction(siteId, async (tx) => {
      const posted = await postTx(tx, actor, {
        journalDate: input.date,
        description: 'Interest charged',
        source: 'interest',
        sourceDocId: input.transactionId,
        lines: [
          {
            accountId: debtorsAccount,
            amount: round(input.amount, 2),
            description: 'Interest charged',
            customerId: input.customerId,
          },
          { accountId: incomeAccount, amount: round(-input.amount, 2), description: 'Interest earned' },
        ],
      })
      return { batchId: posted.id }
    })
  })
}

export type WriteOffMirror = {
  transactionId: number
  date: string
  customerId: number
  amount: number
}

/**
 * Debt written off.
 *
 *   DEBIT  bad debts   a cost the business bears
 *   CREDIT debtors     they no longer owe it
 */
export async function mirrorWriteOff(
  siteId: number,
  actor: Actor,
  input: WriteOffMirror,
): Promise<MirrorResult> {
  return attempt(siteId, actor, `Write-off #${input.transactionId}`, async () => {
    const [badDebtAccount, debtorsAccount] = await Promise.all([
      mapped(siteId, 'bad_debts'),
      mapped(siteId, 'debtors_control'),
    ])
    if (!badDebtAccount || !debtorsAccount) {
      throw new Error('The bad debts or debtors account is not mapped.')
    }

    return siteTransaction(siteId, async (tx) => {
      const posted = await postTx(tx, actor, {
        journalDate: input.date,
        description: 'Bad debt written off',
        source: 'write_off',
        sourceDocId: input.transactionId,
        lines: [
          { accountId: badDebtAccount, amount: round(input.amount, 2), description: 'Written off' },
          {
            accountId: debtorsAccount,
            amount: round(-input.amount, 2),
            description: 'Debt written off',
            customerId: input.customerId,
          },
        ],
      })
      return { batchId: posted.id }
    })
  })
}

/* ── Year end ────────────────────────────────────────────────────────────── */

export type YearEndResult =
  | { ok: true; batchId: number; netResult: number }
  | { ok: false; error: string }

/**
 * Closes a financial year.
 *
 * Every income and expense account is journalled back to zero and the net
 * result lands in retained earnings. Next year therefore starts from nothing on
 * the P&L while the balance sheet carries forward — which is the entire
 * distinction between a period account and a position account.
 *
 * Posted INSIDE the year being closed, on its last day, which is why it bypasses
 * the period lock: a year is normally locked before it is closed, and a
 * year-end entry dated after the year would fall in the next period's figures.
 */
export async function closeYear(
  siteId: number,
  actor: Actor,
  yearStart: string,
  yearEnd: string,
): Promise<YearEndResult> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(yearStart) || !/^\d{4}-\d{2}-\d{2}$/.test(yearEnd)) {
    return { ok: false, error: 'Choose a valid financial year.' }
  }
  if (yearStart >= yearEnd) return { ok: false, error: 'The year starts after it ends.' }

  const already = await siteQueryOne<{ id: number }>(
    siteId,
    "SELECT id FROM gl_year_ends WHERE year_start = ? AND year_end = ? AND status = 'closed' LIMIT 1",
    [yearStart, yearEnd],
  )
  if (already) return { ok: false, error: 'That year has already been closed.' }

  const retainedEarnings = await mapped(siteId, 'retained_earnings')
  if (!retainedEarnings) return { ok: false, error: 'No retained earnings account is mapped.' }

  const balances = await siteQueryOne<{ total: number }>(
    siteId,
    `SELECT COALESCE(SUM(l.amount), 0) AS total
       FROM journal_lines l
       JOIN journal_batches b ON b.id = l.batch_id
       JOIN gl_accounts a     ON a.id = l.account_id
      WHERE b.status = 'posted' AND b.journal_date BETWEEN ? AND ?
        AND a.account_type IN ('income','expense')`,
    [yearStart, yearEnd],
  )

  const { siteQuery } = await import('../siteDb')
  const accounts = await siteQuery<{ id: number; total: number }>(
    siteId,
    `SELECT a.id, COALESCE(SUM(l.amount), 0) AS total
       FROM gl_accounts a
       JOIN journal_lines l   ON l.account_id = a.id
       JOIN journal_batches b ON b.id = l.batch_id
      WHERE b.status = 'posted' AND b.journal_date BETWEEN ? AND ?
        AND a.account_type IN ('income','expense')
      GROUP BY a.id
     HAVING ABS(total) > 0.004`,
    [yearStart, yearEnd],
  )

  if (accounts.length === 0) {
    return { ok: false, error: 'There is nothing to close for that year.' }
  }

  // Each account journalled back to zero; the balancing figure is the result.
  const lines: JournalLineInput[] = accounts.map((a) => ({
    accountId: Number(a.id),
    amount: round(-Number(a.total), 2),
    description: 'Year-end close',
  }))

  const net = round(Number(balances?.total ?? 0), 2)
  lines.push({
    accountId: retainedEarnings,
    amount: net,
    description: 'Result for the year',
  })

  try {
    const result = await siteTransaction(siteId, async (tx: PoolConnection) => {
      const posted = await postTx(tx, actor, {
        journalDate: yearEnd,
        description: `Year end ${yearStart} to ${yearEnd}`,
        source: 'year_end',
        lines,
      })

      await tx.execute(
        `INSERT INTO gl_year_ends
           (year_start, year_end, batch_id, net_result, user_id, user_name)
         VALUES (?,?,?,?,?,?)`,
        [yearStart, yearEnd, posted.id, round(-net, 2).toFixed(4), actor.userId, actor.userName.slice(0, 120)] as never,
      )

      return posted
    })

    await logActivity(siteId, actor, {
      entity: 'gl',
      entityId: result.id,
      action: 'year_end',
      detail: `Closed ${yearStart} to ${yearEnd} — result ${round(-net, 2).toFixed(2)}`,
    })

    return { ok: true, batchId: result.id, netResult: round(-net, 2) }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'The year could not be closed.',
    }
  }
}
