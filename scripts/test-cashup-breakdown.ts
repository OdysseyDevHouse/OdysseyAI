/**
 * How a tender's expected figure was reached — the drill-down behind the board.
 *
 * test-cashup-declaration.ts proves the declaration; this proves the EVIDENCE
 * under it. The one property that matters is stated in cashupBreakdown.ts and
 * asserted here:
 *
 *   THE RECONCILING SECTIONS MUST SUM TO THE TENDER'S `expected`.
 *
 * A breakdown quietly missing R40 is worse than no breakdown at all: it sends
 * somebody hunting a theft that is really a source the code has not been taught
 * about. So every case below re-derives the total from the entries themselves
 * and compares it to what declarationView puts in the Expected column — never
 * to a figure the breakdown reported about itself.
 *
 * The cases that matter are the ones a naive implementation gets wrong:
 *   - change given back must not inflate the sales section
 *   - a payout must come out, and a pay-in must go in, from ONE signed column
 *   - the float and the movements belong to the drawer tender and to no other
 *   - a split sale contributes to two tenders, and to neither one twice
 *   - off-ledger money is LISTED but must not move the reconciling total
 *
 *   npm run test:cashup-breakdown
 */
import { siteExecute, siteQuery, siteQueryOne } from '../src/lib/siteDb'
import { saveDraft } from '../src/lib/site/salesDocuments'
import { finaliseDocument } from '../src/lib/site/salesPosting'
import { getTenderByCode } from '../src/lib/site/tenderTypes'
import { openShift, recordDrawerMovement, cashupMode } from '../src/lib/site/shifts'
import { declarationView } from '../src/lib/site/cashupDeclaration'
import { tenderBreakdown } from '../src/lib/site/cashupBreakdown'
import { setSetting } from '../src/lib/site/settings'
import { toNum, round } from '../src/lib/decimals'

const SITE = 1
const ACTOR = { userId: 9301, userName: 'Breakdown Test' }

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

/** Free till numbers, queried rather than fixed — see test-cashup-modes.ts. */
async function freeTillNumber(): Promise<string> {
  const rows = await siteQuery<any>(
    SITE,
    'SELECT till_number FROM terminals WHERE till_number IS NOT NULL',
  )
  const taken = new Set(rows.map((r: any) => String(r.till_number)))
  for (let n = 99; n >= 50; n--) if (!taken.has(String(n))) return String(n)
  throw new Error('No free till numbers in 50..99 — sweep the scratch terminals.')
}

/** Σ every entry in the reconciling sections. Re-derived, never taken on trust. */
function sumEntries(b: NonNullable<Awaited<ReturnType<typeof tenderBreakdown>>>): number {
  return round(
    b.sections
      .filter((s) => !s.informational)
      .flatMap((s) => s.entries)
      .reduce((sum, e) => round(sum + e.amount, 2), 0),
    2,
  )
}

