/**
 * The detailed cash declaration.
 *
 * test-cashup.ts proves the arithmetic of a shift; this proves the DECLARATION
 * on top of it — the denomination grid, the per-tender declared figures, the
 * counters, and the freeze at sign-off.
 *
 * The cases that matter are the ones a spreadsheet would get wrong:
 *   - a recount that finds FEWER notes must remove the surplus, not merge
 *   - a split-tender sale is one sale but two tender rows
 *   - rounding is money the drawer legitimately does not hold
 *   - a signed cash-up must refuse further edits
 *
 *   npm run test:cashup-declaration
 */
import { siteExecute, siteQuery, siteQueryOne } from '../src/lib/siteDb'
import { saveDraft } from '../src/lib/site/salesDocuments'
import { finaliseDocument } from '../src/lib/site/salesPosting'
import { getTenderByCode } from '../src/lib/site/tenderTypes'
import { openShift, recordDrawerMovement, cashupMode } from '../src/lib/site/shifts'
import {
  declarationView,
  listDenominations,
  saveDeclaration,
  finalizeDeclaration,
  notePrint,
} from '../src/lib/site/cashupDeclaration'
import { setSetting } from '../src/lib/site/settings'
import { toNum } from '../src/lib/decimals'

const SITE = 1
const ACTOR = { userId: 9101, userName: 'Declaration Test' }
const SUPER = { id: 9102, name: 'Sipho Supervisor' }

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

/** Free till numbers, queried rather than fixed — see test-cashup-modes.ts. */
async function freeTillNumber(): Promise<string> {
  const rows = await siteQuery<any>(SITE, 'SELECT till_number FROM terminals WHERE till_number IS NOT NULL')
  const taken = new Set(rows.map((r: any) => String(r.till_number)))
  for (let n = 99; n >= 50; n--) if (!taken.has(String(n))) return String(n)
  throw new Error('No free till numbers in 50..99 — sweep the scratch terminals.')
}

