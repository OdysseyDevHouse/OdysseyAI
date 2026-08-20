import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery } from '../siteDb'
import { round, toNum } from '../decimals'
import { getShift, shiftPosition } from './shifts'

/**
 * How one tender's expected figure was arrived at — transaction by transaction.
 *
 * ── THE QUESTION THIS ANSWERS ───────────────────────────────────────────────
 *
 * The cash-up board says Cash should hold R1 000.00. That figure is not one
 * table: it is the opening float, plus every cash tender on a finalised sale,
 * plus the pay-ins, less the payouts and the drops to the safe. Four sources
 * for one number, and nowhere in the product could a supervisor see them.
 *
 * So a variance was a dead end. "The drawer is R150 short" is where the
 * conversation stopped, because the only way to find the R150 payout somebody
 * forgot to record was to go and read four screens. This is those screens,
 * added up in the order they add up, under the figure they produce.
 *
 * ── WHY NOT A REPORT ────────────────────────────────────────────────────────
 *
 * The report builder answers "which rows match these filters" — one source, one
 * table, one shape. This is not that question. It is the AUDIT TRAIL OF AN
 * ARITHMETIC, and no single source can produce it: `sales_tenders` knows nothing
 * about the float, `shift_movements` knows nothing about lay-bys, and a report
 * that stitched them together would be a second place where the cash-up's
 * arithmetic is written down — free to drift from the one that signs it off.
 *
 * That is the discipline this file keeps, and it is enforced by construction
 * rather than by care:
 *
 *   THE RECONCILING SECTIONS MUST SUM TO THE TENDER'S `expected`.
 *
 * Each of those is a query over the SAME rows, with the SAME predicates, that
 * `shiftPosition` sums to produce that figure — they are the detail behind that
 * sum, not a second opinion about it. Change the expectation there and this
 * breaks loudly, which is the point: `reconciles` is computed, returned, and
 * asserted by test-cashup-breakdown. A silent disagreement between a total and
 * its own evidence is the one failure this must not have.
 *
 * ── OFF-LEDGER MONEY IS SHOWN, BUT DOES NOT RECONCILE ───────────────────────
 *
 * Lay-by deposits, deposits on a sale and loyalty top-ups are real cash in a
 * real drawer, and this lists them — a supervisor hunting R500 needs to see the
 * lay-by that explains it. They are NOT part of the per-tender expectation, and
 * that is a property of the product rather than a choice made here:
 *
 *   · `TenderDeclaration.expected` is takings + float + movements. Nothing else.
 *   · `ShiftPosition.expectedCash` — panel 3's "available to bank", and what
 *     `closeShift` records the variance against — adds `offLedgerTotal` on top.
 *
 * So the Cash row's Expected column and the drawer's real expectation already
 * differ by exactly this money on any shift that took a deposit. That gap is
 * pre-existing and is not this file's to close: quietly folding off-ledger cash
 * into one tender's expectation here would make the breakdown disagree with the
 * column it sits under, which is the failure it exists to prevent.
 *
 * What it does instead is SAY SO. Those sections are marked `informational`,
 * sit below the reconciling total under their own heading, and the drawer's
 * real expectation is published beside them. Somebody reading a short drawer
 * sees the deposit and the discrepancy together, which is the outcome that
 * matters.
 *
 * ── WHY IT IS NOT AVAILABLE TO A BLIND COUNT ────────────────────────────────
 *
 * Because it IS the expected figure, itemised. A cashier counting their own
 * drawer is shown no target — see visible.ts — and handing them a list that
 * adds up to it would defeat that entirely, whichever tender they had already
 * declared. The action layer gates this on `sales.cashup_expected`, the same
 * permission that decides whether the count was blind at all.
 */

type Row = RowDataPacket & Record<string, unknown>

/** One thing that happened, and what it did to the tender's total. */
export type BreakdownEntry = {
  /** When it happened. Wall-clock, ISO — read it back with getUTC*. */
  at: string | null
  /** What it was: a document number, a payout reason, a lay-by reference. */
  label: string
  /** Who it was for, where there is such a person. */
  party: string | null
  /** Who did it. */
  userName: string | null
  /** Signed, as it affects the total. A payout is negative. */
  amount: number
  /** A document number to quote, where the entry has one. */
  documentNumber: string | null
}

