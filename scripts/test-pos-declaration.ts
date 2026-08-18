/**
 * The detailed cash-up, reached from the till.
 *
 * test-cashup-declaration.ts proves the declaration ENGINE. This proves the
 * thing the POS added on top of it: that the cashup quick key opens the full
 * declaration rather than the flat quick count, and that the till and the back
 * office cannot sign off different arithmetic for one shift.
 *
 * The cases that matter are the ones a shared engine makes easy to get wrong:
 *   - the till's view and the back office's view are the SAME view
 *   - the blind-count strip applies at the till too, not just in the back office
 *   - a count committed at the till is what the back office then reads back
 *   - the quick count and the declaration close the same shift the same way
 *
 *   npm run test:pos-declaration
 */
import { siteExecute, siteQuery, siteQueryOne } from '../src/lib/siteDb'
import { getTenderByCode } from '../src/lib/site/tenderTypes'
import { openShift, cashupMode, shiftPosition } from '../src/lib/site/shifts'
import { saveDraft } from '../src/lib/site/salesDocuments'
import { finaliseDocument } from '../src/lib/site/salesPosting'
import {
  declarationView,
  saveDeclaration,
  finalizeDeclaration,
} from '../src/lib/site/cashupDeclaration'
import { visibleFor } from '../src/app/(app)/sales/cashup/[shiftId]/declare/visible'
import { setSetting } from '../src/lib/site/settings'
import { toNum } from '../src/lib/decimals'

