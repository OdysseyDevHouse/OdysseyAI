import 'server-only'
import { round } from '@/lib/decimals'
import { customerQuery, supplierQuery } from './customerDb'
import {
  splitCsvLine,
  sniffDelimiter,
  detectDateFormat,
  parseDate,
  parseAmount,
} from '@/lib/import/text'
import { postTransaction } from './customerLedger'
import { postSupplierTransaction } from './supplierLedger'
import type { Actor } from './activityLog'

/**
 * Reads the file this import is aimed at, wherever it lives.
 *
 * Every query in this module touches ONE cluster — customers with
 * customer_transactions, or suppliers with supplier_transactions — and never
 * joins a branch-owned table, so moving the whole statement to the owner is
 * correct for all of them. See the rule in customerDb.ts.
 *
 * It used to call siteQuery directly, which broke the import at every branch of
 * a group sharing its debtors book. Both halves failed, and the worse one
 * failed silently: planOpeningBalances matched codes against the branch's own
 * empty customers table so every row was rejected as unknown, while
 * existingOpenings read the branch's empty customer_transactions and so found
 * nothing already imported — killing the only guard against posting a book
 * twice. applyOpeningBalances always resolved the owner correctly through
 * postTransaction, so the write half was aimed at a file the read half could
 * not see.
 */
function fileQuery(side: OpeningSide) {
  return side === 'customer' ? customerQuery : supplierQuery
}

/**
 * Opening balances — carrying in what is already owed on the day you switch.
 *
 * The single decision that shapes this whole file: an opening balance is
 * imported as **one transaction per outstanding invoice**, not one lump per
 * account. A lump is the tempting shortcut and it is wrong, because everything
 * downstream of the ledger reads per-transaction:
 *
 *  - **Ageing** buckets by document date. One lump dated go-live day ages every
 *    account as current, so a debtor 120 days overdue looks fine on the first
 *    age analysis anyone runs. That report is often the reason a store is
 *    switching systems in the first place.
 *  - **Allocation** is open-item. A customer paying "the March invoice" needs
 *    a March invoice to allocate against; against one lump, every payment is a
 *    part-payment of an undifferentiated blob.
 *  - **Statements** list documents. A statement showing a single line called
 *    "Opening balance" tells the customer nothing they can check against their
 *    own records, which is exactly when they stop paying.
 *
 * So the import takes the invoice list, dated as it really was. The old
 * system's document numbers come with it, because those are what the customer
 * has on their copy and what they will quote when they phone.
 *
 * VAT is deliberately NOT split out. These invoices were declared in a period
 * that closed under the old system; re-declaring their VAT here would double
 * it. They come in at gross with `vatRatePct` zero — a balance carried forward,
 * not a fresh tax event.
 */

export type OpeningSide = 'customer' | 'supplier'

export type OpeningRow = {
  /** The account's code in THIS system — matched, never created. */
  code: string
  docNumber: string
  docDate: string
  amount: number
  reference?: string | null
}

export type RowProblem = {
  row: number
  code: string
  docNumber: string
  reason: string
}

export type OpeningPlan = {
  side: OpeningSide
  /** Rows that will post, with the account they matched. */
  ready: (OpeningRow & { accountId: number; accountName: string })[]
  /** Rows that will not post, and why. Never silently dropped. */
  problems: RowProblem[]
  total: number
  accountCount: number
  /** Accounts that already carry an opening transaction from a previous run. */
  alreadyImported: { code: string; name: string; count: number }[]
}

const DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Checks an import without writing anything.
 *
 * Always run before `applyOpeningBalances`, and the screen shows the result:
 * an import that half-succeeds across two hundred accounts is miserable to
 * unpick, and every problem here is knowable in advance.
 */