/** A group of entries that add to one line of the arithmetic. */
export type BreakdownSection = {
  key: string
  title: string
  /**
   * What this section is, in a sentence — shown under the heading.
   *
   * Written for the person asking "why is my drawer short", not for a
   * developer: it says which real-world event puts a row here.
   */
  hint: string
  entries: BreakdownEntry[]
  /** Σ entries.amount, rounded once. */
  subtotal: number
  /**
   * Real money that is NOT part of this tender's expected figure.
   *
   * Excluded from the reconciling total and rendered below it. See the
   * off-ledger note at the top of this file for why such a thing exists.
   */
  informational: boolean
}

export type TenderBreakdown = {
  tenderTypeId: number
  tenderName: string
  countsAsDrawerCash: boolean
  /** The figure the board shows in the Expected column for this tender. */
  expected: number
  /** What was declared against it, or null while nobody has counted. */
  declared: number | null
  sections: BreakdownSection[]
  /** Σ the reconciling sections. Equals `expected` unless something drifted. */
  total: number
  /**
   * Whether the evidence adds up to the headline.
   *
   * Returned rather than merely asserted, because the honest thing to do when
   * it is false is to SAY SO on screen. A breakdown quietly missing R40 is
   * worse than no breakdown: it sends somebody looking for a theft that is
   * really a source this file has not been taught about.
   */
  reconciles: boolean
  /**
   * Off-ledger cash on this shift that arrived on THIS tender, in total.
   *
   * Zero for every tender on most shifts. Non-zero is the amount by which the
   * drawer's real expectation exceeds the Expected column beside it.
   */
  offLedgerTotal: number
  /**
   * What the DRAWER should hold, off-ledger money included — `expectedCash`.
   *
   * Only meaningful on the drawer-cash tender; null on any other, where the
   * question does not arise because the bank settles it.
   */
  drawerExpected: number | null
}

/**
 * The whole arithmetic behind one tender on one shift.
 *
 * @param declared What the count claims, threaded through so the screen can put
 *   the difference at the foot of the evidence rather than making somebody
 *   carry it back from the board.
 * @returns null when the shift does not exist, or when the tender is not one
 *   this shift took — a caller asking about the wrong thing, rather than a
 *   tender that merely has nothing to show.
 */