const SITE = 1
const ACTOR = { userId: 9111, userName: 'Till Declaration Test' }
const SUPER = { id: 9112, name: 'Thandi Supervisor' }

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

    const till = await siteExecute(
      SITE,
      'INSERT INTO terminals (code, name, till_number) VALUES (?,?,?)',
      [`TD${stamp}`.slice(0, 24), 'Till declaration test', await freeTillNumber()],
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
      [`TDC${stamp}`, `Till declaration item ${stamp}`, vat?.id ?? null],
    )
    productId = prod.insertId

    const cash = await getTenderByCode(SITE, 'CASH')
    const card = await getTenderByCode(SITE, 'CARD')
    /* THROW, never process.exit, once a fixture exists.
       exit() skips the finally below, and the scratch terminal it strands owns
       a UNIQUE till number — which then fails an unrelated suite rather than
       this one. That is not hypothetical: the first run of this file died here
       and left terminal TD… behind. */
    if (!cash || !card) throw new Error('missing CASH or CARD tender')

    /* ── A shift with something in it ──────────────────────────────────── */

    const opened = await openShift(SITE, ACTOR, terminalId, 500)
    if (!opened.ok) throw new Error(`could not open the shift: ${opened.error}`)
    const shiftId = opened.shiftId
    createdShifts.push(shiftId)

    // One cash sale and one card sale, so both tenders have a real expectation.
    const rate = toNum(vat?.rate, 15)
    async function sell(amount: number, tenders: { tenderTypeId: number; amount: number }[]) {
      const draft = await saveDraft(SITE, ACTOR, {
        docType: 'invoice',
        customerName: 'Till declaration test',
        terminalId,
        terminalCode: `TD${stamp}`.slice(0, 24),
        lines: [
          {
            productId,
            productCode: `TDC${stamp}`,
            description: 'Till declaration item',
            productType: 'service',
            qty: 1,
            unitPriceIncl: amount,
            vatRatePct: rate,
            unitCostExcl: 4,
          },
        ],
      } as any)
      if (!draft.ok) throw new Error(`draft failed: ${(draft as any).error}`)
      return finaliseDocument(SITE, ACTOR, { documentId: (draft as any).id, tenders } as any)
    }

    await sell(100, [{ tenderTypeId: cash.id, amount: 100 }])
    await sell(300, [{ tenderTypeId: card.id, amount: 300 }])

    /* ── The till reads the SAME view as the back office ────────────────
     *
     * The whole design rests on this. The till actions import declarationView
     * and visibleFor rather than computing anything, so if these two ever
     * disagree the till is signing off figures the back office never saw.
     */

    const engine = await declarationView(SITE, shiftId)
    ok('the till has a declaration to show', engine !== null)
    if (!engine) throw new Error('no view')

    const position = await shiftPosition(SITE, shiftId)
    ok(
      '*** the declaration counts the same takings as the shift ***',
      toNum(engine.tenders.reduce((s, t) => s + t.takings, 0)) ===
        toNum(position?.tenders.reduce((s, t) => s + t.expected, 0)),
      `${engine.tenders.reduce((s, t) => s + t.takings, 0)}`,
    )
    ok(
      'the float lands on cash, not on card',
      engine.tenders.find((t) => t.tenderTypeId === cash.id)?.floatIncluded === 500 &&
        engine.tenders.find((t) => t.tenderTypeId === card.id)?.floatIncluded === 0,
    )

    /* ── The blind count applies AT THE TILL ────────────────────────────
     *
     * `visibleFor` is what the till action returns. An expected figure must
     * not be in that payload before a count is committed — a cashier who can
     * read the target in devtools is counting towards a number.
     */

    const blind = visibleFor(engine)
    ok(
      '*** nothing is declared yet, so no expected figure is published ***',
      blind.tenders.every((t) => t.expected === null),
    )
    ok('and no cash expectation either', blind.expectedCashVisible === null)
    ok('the total variance is withheld with them', blind.totalVariance === null)

    /* ── Committing one tender reveals only that one ────────────────────
     *
     * This is what tillRevealTenderAction does: save the declaration with one
     * more tender counted, then re-read. The denomination grid travels with
     * it — the back office learned the hard way that carrying the server's
     * copy instead wipes a grid typed but not yet saved.
     */

    const denominations = engine.denominations
    const r100 = denominations.find((d) => d.value === 100)
    const r50 = denominations.find((d) => d.value === 50)
    ok('the ZAR denominations are on the till too', !!r100 && !!r50)

    const grid: Record<number, number> = {}
    if (r100) grid[r100.id] = 5 // R500
    if (r50) grid[r50.id] = 2 // R100 — the cash sale

    const committed = await saveDeclaration(SITE, ACTOR, shiftId, {
      supervisorId: null,
      supervisorName: '',
      smallChange: 0,
      denominations: grid,
      tenders: { [cash.id]: 600 },
      bankDeclared: 0,
      bankReference: null,
      varianceNote: null,
      note: null,
    })
    ok('committing one tender saves', committed.ok)

    const afterOne = await declarationView(SITE, shiftId)
    const visibleAfterOne = visibleFor(afterOne!)
    ok(
      '*** the committed tender reveals its expectation ***',
      visibleAfterOne.tenders.find((t) => t.tenderTypeId === cash.id)?.expected === 600,
      `${visibleAfterOne.tenders.find((t) => t.tenderTypeId === cash.id)?.expected}`,
    )
    ok(
      '*** but the UNCOUNTED tender still withholds its own ***',
      visibleAfterOne.tenders.find((t) => t.tenderTypeId === card.id)?.expected === null,
    )
    ok(
      'the grid the till typed survived the commit',
      toNum(afterOne?.declaredCash) === 600,
      `${afterOne?.declaredCash}`,
    )
    ok(
      'and the total variance stays hidden until every tender is in',
      visibleAfterOne.totalVariance === null,
    )

    /* ── Signing off from the till ──────────────────────────────────────
     *
     * tillFinalizeDeclarationAction delegates to finalizeDeclaration, which
     * delegates the close to closeShift — so the till's "Finalize cash-up"
     * and the quick count's "Close the shift" are the same event.
     */

    const blank = await finalizeDeclaration(SITE, ACTOR, shiftId, {
      supervisorId: SUPER.id,
      supervisorName: SUPER.name,
      smallChange: 0,
      denominations: grid,
      tenders: { [cash.id]: 600 },
      bankDeclared: 0,
      bankReference: null,
      varianceNote: null,
      note: null,
    })
    ok(
      '*** a tender nobody counted blocks the sign-off ***',
      !blank.ok && /still blank/i.test((blank as any).error),
      !blank.ok ? (blank as any).error : 'it was allowed',
    )

    const noSupervisor = await finalizeDeclaration(SITE, ACTOR, shiftId, {
      supervisorId: null,
      supervisorName: '',
      smallChange: 0,
      denominations: grid,
      tenders: { [cash.id]: 600, [card.id]: 300 },
      bankDeclared: 0,
      bankReference: null,
      varianceNote: null,
      note: null,
    })
    ok(
      '*** and so does an unwitnessed count ***',
      !noSupervisor.ok && /supervisor/i.test((noSupervisor as any).error),
      !noSupervisor.ok ? (noSupervisor as any).error : 'it was allowed',
    )

    const signed = await finalizeDeclaration(SITE, ACTOR, shiftId, {
      supervisorId: SUPER.id,
      supervisorName: SUPER.name,
      smallChange: 0,
      denominations: grid,
      tenders: { [cash.id]: 600, [card.id]: 300 },
      bankDeclared: 100,
      bankReference: `BAG-${stamp}`,
      varianceNote: null,
      note: 'Signed off at the till.',
    })
    ok('*** the till signs the cash-up off ***', signed.ok, signed.ok ? `variance ${signed.variance}` : (signed as any).error)
    ok('it balanced', signed.ok && signed.variance === 0)

    const closed = await siteQueryOne<any>(SITE, 'SELECT closed_at FROM shifts WHERE id = ?', [
      shiftId,
    ])
    ok('*** signing off at the till CLOSED the shift ***', closed?.closed_at != null)

    /* ── The back office reads back exactly what the till committed ──── */

    const readBack = await declarationView(SITE, shiftId)
    ok('the back office finds the same declaration', readBack?.finalizedAt != null)
    ok(
      '*** and the figures are the till’s, not recomputed ***',
      toNum(readBack?.declaredCash) === 600 && readBack?.bankReference === `BAG-${stamp}`,
      `cash ${readBack?.declaredCash}, bag ${readBack?.bankReference}`,
    )
    ok('the supervisor the till named is on the record', readBack?.supervisorName === SUPER.name)
    ok(
      'a signed cash-up publishes its figures — the count is over',
      visibleFor(readBack!).tenders.every((t) => t.expected !== null),
    )
  } catch (err) {
    /* Reported rather than rethrown, so the run still reaches the cleanup in
       `finally` AND prints a verdict. A suite that dies with a stack trace and
       no FAIL line reads as a pass to anything grepping the output. */
    fails++
    console.log(`**FAIL**  the suite threw  -- ${(err as Error).message}`)
  } finally {
    // ── Cleanup ──────────────────────────────────────────────────────────
    // Litter on a UNIQUE column kills unrelated suites — see test-cashup.ts.
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
      await siteExecute(SITE, 'DELETE FROM shift_declarations WHERE shift_id = ?', [id]).catch(
        () => null,
      )
      await siteExecute(SITE, 'DELETE FROM shift_movements WHERE shift_id = ?', [id]).catch(
        () => null,
      )
    }

    if (terminalId) {
      const docs = await siteQuery<any>(
        SITE,
        'SELECT id FROM sales_documents WHERE terminal_id = ?',
        [terminalId],
      )
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
      /* The sequence goes too: an allocated number with no document is what
         makes test-sales-posting fail instead of this suite. */
      await siteExecute(SITE, 'DELETE FROM document_sequences WHERE terminal_id = ?', [
        terminalId,
      ]).catch(() => null)
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