export async function planOpeningBalances(
  siteId: number,
  side: OpeningSide,
  rows: readonly OpeningRow[],
): Promise<OpeningPlan> {
  const ready: OpeningPlan['ready'] = []
  const problems: RowProblem[] = []

  const table = side === 'customer' ? 'customers' : 'suppliers'
  const accounts = await fileQuery(side)<Record<string, unknown>>(
    siteId,
    `SELECT id, code, name, status FROM ${table}`,
  )

  const byCode = new Map(
    accounts.map((a) => [
      String(a.code).trim().toUpperCase(),
      { id: Number(a.id), name: String(a.name), status: String(a.status) },
    ]),
  )

  // Duplicate document numbers within the file itself: two rows claiming to be
  // the same invoice would post the debt twice.
  const seen = new Set<string>()

  for (const [index, row] of rows.entries()) {
    const line = index + 1
    const code = row.code?.trim() ?? ''
    const docNumber = row.docNumber?.trim() ?? ''
    const problem = (reason: string) => problems.push({ row: line, code, docNumber, reason })

    if (!code) {
      problem('No account code.')
      continue
    }
    if (!docNumber) {
      problem('No document number — the customer needs it to recognise the debt.')
      continue
    }

    const account = byCode.get(code.toUpperCase())
    if (!account) {
      problem(`No ${side} with code ${code}. Create the account first, or fix the code.`)
      continue
    }
    if (account.status === 'closed') {
      problem(`${account.name} is closed. Reopen it before carrying a balance in.`)
      continue
    }
    if (!DATE.test(row.docDate ?? '')) {
      problem('The date must be yyyy-mm-dd. It sets the ageing bucket, so it has to be the real one.')
      continue
    }
    if (row.docDate > today()) {
      problem('That date is in the future.')
      continue
    }

    const amount = round(Number(row.amount), 2)
    if (!Number.isFinite(amount) || amount === 0) {
      problem('The amount must be a number, and not zero.')
      continue
    }
    if (amount < 0) {
      problem('Negative opening amounts are refused. Import a credit note as its own row if the account is in credit.')
      continue
    }

    const key = `${code.toUpperCase()}::${docNumber.toUpperCase()}`
    if (seen.has(key)) {
      problem(`${docNumber} appears twice for ${code} in this file.`)
      continue
    }
    seen.add(key)

    ready.push({
      code,
      docNumber,
      docDate: row.docDate,
      amount,
      reference: row.reference?.trim() || null,
      accountId: account.id,
      accountName: account.name,
    })
  }

  return {
    side,
    ready,
    problems,
    total: round(ready.reduce((sum, r) => sum + r.amount, 0), 2),
    accountCount: new Set(ready.map((r) => r.accountId)).size,
    alreadyImported: await existingOpenings(siteId, side, [...new Set(ready.map((r) => r.accountId))]),
  }
}

/**
 * Accounts that already have opening transactions.
 *
 * Surfaced rather than blocked: re-importing is occasionally right (the first
 * file was wrong and its rows were removed), and the person doing it knows
 * which case they are in. What must never happen is finding out afterwards.
 */
async function existingOpenings(
  siteId: number,
  side: OpeningSide,
  accountIds: readonly number[],
): Promise<{ code: string; name: string; count: number }[]> {
  if (accountIds.length === 0) return []

  const txTable = side === 'customer' ? 'customer_transactions' : 'supplier_transactions'
  const acTable = side === 'customer' ? 'customers' : 'suppliers'
  const fk = side === 'customer' ? 'customer_id' : 'supplier_id'

  const rows = await fileQuery(side)<Record<string, unknown>>(
    siteId,
    `SELECT a.code, a.name, COUNT(*) AS count
       FROM ${txTable} t
       JOIN ${acTable} a ON a.id = t.${fk}
      WHERE t.doc_type = 'opening'
        AND t.${fk} IN (${accountIds.map(() => '?').join(',')})
      GROUP BY a.code, a.name`,
    [...accountIds],
  )

  return rows.map((r) => ({
    code: String(r.code),
    name: String(r.name),
    count: Number(r.count),
  }))
}

export type ImportResult = {
  posted: number
  total: number
  failed: RowProblem[]
}

/**
 * Posts the plan.
 *
 * Deliberately NOT one big transaction. Two hundred accounts in a single
 * transaction means one bad row rolls back a hundred and ninety-nine good
 * ones, and the person re-running it has no idea which succeeded. Each row is
 * its own posting, and anything that fails comes back named — the same
 * partial-result shape the bulk updates and statement runs use, because it is
 * the shape that lets someone fix two rows instead of redoing everything.
 *
 * Re-running is safe in the sense that matters: every row carries the old
 * system's document number, so a duplicate is visible on the account rather
 * than hidden inside a lump.
 */
