import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute, siteTransaction } from '../siteDb'
import { round, toNum } from '../decimals'
import { getNumericSetting } from './settings'
import { cashupMode, getShift, shiftPosition } from './shifts'
import type { Actor } from './activityLog'

/**
 * The detailed cash declaration.
 *
 * shifts.ts answers "what should be in the drawer". This answers the wider
 * question a supervisor signs off: what was physically counted, note by note;
 * what each card machine's own slip reported; what was refunded, voided, tipped,
 * paid out and rounded away; and what went to the bank.
 *
 * ── ONE FUNCTION BUILDS THE WHOLE PICTURE ───────────────────────────────────
 *
 * `declarationView` derives every figure on the screen in one place. That is the
 * point: the live screen and the frozen record are computed from the same code,
 * so a figure cannot be shown one way while being signed off another. Freezing
 * (below) copies those numbers rather than recomputing them differently.
 *
 * ── THE COUNT IS STILL BLIND ────────────────────────────────────────────────
 *
 * Expected figures live here, on the server, and the ACTION layer decides what
 * reaches the browser — a cashier who can see the target is copying, not
 * counting. The screen reveals a tender's expected figure only once a number has
 * been committed for it. See the actions file for where that line is drawn.
 */

/* ── Denominations ─────────────────────────────────────────────────────────── */

export type Denomination = {
  id: number
  label: string
  value: number
  isNote: boolean
  position: number
  isActive: boolean
}

type Row = RowDataPacket & Record<string, unknown>

function mapDenomination(r: Row): Denomination {
  return {
    id: Number(r.id),
    label: String(r.label),
    value: toNum(r.value),
    isNote: !!r.is_note,
    position: Number(r.position),
    isActive: !!r.is_active,
  }
}