export async function tenderBreakdown(
  siteId: number,
  shiftId: number,
  tenderTypeId: number,
  declared: number | null = null,
): Promise<TenderBreakdown | null> {
  const shift = await getShift(siteId, shiftId)
  if (!shift) return null

  const position = await shiftPosition(siteId, shiftId)
  if (!position) return null

  const tender = position.tenders.find((t) => t.tenderTypeId === tenderTypeId)
  if (!tender) return null

  const isCash = tender.countsAsDrawerCash

  const [sales, movements, laybys, deposits, loyalty] = await Promise.all([
    /*
     * The sale tenders themselves.
     *
     * `amount - change_given`, and `status = 'finalised'`, both exactly as
     * shiftPosition sums them. The net is what matters: a R500 note against a
     * R430 sale puts R430 in the drawer, and listing the R500 would have this
     * section overshoot by the change every time somebody paid with a big note.
     */
    siteQuery<Row>(
      siteId,
      `SELECT t.amount, t.change_given, t.reference,
              d.document_number, d.customer_name, d.user_name, t.created_at
         FROM sales_tenders t
         JOIN sales_documents d ON d.id = t.document_id
        WHERE d.shift_id = ? AND d.status = 'finalised' AND t.tender_type_id = ?
        ORDER BY t.created_at, t.id`,
      [shiftId, tenderTypeId],
    ),
    /*
     * Drawer movements — but ONLY for a drawer-cash tender.
     *
     * A payout takes notes out of the drawer. It has no tender type of its own
     * and it cannot: money paid out for milk is cash by definition. So these
     * rows belong to whichever tender counts as drawer cash, and to no other —
     * a card total is settled by the bank and no payout ever touched it. This
     * is the same split `declarationView` makes with `movementsIncluded`.
     */
    isCash
      ? siteQuery<Row>(
          siteId,
          `SELECT movement_type, amount, reason, user_name, created_at
             FROM shift_movements WHERE shift_id = ?
            ORDER BY created_at, id`,
          [shiftId],
        )
      : Promise.resolve([] as Row[]),
    /*
     * Lay-by money, joined to the customer it belongs to.
     *
     * Scoped by `tender_type_id`, so this works for a card tender too: a lay-by
     * instalment paid by card is on the card machine's own slip and belongs in
     * the card breakdown, exactly as a cash one belongs in this drawer.
     *
     * `deposit` and `instalment` only — the two kinds `offLedgerCash` counts. A
     * refund or a forfeit is not money arriving.
     */
    siteQuery<Row>(
      siteId,
      `SELECT p.kind, p.amount, p.reference, p.user_name, p.created_at,
              l.document_number AS layby_number, c.name AS customer_name
         FROM layby_payments p
         LEFT JOIN laybys    l ON l.id = p.layby_id
         LEFT JOIN customers c ON c.id = l.customer_id
        WHERE p.shift_id = ? AND p.tender_type_id = ?
          AND p.kind IN ('deposit', 'instalment')
        ORDER BY p.created_at, p.id`,
      [shiftId, tenderTypeId],
    ),
    /*
     * Deposits taken against a sale, quote or invoice.
     *
     * 'applied' is excluded for the reason declarationView gives: applying a
     * deposit moves no money, it hands the drawer's own cash to a sale that is
     * posting now and recording its own tender. Refunds ARE included, with
     * their stored negative amount, because handing a deposit back does take
     * notes out of the drawer.
     */
    siteQuery<Row>(
      siteId,
      `SELECT s.kind, s.amount, s.reference, s.user_name, s.created_at,
              d.document_number, d.customer_name
         FROM sale_deposits s
         LEFT JOIN sales_documents d ON d.id = s.document_id
        WHERE s.shift_id = ? AND s.tender_type_id = ?
          AND s.kind IN ('deposit', 'refund')
        ORDER BY s.created_at, s.id`,
      [shiftId, tenderTypeId],
    ),
    /*
     * Loyalty wallet top-ups.
     *
     * Top-ups alone. A wallet SPEND is a tender on a sale and is already a
     * sales_tenders row above; counting it here would report the same money
     * twice, which is the note offLedgerCash makes for the same reason.
     */
    siteQuery<Row>(
      siteId,
      `SELECT w.amount, w.note, w.user_name, w.created_at, w.document_number,
              c.name AS customer_name
         FROM loyalty_wallet w
         LEFT JOIN customers c ON c.id = w.customer_id
        WHERE w.shift_id = ? AND w.tender_type_id = ? AND w.entry_type = 'topup'
        ORDER BY w.created_at, w.id`,
      [shiftId, tenderTypeId],
    ),
  ])

  const sections: BreakdownSection[] = []

  /*
   * The float leads, because it is where the drawer started.
   *
   * A section rather than a note above the table: it is a term in the sum, and
   * every term has to be a row or the subtotals do not add to the headline.
   * Only the drawer tender has one — declarationView attaches `floatIncluded`
   * to the cash tender alone, and a card total starts at nothing.
   */
  if (isCash && position.openingFloat !== 0) {
    sections.push(
      section('float', 'Opening float', 'The change the drawer started with. Counted, never sold.', [
        {
          at: shift.openedAt ? wallClock(shift.openedAt) : null,
          label: 'Float at open',
          party: null,
          userName: shift.userName || null,
          amount: position.openingFloat,
          documentNumber: null,
        },
      ]),
    )
  }

  sections.push(
    section(
      'sales',
      'Sales',
      'Every finalised sale that took this tender, net of any change given back.',
      sales.map((r) => ({
        at: wallClock(r.created_at),
        label: text(r.document_number) ?? 'Sale',
        party: text(r.customer_name),
        userName: text(r.user_name),
        amount: round(toNum(r.amount) - toNum(r.change_given), 2),
        documentNumber: text(r.document_number),
      })),
    ),
  )

  /* Split by direction rather than one "movements" pile. A supervisor reads a
     payout and a pay-in as different events — one is an errand, the other is
     change fetched from the safe — and a net figure answers neither. */
  if (isCash) {
    const asEntry = (r: Row): BreakdownEntry => ({
      at: wallClock(r.created_at),
      label: text(r.reason) ?? 'No reason recorded',
      party: null,
      userName: text(r.user_name),
      /* Already signed in the table — see recordDrawerMovement, which stores a
         payout negative so the drawer position stays a plain SUM. Re-signing it
         here would turn every payout back into money coming in. */
      amount: toNum(r.amount),
      documentNumber: null,
    })
    const byType = (type: string) =>
      movements.filter((r) => String(r.movement_type) === type).map(asEntry)

    sections.push(
      section(
        'payins',
        'Pay-ins',
        'Money added that was not a sale — change fetched from the safe, a float top-up.',
        byType('payin'),
      ),
      section(
        'payouts',
        'Payouts',
        'Money taken out for an expense. This is the line that most often explains a short drawer.',
        byType('payout'),
      ),
      section(
        'drops',
        'Drops to the safe',
        'Cash moved out mid-shift for safekeeping. It left the drawer, so it is not counted in it.',
        byType('drop'),
      ),
    )
  }

  /* ── Below the line: real money, outside this tender's expectation ──────── */

  sections.push(
    section(
      'laybys',
      'Lay-by deposits and instalments',
      'Money taken against goods nobody has bought yet. No sale posts, but the money is here.',
      laybys.map((r) => ({
        at: wallClock(r.created_at),
        label: `${text(r.layby_number) ?? 'Lay-by'} · ${
          r.kind === 'deposit' ? 'deposit' : 'instalment'
        }`,
        party: text(r.customer_name),
        userName: text(r.user_name),
        amount: toNum(r.amount),
        documentNumber: null,
      })),
      true,
    ),
    section(
      'deposits',
      'Deposits on sales and quotes',
      'Money held against a document that has not posted. A refund here gave money back.',
      deposits.map((r) => ({
        at: wallClock(r.created_at),
        label: `${text(r.document_number) ?? 'Deposit'}${r.kind === 'refund' ? ' · refunded' : ''}`,
        party: text(r.customer_name),
        userName: text(r.user_name),
        /* Stored signed: a refund row is already negative. */
        amount: toNum(r.amount),
        documentNumber: text(r.document_number),
      })),
      true,
    ),
    section(
      'loyalty',
      'Loyalty top-ups',
      'Money loaded onto a customer wallet. It arrives now; it is spent on some later sale.',
      loyalty.map((r) => ({
        at: wallClock(r.created_at),
        label: text(r.note) ?? 'Wallet top-up',
        party: text(r.customer_name),
        userName: text(r.user_name),
        amount: toNum(r.amount),
        documentNumber: text(r.document_number),
      })),
      true,
    ),
  )

  /* Empty sections are dropped AFTER the arithmetic rather than skipped before
     it: a shop with no lay-bys should not read a row of zeros, but the code
     that decides what is SHOWN must not be the code that decides what COUNTS. */
  const shown = sections.filter((s) => s.entries.length > 0)

  const total = round(
    sections.filter((s) => !s.informational).reduce((sum, s) => round(sum + s.subtotal, 2), 0),
    2,
  )
  const offLedgerTotal = round(
    sections.filter((s) => s.informational).reduce((sum, s) => round(sum + s.subtotal, 2), 0),
    2,
  )

  /*
   * The board's own figure, rebuilt the way declarationView rebuilds it.
   *
   * `ShiftPosition.tenders[].expected` is TAKINGS ONLY, despite the name — it
   * is the raw `SUM(amount - change_given)` off sales_tenders, and
   * declarationView renames it to `takings` on the way past before adding the
   * float and the movements to produce the column this screen shows. So the
   * same two terms are added here, on the drawer tender alone, for the same
   * reason they are added there.
   *
   * Derived from the position rather than from the sections above, so the
   * comparison below is between two independently reached numbers and is
   * therefore worth making at all.
   */
  const expected = round(
    tender.expected + (isCash ? position.openingFloat + position.movementsTotal : 0),
    2,
  )

  return {
    tenderTypeId,
    tenderName: tender.tenderName,
    countsAsDrawerCash: isCash,
    expected,
    declared,
    sections: shown,
    total,
    /* Cents, not exact equality. Every figure here is rounded to 2dp on the way
       out of DECIMAL(12,4), and demanding bit-equality of two independently
       rounded sums would fail on arithmetic that is in fact correct. */
    reconciles: Math.abs(total - expected) < 0.005,
    offLedgerTotal,
    drawerExpected: isCash ? position.expectedCash : null,
  }
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

function section(
  key: string,
  title: string,
  hint: string,
  entries: BreakdownEntry[],
  informational = false,
): BreakdownSection {
  return {
    key,
    title,
    hint,
    entries,
    subtotal: round(
      entries.reduce((sum, e) => round(sum + e.amount, 2), 0),
      2,
    ),
    informational,
  }
}

/** A nullable string column, as a string or null — never the word "null". */
function text(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const s = String(value).trim()
  return s === '' ? null : s
}

/**
 * A DATETIME column as an ISO string.
 *
 * The pool runs at timezone 'Z', so the driver's Date already holds the stored
 * wall-clock reading in its UTC fields — `toISOString` hands it back unchanged,
 * and the browser must read it with getUTC* rather than the local getters.
 * Doing anything cleverer here is how this codebase has produced NaN before.
 */
function wallClock(value: unknown): string | null {
  if (!(value instanceof Date)) return null
  return Number.isNaN(value.getTime()) ? null : value.toISOString()
}
