import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne } from '../siteDb'
import { round, toNum } from '../decimals'
import {
  cashFlowSection,
  CASH_FLOW_SECTION_LABELS,
  type AccountType,
  type CashFlowSection,
} from '../glModel'
import type { DateRange } from './financialStatements'

/**
 * The cash flow statement, indirect method — the third of the three
 * statements, and the one the other two cannot answer: the business made a
 * profit, so where is the money?
 *
 * ── WHY THIS RECONCILES BY CONSTRUCTION ──────────────────────────────────
 *
 * Every posted batch sums to zero, so over any period the movement on the
 * CASH accounts equals minus the movement on everything else. Classify every
 * non-cash account into a section — operating, investing, financing, with an
 * explicit 'other' catch-all so nothing is ever dropped — and the sections
 * MUST add up to the change in cash. `unexplained` states the residual
 * rather than trusting the theory: anything non-zero means an unbalanced
 * batch got in, and hiding that would make this statement a fiction.
 *
 * ── THE TWO EXCLUSIONS ───────────────────────────────────────────────────
 *
 * Year-end batches are excluded entirely. A close moves the P&L into
 * retained earnings — pure reclassification, no cash, and including one
 * would corrupt both the net result and the financing section in the same
 * stroke whenever the range spans a year end. The batch sums to zero and
 * touches no cash account, so excluding it cannot unbalance the statement.
 *
 * Depreciation and disposal batches are non-cash: their P&L side stays in
 * the net result (depreciation reduced the profit; the reader starts from
 * that profit), and their balance-sheet side is re-routed OUT of investing
 * into one operating add-back line. Without that re-route, depreciation
 * shows up as an "investing inflow" — arithmetically true under zero-sum,
 * and exactly the kind of true that misleads. Both halves come from the
 * same zero-sum batches, so the re-route moves money between sections
 * without creating or destroying any.
 */

export type CashFlowLine = {
  accountId: number
  accountCode: string
  name: string
  /** Cash effect: positive = generated cash, negative = consumed it. */
  amount: number
}

export type CashFlowGroup = {
  section: Exclude<CashFlowSection, 'cash'>
  label: string
  lines: CashFlowLine[]
  total: number
}

export type CashFlowStatement = {
  range: DateRange
  /** Profit for the period, the indirect method's starting point. */
  netResult: number
  /** Depreciation and other non-cash movements added back. */
  nonCashAdjustments: number
  /** Working-capital lines: debtors, stock, creditors, VAT moving. */
  operating: CashFlowGroup
  investing: CashFlowGroup
  financing: CashFlowGroup
  /** Unclassifiable subtypes — present so nothing is silently dropped. */
  other: CashFlowGroup
  operatingTotal: number
  openingCash: number
  closingCash: number
  netCashMovement: number
  /** Zero when the ledger is consistent. Anything else is a posting bug. */
  unexplained: number
  balanced: boolean
}

type Row = RowDataPacket & Record<string, unknown>

/** Batches whose whole purpose is non-cash — see the module comment. */
const NON_CASH_SOURCES = "('depreciation','asset_disposal')"