export async function listDenominations(
  siteId: number,
  includeInactive = false,
): Promise<Denomination[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT id, label, value, is_note, position, is_active
       FROM cash_denominations
      ${includeInactive ? '' : 'WHERE is_active = 1'}
      ORDER BY position ASC, value DESC`,
  )
  return rows.map(mapDenomination)
}

/* ── The view ──────────────────────────────────────────────────────────────── */

/** One tender's line on the declaration. */
export type TenderDeclaration = {
  tenderTypeId: number
  tenderCode: string
  tenderName: string
  countsAsDrawerCash: boolean
  /** Net of change given and refunds — what was actually taken on this method. */
  takings: number
  /** Float and drawer movements folded in. Non-zero only for drawer cash. */
  floatIncluded: number
  movementsIncluded: number
  /** takings + float + movements. What this tender should declare. */
  expected: number
  /** What the person typed, or null while uncounted. */
  declared: number | null
  transactionCount: number
}

export type CountedDenomination = {
  denominationId: number
  label: string
  value: number
  qty: number
  amount: number
}

/** The counters panel — every figure a legacy cash-up reports beside the money. */
export type DeclarationCounters = {
  salesCount: number
  voidedSales: number
  refundCount: number
  payoutCount: number
  /** Sales whose ONLY tender was this kind. Not the same as tender rows. */
  cashSales: number
  cardSales: number
  accountSales: number
}

export type DeclarationView = {
  shiftId: number
  declarationId: number | null
  mode: 'terminal' | 'user'
  /** Whose takings these are — a person, or the till, per the site's mode. */
  ownerLabel: string
  terminalCode: string | null
  userName: string
  supervisorName: string
  openedAt: Date
  finalizedAt: Date | null
  printCount: number

  openingFloat: number
  tenders: TenderDeclaration[]
  denominations: Denomination[]
  counted: CountedDenomination[]

  /** Sum of the counted grid. The auditable half of the cash count. */
  declaredCash: number
  expectedCash: number

  payoutsTotal: number
  payinsTotal: number
  dropsTotal: number
  refundsTotal: number
  roundingTotal: number
  tipsTotal: number

  laybyDeposits: number
  laybyPayments: number
  /** Deposits taken against a sale, quote or invoice during this shift (172). */
  saleDepositsTaken: number
  /** Deposits handed back during this shift. */
  saleDepositsRefunded: number
  giftCardSold: number
  giftCardRedeemed: number
  loyaltyWallet: number

  bankDeclared: number
  bankExpected: number
  bankReference: string | null

  counters: DeclarationCounters
  varianceNote: string | null
  note: string | null
  tolerance: number
}

/**
 * Everything the declaration screen shows, for one shift.
 *
 * Every figure keys on `shift_id`, which is what makes this work identically in
 * both cash-up modes — the shift already knows whether it owns a till or a
 * person, and nothing below needs to care.
 */
export async function declarationView(
  siteId: number,
  shiftId: number,
): Promise<DeclarationView | null> {
  const shift = await getShift(siteId, shiftId)
  if (!shift) return null

  const position = await shiftPosition(siteId, shiftId)
  if (!position) return null

  const [
    header,
    denominations,
    counted,
    movements,
    docTotals,
    tips,
    laybys,
    saleDeposits,
    giftCards,
    loyalty,
    tenderOnly,
    mode,
    tolerance,
  ] = await Promise.all([
    siteQueryOne<Row>(
      siteId,
      `SELECT id, supervisor_name, user_name, bank_declared, bank_expected, bank_reference,
              variance_note, note, finalized_at, print_count
         FROM shift_declarations WHERE shift_id = ? LIMIT 1`,
      [shiftId],
    ),
    listDenominations(siteId),
    siteQuery<Row>(
      siteId,
      `SELECT d.denomination_id, d.label, d.value, d.qty, d.amount
         FROM shift_count_denominations d
         JOIN shift_declarations s ON s.id = d.declaration_id
        WHERE s.shift_id = ?
        ORDER BY d.value DESC`,
      [shiftId],
    ),
    // Split by direction: the report shows payouts and pay-ins as separate
    // lines, and a signed total cannot say which was which.
    siteQueryOne<Row>(
      siteId,
      `SELECT
         COALESCE(SUM(CASE WHEN movement_type = 'payout' THEN ABS(amount) END), 0) AS payouts,
         COALESCE(SUM(CASE WHEN movement_type = 'payin'  THEN ABS(amount) END), 0) AS payins,
         COALESCE(SUM(CASE WHEN movement_type = 'drop'   THEN ABS(amount) END), 0) AS drops,
         COUNT(*) AS n
       FROM shift_movements WHERE shift_id = ?`,
      [shiftId],
    ),
    /*
     * Refunds, rounding and the void count, in one pass over the shift's
     * documents.
     *
     * `rounding_adj` is the interesting one: it has been written on every sale
     * since 015 and never once read back. It is the 5c the drawer legitimately
     * does not hold, and without it a shop rounding all day looks short by the
     * accumulated cents with nothing to point at.
     */
    siteQueryOne<Row>(
      siteId,
      `SELECT
         COALESCE(SUM(CASE WHEN doc_type = 'credit_sale' AND status = 'finalised'
                           THEN ABS(total_incl) END), 0)                       AS refunds,
         SUM(CASE WHEN doc_type = 'credit_sale' AND status = 'finalised'
                  THEN 1 ELSE 0 END)                                           AS refund_count,
         COALESCE(SUM(CASE WHEN status = 'finalised' THEN rounding_adj END), 0) AS rounding,
         SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END)                  AS voided,
         SUM(CASE WHEN doc_type = 'invoice' AND status = 'finalised'
                  THEN 1 ELSE 0 END)                                           AS invoices
       FROM sales_documents WHERE shift_id = ?`,
      [shiftId],
    ),
    siteQueryOne<Row>(
      siteId,
      'SELECT COALESCE(SUM(amount), 0) AS total FROM sales_tips WHERE shift_id = ?',
      [shiftId],
    ),
    siteQueryOne<Row>(
      siteId,
      `SELECT
         COALESCE(SUM(CASE WHEN kind = 'deposit'    THEN amount END), 0) AS deposits,
         COALESCE(SUM(CASE WHEN kind = 'instalment' THEN amount END), 0) AS instalments
       FROM layby_payments WHERE shift_id = ?`,
      [shiftId],
    ),
    /*
     * Deposits taken against a sale, quote or invoice (172).
     *
     * Same shape and same reason as the lay-by line above: the money went
     * through the drawer even though no sale has posted, so a shift that took
     * deposits counts short by exactly them without this.
     *
     * 'applied' rows are excluded deliberately. Applying a deposit moves no
     * cash — it hands money already in the drawer to a sale that is posting
     * now, and that sale records its own tender. Counting both would report
     * the same note twice.
     */
    siteQueryOne<Row>(
      siteId,
      `SELECT
         COALESCE(SUM(CASE WHEN kind = 'deposit' THEN amount END), 0)      AS taken,
         COALESCE(SUM(CASE WHEN kind = 'refund'  THEN ABS(amount) END), 0) AS refunded
       FROM sale_deposits WHERE shift_id = ?`,
      [shiftId],
    ),
    siteQueryOne<Row>(
      siteId,
      `SELECT
         COALESCE(SUM(CASE WHEN entry_type IN ('activation','reload') THEN amount END), 0) AS sold,
         COALESCE(SUM(CASE WHEN entry_type = 'redeem' THEN ABS(amount) END), 0)            AS redeemed
       FROM gift_card_events WHERE shift_id = ?`,
      [shiftId],
    ),
    siteQueryOne<Row>(
      siteId,
      `SELECT COALESCE(SUM(CASE WHEN entry_type = 'topup' THEN amount END), 0) AS topups
         FROM loyalty_wallet WHERE shift_id = ?`,
      [shiftId],
    ),
    /*
     * Sales paid by ONE method only.
     *
     * Deliberately different from the per-tender transaction counts. A split
     * sale (R50 cash, R50 card) puts a row under each, so those counts sum to
     * more than the number of sales — which is right for reconciling money and
     * wrong for the question "how many cash sales were there". The HAVING
     * clause is what makes this the second question rather than the first.
     */
    siteQuery<Row>(
      siteId,
      `SELECT tt.code, COUNT(*) AS n FROM (
         SELECT t.document_id, MIN(t.tender_type_id) AS tender_type_id
           FROM sales_tenders t
           JOIN sales_documents d ON d.id = t.document_id
          WHERE d.shift_id = ? AND d.status = 'finalised'
          GROUP BY t.document_id
         HAVING COUNT(DISTINCT t.tender_type_id) = 1
       ) one
       JOIN tender_types tt ON tt.id = one.tender_type_id
       GROUP BY tt.code`,
      [shiftId],
    ),
    cashupMode(siteId),
    getNumericSetting(siteId, 'cashup_variance_tolerance'),
  ])

  const declaredByTender = new Map<number, number>()
  if (header) {
    const rows = await siteQuery<Row>(
      siteId,
      'SELECT tender_type_id, counted FROM shift_counts WHERE shift_id = ?',
      [shiftId],
    )
    for (const row of rows) {
      declaredByTender.set(Number(row.tender_type_id), toNum(row.counted))
    }
  }

  const movementsTotal = position.movementsTotal

  const tenders: TenderDeclaration[] = position.tenders.map((t) => {
    // Cash carries the float and the drawer movements; card and EFT are settled
    // by the bank, so they reconcile against what was rung up alone.
    const floatIncluded = t.countsAsDrawerCash ? position.openingFloat : 0
    const movementsIncluded = t.countsAsDrawerCash ? movementsTotal : 0
    return {
      tenderTypeId: t.tenderTypeId,
      tenderCode: t.tenderCode,
      tenderName: t.tenderName,
      countsAsDrawerCash: t.countsAsDrawerCash,
      takings: t.expected,
      floatIncluded,
      movementsIncluded,
      expected: round(t.expected + floatIncluded + movementsIncluded, 2),
      declared: declaredByTender.get(t.tenderTypeId) ?? null,
      transactionCount: t.transactionCount,
    }
  })

  const countedRows: CountedDenomination[] = counted.map((r) => ({
    denominationId: Number(r.denomination_id),
    label: String(r.label),
    value: toNum(r.value),
    qty: Number(r.qty),
    amount: toNum(r.amount),
  }))

  const declaredCash = countedRows.reduce((sum, r) => round(sum + r.amount, 2), 0)

  const byCode = new Map(tenderOnly.map((r) => [String(r.code), Number(r.n)]))

  return {
    shiftId,
    declarationId: header ? Number(header.id) : null,
    mode,
    ownerLabel: mode === 'terminal' ? (shift.terminalCode ?? 'Till') : shift.userName,
    terminalCode: shift.terminalCode,
    userName: String(header?.user_name || shift.userName),
    supervisorName: String(header?.supervisor_name ?? ''),
    openedAt: shift.openedAt,
    finalizedAt: (header?.finalized_at as Date | null) ?? null,
    printCount: Number(header?.print_count ?? 0),

    openingFloat: position.openingFloat,
    tenders,
    denominations,
    counted: countedRows,

    declaredCash,
    expectedCash: position.expectedCash,

    payoutsTotal: toNum(movements?.payouts),
    payinsTotal: toNum(movements?.payins),
    dropsTotal: toNum(movements?.drops),
    refundsTotal: toNum(docTotals?.refunds),
    roundingTotal: toNum(docTotals?.rounding),
    tipsTotal: toNum(tips?.total),

    laybyDeposits: toNum(laybys?.deposits),
    saleDepositsTaken: toNum(saleDeposits?.taken),
    saleDepositsRefunded: toNum(saleDeposits?.refunded),
    laybyPayments: toNum(laybys?.instalments),
    giftCardSold: toNum(giftCards?.sold),
    giftCardRedeemed: toNum(giftCards?.redeemed),
    loyaltyWallet: toNum(loyalty?.topups),

    bankDeclared: toNum(header?.bank_declared),
    /* What the drawer can actually send: counted cash less the float that has to
       stay behind for tomorrow. A shop that banks its float has no change on
       Monday morning. */
    bankExpected: round(Math.max(position.expectedCash - position.openingFloat, 0), 2),
    bankReference: (header?.bank_reference as string | null) ?? null,

    counters: {
      salesCount: position.salesCount,
      voidedSales: Number(docTotals?.voided ?? 0),
      refundCount: Number(docTotals?.refund_count ?? 0),
      payoutCount: Number(movements?.n ?? 0),
      cashSales: byCode.get('CASH') ?? 0,
      cardSales: byCode.get('CARD') ?? 0,
      accountSales: byCode.get('ACCOUNT') ?? 0,
    },
    varianceNote: (header?.variance_note as string | null) ?? null,
    note: (header?.note as string | null) ?? null,
    tolerance,
  }
}

/* ── Saving a draft ────────────────────────────────────────────────────────── */

export type DeclarationInput = {
  supervisorId: number | null
  supervisorName: string
  /** Quantity per denomination id. Absent ids count as zero. */
  denominations: Record<number, number>
  /** Declared amount per tender type id. */
  tenders: Record<number, number>
  bankDeclared: number
  bankReference: string | null
  varianceNote: string | null
  note: string | null
}

export type SaveResult = { ok: true; declarationId: number } | { ok: false; error: string }

/**
 * Creates or revises the draft.
 *
 * UPSERT on the shift, because a declaration is counted over minutes rather than
 * submitted in one act — somebody counts, pre-prints, finds they miscounted the
 * R20s, and counts again. A second row per shift would let two rival counts
 * exist, either of which could then be finalized.
 *
 * Refuses once finalized. A signed cash-up is a record, not a draft, and the way
 * to change one is a fresh shift rather than a quiet edit.
 */
export async function saveDeclaration(
  siteId: number,
  actor: Actor,
  shiftId: number,
  input: DeclarationInput,
): Promise<SaveResult> {
  const shift = await getShift(siteId, shiftId)
  if (!shift) return { ok: false, error: 'That shift no longer exists.' }

  const existing = await siteQueryOne<Row>(
    siteId,
    'SELECT id, finalized_at FROM shift_declarations WHERE shift_id = ? LIMIT 1',
    [shiftId],
  )
  if (existing?.finalized_at) {
    return { ok: false, error: 'This cash-up has been signed off and can no longer be changed.' }
  }

  const denominations = await listDenominations(siteId, true)
  const byId = new Map(denominations.map((d) => [d.id, d]))

  let declaredCash = 0
  const countRows: { id: number; label: string; value: number; qty: number; amount: number }[] = []
  for (const [rawId, rawQty] of Object.entries(input.denominations)) {
    const denomination = byId.get(Number(rawId))
    if (!denomination) continue
    const qty = Math.max(0, Math.floor(Number(rawQty) || 0))
    if (qty === 0) continue
    const amount = round(denomination.value * qty, 2)
    declaredCash = round(declaredCash + amount, 2)
    countRows.push({
      id: denomination.id,
      label: denomination.label,
      value: denomination.value,
      qty,
      amount,
    })
  }

  const view = await declarationView(siteId, shiftId)
  if (!view) return { ok: false, error: 'That shift no longer exists.' }

  const declarationId = await siteTransaction(siteId, async (tx) => {
    await tx.execute(
      `INSERT INTO shift_declarations
         (shift_id, user_id, user_name, supervisor_id, supervisor_name,
          declared_cash, expected_cash, opening_float, bank_declared, bank_expected,
          bank_reference, variance_note, note)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         supervisor_id  = VALUES(supervisor_id),
         supervisor_name = VALUES(supervisor_name),
         declared_cash  = VALUES(declared_cash),
         expected_cash  = VALUES(expected_cash),
         opening_float  = VALUES(opening_float),
         bank_declared  = VALUES(bank_declared),
         bank_expected  = VALUES(bank_expected),
         bank_reference = VALUES(bank_reference),
         variance_note  = VALUES(variance_note),
         note           = VALUES(note)`,
      [
        shiftId,
        shift.userId,
        shift.userName.slice(0, 120),
        input.supervisorId,
        input.supervisorName.slice(0, 120),
        declaredCash.toFixed(4),
        view.expectedCash.toFixed(4),
        view.openingFloat.toFixed(4),
        round(input.bankDeclared, 2).toFixed(4),
        view.bankExpected.toFixed(4),
        input.bankReference?.trim()?.slice(0, 60) || null,
        input.varianceNote?.trim()?.slice(0, 400) || null,
        input.note?.trim()?.slice(0, 400) || null,
      ] as never,
    )

    /* Re-read rather than trusting insertId: on the UPDATE branch of an upsert
       MySQL reports the id of the row it would have inserted, not the one it
       actually touched — so a revised draft would get a stranger's id. */
    const [rows] = await tx.query<Row[]>(
      'SELECT id FROM shift_declarations WHERE shift_id = ? LIMIT 1',
      [shiftId] as never,
    )
    const id = Number(rows[0].id)

    /* Replace rather than merge: a recount that finds FEWER R50s than the last
       one must remove the surplus, and an upsert per row would leave the old
       quantity sitting there for any denomination the new count omits. */
    await tx.execute('DELETE FROM shift_count_denominations WHERE declaration_id = ?', [
      id,
    ] as never)
    for (const r of countRows) {
      await tx.execute(
        `INSERT INTO shift_count_denominations
           (declaration_id, denomination_id, label, value, qty, amount)
         VALUES (?,?,?,?,?,?)`,
        [id, r.id, r.label, r.value.toFixed(4), r.qty, r.amount.toFixed(4)] as never,
      )
    }

    /* The per-tender declared figures land in shift_counts — the SAME table
       closeShift freezes into, so the draft and the signed record are one shape
       and finalizing is a matter of stamping it rather than copying it about. */
    for (const tender of view.tenders) {
      const declared = input.tenders[tender.tenderTypeId]
      if (declared === undefined) continue
      const amount = round(Number(declared) || 0, 2)
      await tx.execute(
        `INSERT INTO shift_counts
           (shift_id, declaration_id, tender_type_id, tender_code, tender_name,
            expected, counted, variance, transaction_count, float_included, movements_included)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE
           declaration_id = VALUES(declaration_id),
           expected  = VALUES(expected),
           counted   = VALUES(counted),
           variance  = VALUES(variance),
           transaction_count  = VALUES(transaction_count),
           float_included     = VALUES(float_included),
           movements_included = VALUES(movements_included)`,
        [
          shiftId,
          id,
          tender.tenderTypeId,
          tender.tenderCode,
          tender.tenderName,
          tender.expected.toFixed(4),
          amount.toFixed(4),
          round(amount - tender.expected, 2).toFixed(4),
          tender.transactionCount,
          tender.floatIncluded.toFixed(4),
          tender.movementsIncluded.toFixed(4),
        ] as never,
      )
    }

    return id
  })

  return { ok: true, declarationId }
}

/** Bumps the print counter. A count printed six times is worth seeing. */
export async function notePrint(siteId: number, shiftId: number): Promise<void> {
  await siteExecute(
    siteId,
    'UPDATE shift_declarations SET print_count = print_count + 1 WHERE shift_id = ?',
    [shiftId],
  )
}

/* ── Signing it off ────────────────────────────────────────────────────────── */

export type FinalizeResult =
  | { ok: true; variance: number; withinTolerance: boolean }
  | { ok: false; error: string }

/**
 * Freezes the declaration and closes the shift.
 *
 * Deliberately delegates the close to `closeShift` rather than updating `shifts`
 * itself. That function owns the tolerance rule, the frozen totals and the GL
 * mirror, and a second implementation here would be a second set of rules for
 * the same event — which is precisely how two reports come to disagree about
 * what a shift was short.
 *
 * So the order is: save the draft, then let closeShift do what it has always
 * done, then stamp the declaration as signed.
 */
export async function finalizeDeclaration(
  siteId: number,
  actor: Actor,
  shiftId: number,
  input: DeclarationInput,
): Promise<FinalizeResult> {
  const shift = await getShift(siteId, shiftId)
  if (!shift) return { ok: false, error: 'That shift no longer exists.' }
  if (!shift.isOpen) return { ok: false, error: 'That shift is already cashed up.' }

  if (!input.supervisorName.trim()) {
    return { ok: false, error: 'Name the supervisor who witnessed the count.' }
  }

  const saved = await saveDeclaration(siteId, actor, shiftId, input)
  if (!saved.ok) return saved

  const view = await declarationView(siteId, shiftId)
  if (!view) return { ok: false, error: 'That shift no longer exists.' }

  /*
   * Every tender must have been declared.
   *
   * A blank box is not a zero — it is a tender nobody counted, and letting it
   * through would sign off a cash-up that silently claims the card machine took
   * nothing. Refused by name so the cashier knows which one to go and count.
   */
  const missing = view.tenders.filter((t) => input.tenders[t.tenderTypeId] === undefined)
  if (missing.length > 0) {
    return {
      ok: false,
      error: `Declare every tender before signing off — ${missing.map((t) => t.tenderName).join(', ')} ${missing.length === 1 ? 'is' : 'are'} still blank.`,
    }
  }

  const { closeShift } = await import('./shifts')
  const result = await closeShift(
    siteId,
    actor,
    shiftId,
    view.tenders.map((t) => ({
      tenderTypeId: t.tenderTypeId,
      amount: input.tenders[t.tenderTypeId] ?? 0,
    })),
    input.varianceNote,
  )
  if (!result.ok) return result

  const declaredTotal = view.tenders.reduce(
    (sum, t) => round(sum + (input.tenders[t.tenderTypeId] ?? 0), 2),
    0,
  )
  const expectedTotal = view.tenders.reduce((sum, t) => round(sum + t.expected, 2), 0)

  await siteExecute(
    siteId,
    `UPDATE shift_declarations
        SET declared_total = ?, expected_total = ?, variance = ?,
            payouts_total = ?, payins_total = ?, drops_total = ?,
            refunds_total = ?, rounding_total = ?, tips_total = ?,
            finalized_at = NOW(), finalized_by_id = ?, finalized_by_name = ?
      WHERE shift_id = ?`,
    [
      declaredTotal.toFixed(4),
      expectedTotal.toFixed(4),
      round(declaredTotal - expectedTotal, 2).toFixed(4),
      view.payoutsTotal.toFixed(4),
      view.payinsTotal.toFixed(4),
      view.dropsTotal.toFixed(4),
      view.refundsTotal.toFixed(4),
      view.roundingTotal.toFixed(4),
      view.tipsTotal.toFixed(4),
      actor.userId,
      actor.userName.slice(0, 120),
      shiftId,
    ],
  )

  return result
}