async function main() {
  const stamp = Date.now().toString().slice(-8)
  const originalMode = await cashupMode(SITE)
  const createdShifts: number[] = []
  let terminalId = 0
  let productId = 0

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
      [`DC${stamp}`.slice(0, 24), 'Declaration test till', await freeTillNumber()],
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
      [`DEC${stamp}`, `Declaration item ${stamp}`, vat?.id ?? null],
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
        customerName: 'Declaration test',
        terminalId,
        terminalCode: `DC${stamp}`.slice(0, 24),
        lines: [
          {
            productId,
            productCode: `DEC${stamp}`,
            description: 'Declaration item',
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

    // ── Denominations ────────────────────────────────────────────────────
    const denominations = await listDenominations(SITE)
    ok('*** the ZAR denominations are seeded ***', denominations.length >= 11,
      `${denominations.length} active`)
    ok('  the demonetised 5c is off by default',
      !denominations.some((d) => d.label === '5c'))
    ok('  they run largest first, the way a person counts',
      denominations[0].value > denominations[denominations.length - 1].value,
      `${denominations[0].label} .. ${denominations[denominations.length - 1].label}`)
    ok('  notes and coins are distinguishable',
      denominations.some((d) => d.isNote) && denominations.some((d) => !d.isNote))

    // ── A shift with real trade on it ────────────────────────────────────
    const opened = await openShift(SITE, ACTOR, terminalId, 500)
    if (!opened.ok) {
      console.log('**FAIL** could not open shift:', opened.error)
      process.exit(1)
    }
    const shiftId = opened.shiftId
    createdShifts.push(shiftId)

    await sell(100, [{ tenderTypeId: cash.id, amount: 100 }])
    await sell(250, [{ tenderTypeId: card.id, amount: 250 }])
    // A SPLIT sale: one sale, two tender rows. The counters must tell these apart.
    await sell(80, [
      { tenderTypeId: cash.id, amount: 30 },
      { tenderTypeId: card.id, amount: 50 },
    ])
    await recordDrawerMovement(SITE, ACTOR, shiftId, {
      type: 'payout',
      amount: 40,
      reason: 'Milk for the shop',
    })

    const view = await declarationView(SITE, shiftId)
    if (!view) {
      console.log('**FAIL** no declaration view')
      process.exit(1)
    }

    ok('*** the float is carried onto the cash tender, not the card ***',
      view.tenders.find((t) => t.tenderCode === 'CASH')?.floatIncluded === 500 &&
        view.tenders.find((t) => t.tenderCode === 'CARD')?.floatIncluded === 0)

    const cashLine = view.tenders.find((t) => t.tenderCode === 'CASH')!
    // 500 float + 130 taken - 40 payout = 590
    ok('*** expected cash = float + takings - payouts ***', cashLine.expected === 590,
      String(cashLine.expected))
    const cardLine = view.tenders.find((t) => t.tenderCode === 'CARD')!
    ok('  the card reconciles against what was rung up alone', cardLine.expected === 300,
      String(cardLine.expected))

    ok('  a payout is reported by direction, not as a signed lump',
      view.payoutsTotal === 40 && view.payinsTotal === 0, `payouts ${view.payoutsTotal}`)

    // ── The counters ─────────────────────────────────────────────────────
    ok('*** a split sale counts ONCE as a sale ***', view.counters.salesCount === 3,
      `${view.counters.salesCount} sales`)
    ok('*** but twice as tender rows ***',
      cashLine.transactionCount === 2 && cardLine.transactionCount === 2,
      `cash ${cashLine.transactionCount}, card ${cardLine.transactionCount}`)
    ok('*** "cash sales" means paid ONLY by cash ***', view.counters.cashSales === 1,
      `${view.counters.cashSales} (the split one is neither)`)
    ok('  and "card sales" likewise', view.counters.cardSales === 1,
      String(view.counters.cardSales))

    // ── The denomination grid ────────────────────────────────────────────
    const byLabel = new Map(denominations.map((d) => [d.label, d.id]))
    // R500 + R50 + R20 + R20 = 590. Exactly the expected cash.
    const firstCount: Record<number, number> = {
      [byLabel.get('R200')!]: 2,
      [byLabel.get('R100')!]: 1,
      [byLabel.get('R50')!]: 1,
      [byLabel.get('R20')!]: 2,
    }
    const saved = await saveDeclaration(SITE, ACTOR, shiftId, {
      supervisorId: SUPER.id,
      supervisorName: SUPER.name,
      denominations: firstCount,
      tenders: { [cash.id]: 590, [card.id]: 300 },
      bankDeclared: 0,
      bankReference: null,
      varianceNote: null,
      note: null,
    })
    ok('a draft declaration saves', saved.ok, saved.ok ? '' : saved.error)

    const afterFirst = await declarationView(SITE, shiftId)
    ok('*** the grid totals into declared cash ***', afterFirst?.declaredCash === 590,
      String(afterFirst?.declaredCash))
    ok('  the supervisor is on the record', afterFirst?.supervisorName === SUPER.name)

    // ── A RECOUNT that finds fewer notes ─────────────────────────────────
    // The trap: an upsert per row would leave the two R20s behind.
    const recount: Record<number, number> = {
      [byLabel.get('R200')!]: 2,
      [byLabel.get('R100')!]: 1,
      [byLabel.get('R50')!]: 1,
      // the R20s are gone — miscounted the first time
    }
    const recountRows = Object.keys(recount).length
    await saveDeclaration(SITE, ACTOR, shiftId, {
      supervisorId: SUPER.id,
      supervisorName: SUPER.name,
      denominations: recount,
      tenders: { [cash.id]: 550, [card.id]: 300 },
      bankDeclared: 0,
      bankReference: null,
      varianceNote: null,
      note: null,
    })
    const afterRecount = await declarationView(SITE, shiftId)
    ok('*** a recount REPLACES the grid, it does not merge ***',
      afterRecount?.declaredCash === 550, String(afterRecount?.declaredCash))
    ok('  and the removed denomination is gone from the grid',
      !afterRecount?.counted.some((c) => c.label === 'R20'))
    ok('  one declaration per shift, revised in place',
      afterRecount?.declarationId === afterFirst?.declarationId)

    /*
     * ── THE GRID MUST SURVIVE A TENDER COMMIT ──────────────────────────
     *
     * Committing one tender saves the WHOLE declaration. The first version of
     * the reveal action carried the server's copy of the grid forward, so a
     * drawer counted on screen but not yet saved was wiped — and the cash-up
     * signed off with declared_cash of 0.00 while the screen showed R350.
     *
     * This reproduces that shape: save a grid, then commit a tender WITHOUT
     * re-sending the denominations, and check the count is still there.
     */
    await saveDeclaration(SITE, ACTOR, shiftId, {
      supervisorId: SUPER.id,
      supervisorName: SUPER.name,
      denominations: recount,
      tenders: { [cash.id]: 550 },
      bankDeclared: 0,
      bankReference: null,
      varianceNote: null,
      note: null,
    })
    const kept = await declarationView(SITE, shiftId)
    ok('*** committing one tender does not wipe the counted grid ***',
      kept?.declaredCash === 550 && kept.counted.length === recountRows,
      `cash ${kept?.declaredCash}, ${kept?.counted.length} rows`)

    // ── Pre-print ────────────────────────────────────────────────────────
    await notePrint(SITE, shiftId)
    await notePrint(SITE, shiftId)
    const printed = await declarationView(SITE, shiftId)
    ok('pre-printing is counted', printed?.printCount === 2, String(printed?.printCount))

    // ── Refusals ─────────────────────────────────────────────────────────
    const noSupervisor = await finalizeDeclaration(SITE, ACTOR, shiftId, {
      supervisorId: null,
      supervisorName: '   ',
      denominations: recount,
      tenders: { [cash.id]: 550, [card.id]: 300 },
      bankDeclared: 0,
      bankReference: null,
      varianceNote: null,
      note: null,
    })
    ok('*** signing off needs a supervisor ***', !noSupervisor.ok,
      noSupervisor.ok ? '' : noSupervisor.error)

    const blankTender = await finalizeDeclaration(SITE, ACTOR, shiftId, {
      supervisorId: SUPER.id,
      supervisorName: SUPER.name,
      denominations: recount,
      tenders: { [cash.id]: 550 }, // card left blank
      bankDeclared: 0,
      bankReference: null,
      varianceNote: null,
      note: null,
    })
    ok('*** a BLANK tender is not a zero ***', !blankTender.ok,
      blankTender.ok ? '' : blankTender.error)

    // ── Signing off ──────────────────────────────────────────────────────
    // Declared 550 cash against 590 expected: R40 short, needing a note.
    const short = await finalizeDeclaration(SITE, ACTOR, shiftId, {
      supervisorId: SUPER.id,
      supervisorName: SUPER.name,
      denominations: recount,
      tenders: { [cash.id]: 550, [card.id]: 300 },
      bankDeclared: 50,
      bankReference: 'BAG-001',
      varianceNote: 'Two R20 notes could not be found. Reported.',
      note: null,
    })
    ok('*** it signs off short, with the explanation ***', short.ok,
      short.ok ? `variance ${short.variance}` : short.error)
    ok('  and the variance is the R40 that went missing',
      short.ok && short.variance === -40, short.ok ? String(short.variance) : '')

    const signed = await declarationView(SITE, shiftId)
    ok('*** the declaration is stamped as signed ***', signed?.finalizedAt !== null)
    const closedRow = await siteQueryOne<any>(
      SITE,
      'SELECT closed_at FROM shifts WHERE id = ?',
      [shiftId],
    )
    ok('  the shift closed with it', closedRow?.closed_at != null, String(closedRow?.closed_at))

    const frozen = await siteQueryOne<any>(
      SITE,
      'SELECT declared_total, expected_total, variance, payouts_total, finalized_by_name FROM shift_declarations WHERE shift_id = ?',
      [shiftId],
    )
    ok('*** the totals are FROZEN onto the declaration ***',
      toNum(frozen?.declared_total) === 850 && toNum(frozen?.expected_total) === 890,
      `declared ${frozen?.declared_total}, expected ${frozen?.expected_total}`)
    ok('  including the payouts, so the report needs no join',
      toNum(frozen?.payouts_total) === 40)
    ok('  and who signed it', frozen?.finalized_by_name === ACTOR.userName)

    const counts = await siteQuery<any>(
      SITE,
      'SELECT tender_code, expected, counted, transaction_count, float_included FROM shift_counts WHERE shift_id = ? ORDER BY tender_code',
      [shiftId],
    )
    ok('*** the per-tender counts are frozen too ***', counts.length === 2, `${counts.length} rows`)
    const frozenCash = counts.find((c: any) => c.tender_code === 'CASH')
    ok('  with the transaction count beside the money',
      Number(frozenCash?.transaction_count) === 2, String(frozenCash?.transaction_count))
    ok('  and the float that was folded in',
      toNum(frozenCash?.float_included) === 500, String(frozenCash?.float_included))

    // ── A signed cash-up is a record, not a draft ────────────────────────
    const afterSigning = await saveDeclaration(SITE, ACTOR, shiftId, {
      supervisorId: SUPER.id,
      supervisorName: 'Someone Else',
      denominations: firstCount,
      tenders: { [cash.id]: 590, [card.id]: 300 },
      bankDeclared: 0,
      bankReference: null,
      varianceNote: null,
      note: null,
    })
    ok('*** a signed declaration refuses further edits ***', !afterSigning.ok,
      afterSigning.ok ? '' : afterSigning.error)
  } finally {
    // ── Cleanup ──────────────────────────────────────────────────────────
    // Litter on a UNIQUE column kills unrelated suites — see the note in
    // test-cashup.ts about scratch terminals.
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
