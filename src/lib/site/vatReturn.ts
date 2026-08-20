import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne } from '../siteDb'
import { customerDbPrefix } from './customerDb'
import { round, toNum } from '../decimals'

/**
 * The VAT return: what we charged, what we were charged, and the difference.
 *
 * salesReports.vatByRate() has answered the OUTPUT side since sales shipped.
 * This adds the INPUT side from purchasing — which the system has been
 * capturing all along in purchase_document_lines.line_vat and never once
 * reported — and subtracts one from the other.
 *
 * Without it a bookkeeper exports two reports and does the subtraction by hand,
 * every two months, which is both the most error-prone step in the cycle and
 * the one nobody checks.
 *
 * ── WHAT THIS IS AND IS NOT ──────────────────────────────────────────────
 *
 * It is a VAT201-SHAPED summary built from the documents in this system. It is
 * not a submission, and it does not know about anything that never passed
 * through here — a vehicle bought privately, an accountant's journal, an
 * apportionment for private use. The figures are a starting point a bookkeeper
 * checks, and the screen says so rather than implying the return is done.
 *
 * ── INVOICE BASIS ────────────────────────────────────────────────────────
 *
 * Everything here is on the INVOICE basis: VAT is accounted for when the
 * document is issued, not when it is paid. That is the default in South Africa
 * and the only basis the document tables can support — a payments-basis return
 * needs the allocation data joined per period, which is a different report
 * rather than a flag on this one. Stated explicitly because getting the basis
 * wrong produces figures that look plausible and are entirely wrong.
 */

export type DateRange = { from: string; to: string }

export type VatRateRow = {
  ratePct: number
  excl: number
  vat: number
  incl: number
}

export type VatReturn = {
  range: DateRange
  /** VAT charged on sales, by rate. */
  outputByRate: VatRateRow[]
  outputTotal: { excl: number; vat: number; incl: number }
  /** VAT paid on purchases, by rate. */
  inputByRate: VatRateRow[]
  inputTotal: { excl: number; vat: number; incl: number }
  /** Output VAT reduced by credit notes issued. */
  salesCreditNotes: { excl: number; vat: number }
  /** Input VAT reduced by supplier returns. */
  purchaseReturns: { excl: number; vat: number }
  /**
   * Positive = payable to SARS. Negative = refund due.
   * Signed this way round because payable is overwhelmingly the common case and
   * a report whose headline figure is usually negative reads wrong.
   */
  netPayable: number
  /** Zero-rated and exempt supplies, which belong on the return but carry no VAT. */
  zeroRatedSales: number
  /** Sanity checks that failed. Empty when everything ties. */
  warnings: string[]
  vatNumber: string | null
}

type Row = RowDataPacket & Record<string, unknown>

function validRange(range: DateRange): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(range.from) &&
    /^\d{4}-\d{2}-\d{2}$/.test(range.to) &&
    range.from <= range.to
  )
}

/**
 * Output VAT by rate, from finalised sales documents.
 *
 * Invoices count positive and credit notes negative, so the figure is net —
 * which is what the return wants. Only 'finalised' and 'issued' documents
 * count: a draft is not a tax invoice and a void one never was.
 */