async function main() {
  const stamp = Date.now().toString().slice(-8)
  const originalMode = await cashupMode(SITE)
  const createdShifts: number[] = []
  const createdLaybys: number[] = []
  let terminalId = 0
  let productId = 0
  let customerId = 0

  try {
    await setSetting(SITE, 'cashup_mode', 'terminal')

    const vat = await siteQueryOne<any>(
      SITE,
      "SELECT id, rate FROM vat_rates WHERE vat_type='sales' AND is_default=1 LIMIT 1",
    )
    const rate = toNum(vat?.rate, 15)

    const till = await siteExecute(
      SITE,
      'INSERT INTO terminals (code, name, till_number) VALUES (?,?,?)',
      [`BD${stamp}`.slice(0, 24), 'Breakdown test till', await freeTillNumber()],
    )
    terminalId = till.insertId
    await siteExecute(
      SITE,
      `INSERT INTO document_sequences (terminal_id, doc_type, prefix, next_number, padding)
       VALUES (?, 'invoice', 'INV', 1, 6)
       ON DUPLICATE KEY UPDATE doc_type = doc_type`,
      [terminalId],
    )

    const prod = await siteExecute(
      SITE,
      `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost, last_cost, selling_vat_rate_id, visible_in_pos)
       VALUES (?,?,'service',0,4,4,?,1)`,
      [`BRK${stamp}`, `Breakdown item ${stamp}`, vat?.id ?? null],
    )
    productId = prod.insertId

    const cash = await getTenderByCode(SITE, 'CASH')
    const card = await getTenderByCode(SITE, 'CARD')
    if (!cash || !card) {
      console.log('**FAIL** missing CASH or CARD tender')
      process.exit(1)
    }

    const sell = async (amount: number, tenders: { tenderTypeId: number; amount: number }[]) => {
      const draft = await saveDraft(SITE, ACTOR, {
        docType: 'invoice',
        customerName: 'Breakdown test',
        terminalId,
        terminalCode: `BD${stamp}`.slice(0, 24),
        lines: [
          {
            productId,
            productCode: `BRK${stamp}`,
            description: 'Breakdown item',
            productType: 'service',
            qty: 1,
            unitPriceIncl: amount,
            vatRatePct: rate,
            unitCostExcl: 4,
          },
        ],
      })
      if (!draft.ok) throw new Error(`draft failed: ${draft.error}`)
      return finaliseDocument(SITE, ACTOR, { documentId: draft.id, tenders })
    }

    // ── A shift with every kind of cash event on it ──────────────────────
    const opened = await openShift(SITE, ACTOR, terminalId, 500)
    if (!opened.ok) {
      console.log('**FAIL** could not open shift:', opened.error)
      process.exit(1)
    }
    const shiftId = opened.shiftId
    createdShifts.push(shiftId)

    await sell(100, [{ tenderTypeId: cash.id, amount: 100 }])
    await sell(250, [{ tenderTypeId: card.id, amount: 250 }])
    // A SPLIT sale: one sale, two tender rows, and neither breakdown may claim
    // the other's half.
    await sell(80, [
      { tenderTypeId: cash.id, amount: 30 },
      { tenderTypeId: card.id, amount: 50 },
    ])
    // Paid with a big note: R200 handed over for a R60 sale. The posting engine
    // derives the R140 change and stores it against the tender that gave it, so
    // the drawer keeps 60. The section must report that NET or it overshoots by
    // the change on every sale anybody paid for with a note.
    await sell(60, [{ tenderTypeId: cash.id, amount: 200 }])

    await recordDrawerMovement(SITE, ACTOR, shiftId, {
      type: 'payout',
      amount: 40,
      reason: 'Milk for the shop',
    })
    await recordDrawerMovement(SITE, ACTOR, shiftId, {
      type: 'payin',
      amount: 25,
      reason: 'Change from the safe',
    })
    await recordDrawerMovement(SITE, ACTOR, shiftId, {
      type: 'drop',
      amount: 100,
      reason: 'Mid-shift drop',
    })

    const view = await declarationView(SITE, shiftId)
    if (!view) {
      console.log('**FAIL** no declaration view')
      process.exit(1)
    }
    const cashLine = view.tenders.find((t) => t.tenderCode === 'CASH')!
    const cardLine = view.tenders.find((t) => t.tenderCode === 'CARD')!

    // ── Cash ─────────────────────────────────────────────────────────────
    const cashBreak = await tenderBreakdown(SITE, shiftId, cash.id, cashLine.declared)
    if (!cashBreak) {
      console.log('**FAIL** no cash breakdown')
      process.exit(1)
    }

    ok(
      '*** the cash sections add up to the board’s Expected column ***',
      cashBreak.reconciles && cashBreak.total === cashLine.expected,
      `sections ${cashBreak.total}, board ${cashLine.expected}`,
    )
    ok(
      '  and the entries themselves add up to that same total',
      sumEntries(cashBreak) === cashBreak.total,
      `entries ${sumEntries(cashBreak)}, reported ${cashBreak.total}`,
    )

    const bySection = new Map(cashBreak.sections.map((s) => [s.key, s]))

    ok('*** the float is a row, not a footnote ***', bySection.get('float')?.subtotal === 500,
      String(bySection.get('float')?.subtotal))

    // 100 + 30 + (200 - 140) = 190. The change is the whole point of this one.
    ok(
      '*** change given back does NOT inflate the sales section ***',
      bySection.get('sales')?.subtotal === 190,
      `${bySection.get('sales')?.subtotal} (would be 330 if the gross were listed)`,
    )
    ok(
      '  and the big-note sale is listed at what the drawer kept',
      bySection.get('sales')?.entries.some((e) => e.amount === 60) === true,
      JSON.stringify(bySection.get('sales')?.entries.map((e) => e.amount)),
    )

    ok('*** a payout comes OUT ***', bySection.get('payouts')?.subtotal === -40,
      String(bySection.get('payouts')?.subtotal))
    ok('*** a pay-in goes IN ***', bySection.get('payins')?.subtotal === 25,
      String(bySection.get('payins')?.subtotal))
    ok('*** a drop leaves the drawer ***', bySection.get('drops')?.subtotal === -100,
      String(bySection.get('drops')?.subtotal))

    // 500 float + 190 sales - 40 + 25 - 100 = 575
    ok('  which is 500 + 190 - 40 + 25 - 100 = 575', cashBreak.total === 575,
      String(cashBreak.total))

    ok(
      '  every section is headed and explained, so the screen never invents its own words',
      cashBreak.sections.every((s) => s.title.length > 0 && s.hint.length > 0),
    )
    ok(
      '  an empty section is dropped rather than shown as a row of zeros',
      !cashBreak.sections.some((s) => s.entries.length === 0),
    )

    // ── Card ─────────────────────────────────────────────────────────────
    const cardBreak = await tenderBreakdown(SITE, shiftId, card.id, cardLine.declared)
    if (!cardBreak) {
      console.log('**FAIL** no card breakdown')
      process.exit(1)
    }

    ok(
      '*** the card reconciles against what was rung up alone ***',
      cardBreak.reconciles && cardBreak.total === cardLine.expected && cardBreak.total === 300,
      `sections ${cardBreak.total}, board ${cardLine.expected}`,
    )
    ok(
      '*** the float and the movements belong to the DRAWER, not to the card ***',
      !cardBreak.sections.some((s) =>
        ['float', 'payins', 'payouts', 'drops'].includes(s.key),
      ),
      cardBreak.sections.map((s) => s.key).join(', '),
    )
    ok('  and the card knows it is not the drawer', cardBreak.drawerExpected === null)
    ok('  while cash publishes what the drawer should physically hold',
      cashBreak.drawerExpected !== null, String(cashBreak.drawerExpected))

    // The split sale, from both sides. 30 to cash and 50 to card — and each
    // breakdown sees only its own half.
    ok(
      '*** a split sale contributes to two tenders and to neither one twice ***',
      bySection.get('sales')!.entries.some((e) => e.amount === 30) &&
        cardBreak.sections
          .find((s) => s.key === 'sales')!
          .entries.some((e) => e.amount === 50) &&
        !cardBreak.sections.find((s) => s.key === 'sales')!.entries.some((e) => e.amount === 30),
    )

    ok(
      '  entries name the document, so a figure can be traced to a slip',
      bySection.get('sales')!.entries.every((e) => e.documentNumber !== null),
    )
    ok(
      '  and they name who did it',
      bySection.get('payouts')!.entries.every((e) => e.userName !== null),
    )
    ok(
      '  a payout carries its reason, which is the whole point of reading this',
      bySection.get('payouts')!.entries.some((e) => e.label === 'Milk for the shop'),
      bySection.get('payouts')!.entries.map((e) => e.label).join(' | '),
    )

    // ── Off-ledger money is LISTED but does not move the total ────────────
    //
    // A lay-by deposit is real cash in the drawer, and the Expected column does
    // not include it — see the long note in cashupBreakdown.ts. The screen must
    // show it without letting it disturb the reconciliation, and this is the
    // case that proves both halves at once.
    const cust = await siteExecute(
      SITE,
      'INSERT INTO customers (code, name) VALUES (?,?)',
      [`BRKC${stamp}`.slice(0, 24), `Breakdown customer ${stamp}`],
    )
    customerId = cust.insertId

    const layby = await siteExecute(
      SITE,
      `INSERT INTO laybys (document_number, customer_id, status, total_incl, paid_total)
       VALUES (?,?,'open',300,150)`,
      [`LB${stamp}`.slice(0, 32), customerId],
    )
    createdLaybys.push(layby.insertId)
    await siteExecute(
      SITE,
      `INSERT INTO layby_payments (layby_id, kind, amount, tender_type_id, tender_name, paid_on, shift_id, user_id, user_name)
       VALUES (?, 'deposit', 150, ?, 'Cash', CURDATE(), ?, ?, ?)`,
      [layby.insertId, cash.id, shiftId, ACTOR.userId, ACTOR.userName],
    )

    const withLayby = await tenderBreakdown(SITE, shiftId, cash.id, cashLine.declared)
    if (!withLayby) {
      console.log('**FAIL** no breakdown after the lay-by')
      process.exit(1)
    }

    const laybySection = withLayby.sections.find((s) => s.key === 'laybys')
    ok('*** a lay-by deposit is LISTED ***', laybySection?.subtotal === 150,
      String(laybySection?.subtotal))
    ok('  named for the customer whose money it is', laybySection?.entries[0]?.party !== null,
      String(laybySection?.entries[0]?.party))
    ok(
      '*** but it does NOT move the reconciling total ***',
      withLayby.total === 575 && withLayby.reconciles,
      `${withLayby.total}, reconciles ${withLayby.reconciles}`,
    )
    ok(
      '  it is marked informational, so the screen can render it below the line',
      laybySection?.informational === true,
    )
    ok('  and reported as its own figure', withLayby.offLedgerTotal === 150,
      String(withLayby.offLedgerTotal))
    ok(
      '*** the DRAWER expectation does include it — which is the gap the screen must show ***',
      withLayby.drawerExpected === 725,
      `${withLayby.drawerExpected} = 575 expected + 150 off-ledger`,
    )

    // A card breakdown must not pick up a lay-by that was paid in cash.
    const cardAfter = await tenderBreakdown(SITE, shiftId, card.id, cardLine.declared)
    ok(
      '  and a cash lay-by stays out of the card breakdown',
      !cardAfter!.sections.some((s) => s.key === 'laybys') && cardAfter!.offLedgerTotal === 0,
    )

    // ── Asking about the wrong thing ─────────────────────────────────────
    ok(
      '*** a tender this shift never took is refused, not answered with zeros ***',
      (await tenderBreakdown(SITE, shiftId, 99999999)) === null,
    )
    ok(
      '  as is a shift that does not exist',
      (await tenderBreakdown(SITE, 99999999, cash.id)) === null,
    )

    // ── The declared figure is threaded through, not invented ────────────
    const withDeclared = await tenderBreakdown(SITE, shiftId, cash.id, 550)
    ok('  the declared figure is carried onto the result', withDeclared?.declared === 550,
      String(withDeclared?.declared))
  } finally {
    // ── Cleanup ──────────────────────────────────────────────────────────
    // Litter on a UNIQUE column kills unrelated suites — see the note in
    // test-cashup.ts about scratch terminals.
    for (const id of createdLaybys) {
      await siteExecute(SITE, 'DELETE FROM layby_payments WHERE layby_id = ?', [id]).catch(() => null)
      await siteExecute(SITE, 'DELETE FROM layby_lines WHERE layby_id = ?', [id]).catch(() => null)
      await siteExecute(SITE, 'DELETE FROM laybys WHERE id = ?', [id]).catch(() => null)
    }
    if (customerId) {
      await siteExecute(SITE, 'DELETE FROM customers WHERE id = ?', [customerId]).catch(() => null)
    }

    for (const id of createdShifts) {
      const declaration = await siteQueryOne<any>(
        SITE,
        'SELECT id FROM shift_declarations WHERE shift_id = ?',
        [id],
      ).catch(() => null)
      if (declaration) {
        await siteExecute(SITE, 'DELETE FROM shift_count_denominations WHERE declaration_id = ?', [
          declaration.id,
        ]).catch(() => null)
      }
      await siteExecute(SITE, 'DELETE FROM shift_counts WHERE shift_id = ?', [id]).catch(() => null)
      await siteExecute(SITE, 'DELETE FROM shift_declarations WHERE shift_id = ?', [id]).catch(() => null)
      await siteExecute(SITE, 'DELETE FROM shift_movements WHERE shift_id = ?', [id]).catch(() => null)
    }

    if (terminalId) {
      const docs = await siteQuery<any>(SITE, 'SELECT id FROM sales_documents WHERE terminal_id = ?', [terminalId])
      for (const d of docs) {
        await siteExecute(SITE, 'DELETE FROM sales_tenders WHERE document_id = ?', [d.id]).catch(() => null)
        await siteExecute(SITE, 'DELETE FROM sales_document_lines WHERE document_id = ?', [d.id]).catch(() => null)
        await siteExecute(SITE, 'DELETE FROM document_audit WHERE document_id = ?', [d.id]).catch(() => null)
        await siteExecute(SITE, 'DELETE FROM stock_movements WHERE document_id = ?', [d.id]).catch(() => null)
        await siteExecute(SITE, 'DELETE FROM sales_documents WHERE id = ?', [d.id]).catch(() => null)
      }
      for (const id of createdShifts) {
        await siteExecute(SITE, 'DELETE FROM shifts WHERE id = ?', [id]).catch(() => null)
      }
      /* The sequence goes too: leaving an allocated number with no document is
         what makes test-sales-posting fail instead of this suite. */
      await siteExecute(SITE, 'DELETE FROM document_sequences WHERE terminal_id = ?', [terminalId]).catch(() => null)
      await siteExecute(SITE, 'DELETE FROM terminals WHERE id = ?', [terminalId]).catch(() => null)
    }
    if (productId) {
      await siteExecute(SITE, 'DELETE FROM products WHERE id = ?', [productId]).catch(() => null)
    }

    await setSetting(SITE, 'cashup_mode', originalMode)
  }

  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
  process.exit(fails === 0 ? 0 : 1)
}

void main()