export async function cashFlowStatement(
  siteId: number,
  range: DateRange,
): Promise<CashFlowStatement> {
  const [movements, cashRows, cashPositions] = await Promise.all([
    siteQuery<Row>(
      siteId,
      `SELECT a.id, a.account_code, a.name, a.account_type, a.subtype, a.control_type,
              COALESCE(SUM(l.amount), 0) AS movement,
              COALESCE(SUM(CASE WHEN b.source IN ${NON_CASH_SOURCES} THEN l.amount ELSE 0 END), 0) AS noncash
         FROM journal_lines l
         JOIN journal_batches b ON b.id = l.batch_id
         JOIN gl_accounts a     ON a.id = l.account_id
        WHERE b.status = 'posted'
          AND b.journal_date BETWEEN ? AND ?
          AND b.source <> 'year_end'
        GROUP BY a.id, a.account_code, a.name, a.account_type, a.subtype, a.control_type
       HAVING ABS(movement) > 0.004 OR ABS(noncash) > 0.004`,
      [range.from, range.to],
    ),
    /*
     * What counts as CASH. control_type = 'bank' is the declared answer; the
     * seeded chart also leaves 1000 Bank and cash without a control type, so
     * any account the cashbook or a tender actually posts to counts too.
     */
    siteQuery<Row>(
      siteId,
      `SELECT id FROM gl_accounts WHERE control_type = 'bank'
        UNION
       SELECT DISTINCT account_id AS id FROM gl_mappings
        WHERE mapping_key IN ('bank_account','tender')`,
    ),
    siteQueryOne<Row>(
      siteId,
      `SELECT
          COALESCE(SUM(CASE WHEN b.journal_date < ? THEN l.amount ELSE 0 END), 0) AS opening,
          COALESCE(SUM(l.amount), 0) AS closing
         FROM journal_lines l
         JOIN journal_batches b ON b.id = l.batch_id
        WHERE b.status = 'posted'
          AND b.journal_date <= ?
          AND l.account_id IN (
            SELECT id FROM gl_accounts WHERE control_type = 'bank'
            UNION
            SELECT DISTINCT account_id FROM gl_mappings WHERE mapping_key IN ('bank_account','tender')
          )`,
      [range.from, range.to],
    ),
  ])

  const cashIds = new Set(cashRows.map((r) => Number(r.id)))

  let netResult = 0
  let nonCashAdjustments = 0
  const groups: Record<Exclude<CashFlowSection, 'cash'>, CashFlowLine[]> = {
    operating: [],
    investing: [],
    financing: [],
    other: [],
  }

  for (const r of movements) {
    const id = Number(r.id)
    if (cashIds.has(id)) continue

    const type = String(r.account_type) as AccountType
    const movement = toNum(r.movement)
    const noncash = toNum(r.noncash)

    if (type === 'income' || type === 'expense') {
      // Credit-normal income sits negative under the debit convention, so the
      // period's profit is minus the P&L movement. The non-cash P&L component
      // (the depreciation charge, a disposal's gain) stays IN this figure —
      // that is what the add-back line below corrects for.
      netResult = round(netResult - movement, 2)
      continue
    }

    const section = cashFlowSection(type, (r.subtype as string | null) ?? null, (r.control_type as string | null) ?? null)
    if (section === 'cash') continue

    // A debit movement (asset up, liability down) consumed cash; minus the
    // movement is its cash effect. The non-cash batch component is re-routed
    // to the operating add-back — see the module comment.
    const cashEffect = round(-(movement - noncash), 2)
    nonCashAdjustments = round(nonCashAdjustments - noncash, 2)

    if (Math.abs(cashEffect) < 0.005) continue
    groups[section].push({
      accountId: id,
      accountCode: String(r.account_code),
      name: String(r.name),
      amount: cashEffect,
    })
  }

  for (const section of Object.keys(groups) as (keyof typeof groups)[]) {
    groups[section].sort((a, b) => a.accountCode.localeCompare(b.accountCode))
  }

  const groupTotal = (lines: CashFlowLine[]) =>
    round(lines.reduce((sum, l) => sum + l.amount, 0), 2)

  const group = (section: Exclude<CashFlowSection, 'cash'>): CashFlowGroup => ({
    section,
    label: CASH_FLOW_SECTION_LABELS[section],
    lines: groups[section],
    total: groupTotal(groups[section]),
  })

  const operating = group('operating')
  const investing = group('investing')
  const financing = group('financing')
  const other = group('other')

  const operatingTotal = round(netResult + nonCashAdjustments + operating.total, 2)

  const openingCash = round(toNum(cashPositions?.opening), 2)
  const closingCash = round(toNum(cashPositions?.closing), 2)
  const netCashMovement = round(closingCash - openingCash, 2)

  const explained = round(operatingTotal + investing.total + financing.total + other.total, 2)
  const unexplained = round(netCashMovement - explained, 2)

  return {
    range,
    netResult,
    nonCashAdjustments,
    operating,
    investing,
    financing,
    other,
    operatingTotal,
    openingCash,
    closingCash,
    netCashMovement,
    unexplained,
    balanced: unexplained === 0,
  }
}