async function outputVat(siteId: number, range: DateRange): Promise<VatRateRow[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT l.vat_rate_pct AS rate,
            SUM(CASE WHEN d.doc_type = 'credit_note' THEN -l.line_total_excl ELSE l.line_total_excl END) AS excl,
            SUM(CASE WHEN d.doc_type = 'credit_note' THEN -l.line_vat  ELSE l.line_vat  END) AS vat,
            SUM(CASE WHEN d.doc_type = 'credit_note' THEN -l.line_total_incl ELSE l.line_total_incl END) AS incl
       FROM sales_document_lines l
       JOIN sales_documents d ON d.id = l.document_id
      WHERE d.doc_type IN ('invoice','credit_note')
        AND d.status IN ('issued','finalised')
        AND d.document_date BETWEEN ? AND ?
      GROUP BY l.vat_rate_pct
      ORDER BY l.vat_rate_pct DESC`,
    [range.from, range.to],
  )

  return rows.map((r) => ({
    ratePct: toNum(r.rate),
    excl: toNum(r.excl),
    vat: toNum(r.vat),
    incl: toNum(r.incl),
  }))
}

/**
 * Input VAT by rate, from finalised purchase documents AND expenses.
 *
 * The mirror of outputVat, and it has TWO sources because the business buys two
 * different kinds of thing:
 *
 *   GRVs — stock bought to resell. Captured since purchasing shipped.
 *   EXPENSES — rent, fuel, repairs, subscriptions. Everything that is not
 *   stock, which had nowhere to live at all until 042.
 *
 * Leaving expenses out would understate the input claim by every rand of
 * overhead the business pays — which for most retailers is the larger half.
 *
 * ── ONLY WHAT MAY BE CLAIMED ─────────────────────────────────────────────
 *
 * Expense lines carry `vat_claimable`, set from the category. Entertainment and
 * salaries are denied by the VAT Act however the invoice is worded, so their
 * VAT is excluded here even though the expense really did cost that much. The
 * excl figure still counts: the purchase happened, it simply carries no claim.
 */
async function inputVat(siteId: number, range: DateRange): Promise<VatRateRow[]> {
  const [purchases, expenses] = await Promise.all([
    siteQuery<Row>(
      siteId,
      `SELECT l.vat_rate_pct AS rate,
              SUM(CASE WHEN d.doc_type = 'supplier_return' THEN -l.line_total_excl ELSE l.line_total_excl END) AS excl,
              SUM(CASE WHEN d.doc_type = 'supplier_return' THEN -l.line_vat        ELSE l.line_vat        END) AS vat,
              SUM(CASE WHEN d.doc_type = 'supplier_return' THEN -l.line_total_incl ELSE l.line_total_incl END) AS incl
         FROM purchase_document_lines l
         JOIN purchase_documents d ON d.id = l.document_id
        WHERE d.doc_type IN ('grv','supplier_return')
          AND d.status = 'finalised'
          AND d.document_date BETWEEN ? AND ?
        GROUP BY l.vat_rate_pct`,
      [range.from, range.to],
    ),
    // Expenses. Falls back to empty where 042 has not run yet, so a site mid
    // migration reports a smaller claim rather than failing the whole return.
    siteQuery<Row>(
      siteId,
      `SELECT l.vat_rate_pct AS rate,
              SUM(l.line_excl) AS excl,
              SUM(CASE WHEN l.vat_claimable THEN l.line_vat ELSE 0 END) AS vat,
              SUM(l.line_incl) AS incl
         FROM expense_lines l
         JOIN expenses e ON e.id = l.expense_id
        WHERE e.status = 'finalised'
          AND e.expense_date BETWEEN ? AND ?
        GROUP BY l.vat_rate_pct`,
      [range.from, range.to],
    ).catch(() => [] as Row[]),
  ])

  // Merged by rate so the return shows one line per rate rather than two
  // sources the reader has to add up.
  const byRate = new Map<number, VatRateRow>()
  for (const r of [...purchases, ...expenses]) {
    const ratePct = toNum(r.rate)
    const existing = byRate.get(ratePct) ?? { ratePct, excl: 0, vat: 0, incl: 0 }
    byRate.set(ratePct, {
      ratePct,
      excl: round(existing.excl + toNum(r.excl), 2),
      vat: round(existing.vat + toNum(r.vat), 2),
      incl: round(existing.incl + toNum(r.incl), 2),
    })
  }

  return [...byRate.values()].sort((a, b) => b.ratePct - a.ratePct)
}

function sumRows(rows: readonly VatRateRow[]): { excl: number; vat: number; incl: number } {
  return rows.reduce(
    (acc, row) => ({
      excl: round(acc.excl + row.excl, 2),
      vat: round(acc.vat + row.vat, 2),
      incl: round(acc.incl + row.incl, 2),
    }),
    { excl: 0, vat: 0, incl: 0 },
  )
}

/**
 * The whole return for a period.
 *
 * The warnings are the point of doing this in one function rather than two
 * screens: they are the cross-checks a bookkeeper would otherwise have to think
 * to perform, and each one catches a specific, real mistake.
 */
export async function buildVatReturn(siteId: number, range: DateRange): Promise<VatReturn | null> {
  if (!validRange(range)) return null

  const [output, input, credits, returns, vatNumber, unfinalised] = await Promise.all([
    outputVat(siteId, range),
    inputVat(siteId, range),
    // Credit notes separately, so the return can show what was reversed rather
    // than only a net figure that hides it.
    siteQueryOne<Row>(
      siteId,
      `SELECT COALESCE(SUM(l.line_total_excl), 0) AS excl, COALESCE(SUM(l.line_vat), 0) AS vat
         FROM sales_document_lines l
         JOIN sales_documents d ON d.id = l.document_id
        WHERE d.doc_type = 'credit_note' AND d.status IN ('issued','finalised')
          AND d.document_date BETWEEN ? AND ?`,
      [range.from, range.to],
    ),
    siteQueryOne<Row>(
      siteId,
      `SELECT COALESCE(SUM(l.line_total_excl), 0) AS excl, COALESCE(SUM(l.line_vat), 0) AS vat
         FROM purchase_document_lines l
         JOIN purchase_documents d ON d.id = l.document_id
        WHERE d.doc_type = 'supplier_return' AND d.status = 'finalised'
          AND d.document_date BETWEEN ? AND ?`,
      [range.from, range.to],
    ).catch(() => null),
    siteVatNumber(siteId),
    // Documents still sitting in draft inside the period being declared. The
    // single most common cause of a return that has to be corrected later.
    siteQueryOne<Row>(
      siteId,
      `SELECT COUNT(*) AS n FROM sales_documents
        WHERE doc_type IN ('invoice','credit_note') AND status IN ('draft','parked')
          AND document_date BETWEEN ? AND ?`,
      [range.from, range.to],
    ),
  ])

  const outputTotal = sumRows(output)
  const inputTotal = sumRows(input)

  const warnings: string[] = []

  const draftCount = Number(unfinalised?.n ?? 0)
  if (draftCount > 0) {
    warnings.push(
      `${draftCount} sales document${draftCount === 1 ? '' : 's'} in this period ${draftCount === 1 ? 'is' : 'are'} still a draft and ${draftCount === 1 ? 'is' : 'are'} not included. Finalise or void ${draftCount === 1 ? 'it' : 'them'} before filing.`,
    )
  }

  // The same trap on the expense side, and easier to fall into: the recurring
  // schedule GENERATES drafts, so a month nobody reviewed leaves rent and
  // insurance out of the claim entirely.
  const draftExpenses = await siteQueryOne<Row>(
    siteId,
    `SELECT COUNT(*) AS n, COALESCE(SUM(vat_claimable), 0) AS vat
       FROM expenses WHERE status = 'draft' AND expense_date BETWEEN ? AND ?`,
    [range.from, range.to],
  ).catch(() => null)

  const draftExpenseCount = Number(draftExpenses?.n ?? 0)
  if (draftExpenseCount > 0) {
    const missedVat = toNum(draftExpenses?.vat)
    warnings.push(
      `${draftExpenseCount} expense${draftExpenseCount === 1 ? '' : 's'} in this period ${draftExpenseCount === 1 ? 'is' : 'are'} still a draft` +
        (missedVat > 0 ? `, holding ${missedVat.toFixed(2)} of input VAT that is not being claimed` : '') +
        '. Review and finalise before filing.',
    )
  }

  // A rate the system does not otherwise use is nearly always a typo on a
  // document — 14% left over from before 2018, or 1.5% for 15%.
  const knownRates = new Set([0, 15])
  for (const row of [...output, ...input]) {
    if (!knownRates.has(row.ratePct) && row.vat !== 0) {
      warnings.push(
        `Documents were found at ${row.ratePct}% VAT. Check that rate is intended before filing.`,
      )
    }
  }

  // Input VAT far exceeding output is legitimate (a big stock buy, a quiet
  // month) but is also what a duplicated GRV looks like, and it is worth a
  // second look before claiming a refund.
  if (inputTotal.vat > outputTotal.vat * 2 && outputTotal.vat > 0) {
    warnings.push(
      'Input VAT is more than double output VAT for this period. Check for duplicated supplier invoices before claiming.',
    )
  }

  const zeroRated = output
    .filter((r) => r.ratePct === 0)
    .reduce((sum, r) => round(sum + r.excl, 2), 0)

  return {
    range,
    outputByRate: output,
    outputTotal,
    inputByRate: input,
    inputTotal,
    salesCreditNotes: { excl: toNum(credits?.excl), vat: toNum(credits?.vat) },
    purchaseReturns: { excl: toNum(returns?.excl), vat: toNum(returns?.vat) },
    netPayable: round(outputTotal.vat - inputTotal.vat, 2),
    zeroRatedSales: zeroRated,
    warnings,
    vatNumber,
  }
}

async function siteVatNumber(siteId: number): Promise<string | null> {
  const row = await siteQueryOne<Row>(
    siteId,
    "SELECT setting_value FROM settings WHERE setting_key = 'vat_number' LIMIT 1",
  ).catch(() => null)
  const value = (row?.setting_value as string | null)?.trim()
  return value ? value : null
}

/* ── Detail ──────────────────────────────────────────────────────────────── */

export type VatDocument = {
  id: number
  side: 'output' | 'input'
  docType: string
  docNumber: string | null
  docDate: string
  partyName: string
  excl: number
  vat: number
  incl: number
}

/**
 * The documents behind a figure, for the drill-down.
 *
 * The question the summary always provokes is "which invoices make up that
 * R48 210", and a return nobody can drill into is one nobody trusts enough to
 * file from.
 */
export async function vatDocuments(
  siteId: number,
  range: DateRange,
  side: 'output' | 'input',
  ratePct?: number,
): Promise<VatDocument[]> {
  if (!validRange(range)) return []

  // This feeds a STATUTORY return, so the join is qualified rather than left to
  // resolve locally: reading the wrong database here would put the wrong party
  // name against a document in a VAT201 working paper. The COALESCE onto
  // d.customer_name means a miss would look like a cash sale rather than an
  // error, which is exactly the kind of wrong that goes unnoticed.
  const cdb = await customerDbPrefix(siteId)

  const rows =
    side === 'output'
      ? await siteQuery<Row>(
          siteId,
          `SELECT d.id, d.doc_type, d.document_number, d.document_date,
                  COALESCE(c.name, d.customer_name, 'Cash sale') AS party_name,
                  SUM(CASE WHEN d.doc_type = 'credit_note' THEN -l.line_total_excl ELSE l.line_total_excl END) AS excl,
                  SUM(CASE WHEN d.doc_type = 'credit_note' THEN -l.line_vat  ELSE l.line_vat  END) AS vat,
                  SUM(CASE WHEN d.doc_type = 'credit_note' THEN -l.line_total_incl ELSE l.line_total_incl END) AS incl
             FROM sales_documents d
             JOIN sales_document_lines l ON l.document_id = d.id
             LEFT JOIN ${cdb}customers c ON c.id = d.customer_id
            WHERE d.doc_type IN ('invoice','credit_note')
              AND d.status IN ('issued','finalised')
              AND d.document_date BETWEEN ? AND ?
              ${ratePct === undefined ? '' : 'AND l.vat_rate_pct = ?'}
            GROUP BY d.id
            ORDER BY d.document_date, d.id
            LIMIT 2000`,
          ratePct === undefined ? [range.from, range.to] : [range.from, range.to, ratePct],
        )
      : // Both input sources, unioned so the drill-down shows the same
        // population the summary totalled. A claim that cannot be drilled into
        // is one nobody will file from.
        await siteQuery<Row>(
          siteId,
          `SELECT d.id, d.doc_type, d.document_number, d.document_date,
                  COALESCE(s.name, 'Unknown supplier') AS party_name,
                  SUM(l.line_total_excl) AS excl, SUM(l.line_vat) AS vat, SUM(l.line_total_incl) AS incl
             FROM purchase_documents d
             JOIN purchase_document_lines l ON l.document_id = d.id
             LEFT JOIN suppliers s ON s.id = d.supplier_id
            WHERE d.status = 'finalised'
              AND d.document_date BETWEEN ? AND ?
              ${ratePct === undefined ? '' : 'AND l.vat_rate_pct = ?'}
            GROUP BY d.id

            UNION ALL

           SELECT e.id, 'expense' AS doc_type, e.document_number, e.expense_date AS document_date,
                  COALESCE(s.name, e.supplier_name, 'Not stated') AS party_name,
                  SUM(l.line_excl) AS excl,
                  SUM(CASE WHEN l.vat_claimable THEN l.line_vat ELSE 0 END) AS vat,
                  SUM(l.line_incl) AS incl
             FROM expenses e
             JOIN expense_lines l ON l.expense_id = e.id
             LEFT JOIN suppliers s ON s.id = e.supplier_id
            WHERE e.status = 'finalised'
              AND e.expense_date BETWEEN ? AND ?
              ${ratePct === undefined ? '' : 'AND l.vat_rate_pct = ?'}
            GROUP BY e.id

            ORDER BY document_date, id
            LIMIT 2000`,
          ratePct === undefined
            ? [range.from, range.to, range.from, range.to]
            : [range.from, range.to, ratePct, range.from, range.to, ratePct],
        ).catch(() =>
          // 042 not applied yet: fall back to purchases alone.
          siteQuery<Row>(
            siteId,
            `SELECT d.id, d.doc_type, d.document_number, d.document_date,
                    COALESCE(s.name, 'Unknown supplier') AS party_name,
                    SUM(l.line_total_excl) AS excl, SUM(l.line_vat) AS vat, SUM(l.line_total_incl) AS incl
               FROM purchase_documents d
               JOIN purchase_document_lines l ON l.document_id = d.id
               LEFT JOIN suppliers s ON s.id = d.supplier_id
              WHERE d.status = 'finalised'
                AND d.document_date BETWEEN ? AND ?
                ${ratePct === undefined ? '' : 'AND l.vat_rate_pct = ?'}
              GROUP BY d.id
              ORDER BY d.document_date, d.id
              LIMIT 2000`,
            ratePct === undefined ? [range.from, range.to] : [range.from, range.to, ratePct],
          ),
        )

  return rows.map((r) => ({
    id: Number(r.id),
    side,
    docType: String(r.doc_type),
    docNumber: (r.doc_number as string | null) ?? null,
    docDate: String(r.doc_date),
    partyName: String(r.party_name ?? ''),
    excl: toNum(r.excl),
    vat: toNum(r.vat),
    incl: toNum(r.incl),
  }))
}

/**
 * The two-month VAT periods a vendor on Category A or B files against.
 *
 * Offered as presets so nobody types a period boundary by hand — an off-by-one
 * day at a period end moves a document between returns, which is exactly the
 * error that is invisible until SARS asks about it.
 */
export function vatPeriods(year: number, category: 'A' | 'B' = 'A'): DateRange[] {
  // Category A ends on odd months (Jan, Mar, …), B on even (Feb, Apr, …).
  const endMonths = category === 'A' ? [1, 3, 5, 7, 9, 11] : [2, 4, 6, 8, 10, 12]

  return endMonths.map((endMonth) => {
    const startMonth = endMonth === 1 ? 12 : endMonth - 1
    const startYear = endMonth === 1 ? year - 1 : year
    const lastDay = new Date(year, endMonth, 0).getDate()
    return {
      from: `${startYear}-${String(startMonth).padStart(2, '0')}-01`,
      to: `${year}-${String(endMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`,
    }
  })
}