export async function applyOpeningBalances(
  siteId: number,
  actor: Actor,
  plan: OpeningPlan,
): Promise<ImportResult> {
  const failed: RowProblem[] = []
  let posted = 0
  let total = 0

  for (const [index, row] of plan.ready.entries()) {
    const input = {
      docType: 'opening' as const,
      amount: row.amount,
      docDate: row.docDate,
      docNumber: row.docNumber,
      reference: row.reference,
      description: 'Balance brought forward',
      // Zero: this invoice's VAT was declared under the old system. See the
      // note at the top of this file.
      vatRatePct: 0,
      source: 'opening_import',
    }

    const result =
      plan.side === 'customer'
        ? await postTransaction(siteId, actor, { ...input, customerId: row.accountId })
        : await postSupplierTransaction(siteId, actor, { ...input, supplierId: row.accountId })

    if (result.ok) {
      posted += 1
      total = round(total + row.amount, 2)
    } else {
      failed.push({
        row: index + 1,
        code: row.code,
        docNumber: row.docNumber,
        reason: result.error,
      })
    }
  }

  return { posted, total, failed }
}

/**
 * Parses pasted or uploaded CSV into rows.
 *
 * Tolerant on purpose: this data is coming out of some other system's export,
 * and refusing the whole file over a header spelled "Doc No" instead of
 * "docnumber" helps nobody. Column order is taken from the header when one is
 * present, and assumed otherwise.
 */
export function parseOpeningCsv(text: string): { rows: OpeningRow[]; skipped: number } {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)

  if (lines.length === 0) return { rows: [], skipped: 0 }

  // Quote-aware, and the delimiter is sniffed rather than assumed. Splitting on
  // /[,;\t]/ used to break every row for a customer called 'Smith, T (Pty) Ltd':
  // the comma inside the quoted name shifted amount into reference's column, so
  // the invoice posted as zero — with nothing on screen to say it had.
  const delimiter = sniffDelimiter(lines[0])
  const cells = (line: string) => splitCsvLine(line, delimiter)

  const first = cells(lines[0]).map((c) => c.toLowerCase().replace(/[^a-z]/g, ''))
  const known = ['code', 'docnumber', 'docdate', 'amount', 'reference']
  const looksLikeHeader = first.some((c) => known.includes(c) || c === 'account' || c === 'date' || c === 'invoice')

  // Default order, used when the file has no header row.
  let order = { code: 0, docNumber: 1, docDate: 2, amount: 3, reference: 4 }

  if (looksLikeHeader) {
    const find = (...names: string[]) => {
      const i = first.findIndex((c) => names.includes(c))
      return i === -1 ? -1 : i
    }
    order = {
      code: find('code', 'account', 'accountcode', 'customercode', 'suppliercode'),
      docNumber: find('docnumber', 'invoice', 'invoiceno', 'documentnumber', 'docno', 'number'),
      docDate: find('docdate', 'date', 'invoicedate', 'documentdate'),
      amount: find('amount', 'total', 'balance', 'outstanding', 'value'),
      reference: find('reference', 'ref', 'yourref', 'orderno'),
    }
  }

  const body = lines.slice(looksLikeHeader ? 1 : 0)

  // Ambiguous d/m vs m/d is decided ONCE for the whole file, from whichever row
  // carries a day past the 12th — the only unambiguous evidence a file offers.
  // Deciding per row would put 05/08 and 20/08 in different months. Day-first
  // is the fallback, because every South African system writes it that way.
  const dateFormat = detectDateFormat(
    body.map((line) => {
      const c = cells(line)
      return order.docDate >= 0 && order.docDate < c.length ? c[order.docDate] : ''
    }),
  )

  const rows: OpeningRow[] = []
  let skipped = 0

  for (const line of body) {
    const c = cells(line)
    const at = (index: number) => (index >= 0 && index < c.length ? c[index] : '')

    const code = at(order.code)
    if (!code) {
      skipped += 1
      continue
    }

    rows.push({
      code,
      docNumber: at(order.docNumber),
      // An unreadable date stays as it was written: planOpeningBalances checks
      // it against DATE and reports the row by name, which is far more use than
      // a silent fallback to today.
      docDate: parseDate(at(order.docDate), dateFormat) ?? at(order.docDate).trim(),
      // Handles thousands separators, currency symbols, trailing minus and
      // parenthesised negatives — every one of which appears in a real export.
      amount: parseAmount(at(order.amount)) ?? 0,
      reference: at(order.reference) || null,
    })
  }

  return { rows, skipped }
}

function today(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
