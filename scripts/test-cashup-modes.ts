/**
 * Cash-up by till, and cash-up by person.
 *
 * The retail case is covered by test-cashup.ts. This one proves the hospitality
 * case: several waiters ringing up across SHARED tills, each reconciling only
 * their own takings, with the till they happened to use making no difference to
 * whose cash-up the money lands in.
 *
 *   npm run test:cashup-modes
 */
import { siteExecute, siteQueryOne, siteQuery } from '../src/lib/siteDb'
import { saveDraft } from '../src/lib/site/salesDocuments'
import { finaliseDocument } from '../src/lib/site/salesPosting'
import { getTenderByCode } from '../src/lib/site/tenderTypes'
import {
  openShift, closeShift, shiftPosition, openShiftFor, openShiftForUser,
  recordDrawerMovement, listDrawerMovements, cashupMode, shiftToBankInto, getShift,
} from '../src/lib/site/shifts'
import { setSetting } from '../src/lib/site/settings'
import { toNum } from '../src/lib/decimals'

const SITE = 1
// Two waiters and two tills. The point of the exercise is that the pairing
// between them is arbitrary and changes mid-service.
const ANN = { userId: 9001, userName: 'Ann Waiter' }
const BOB = { userId: 9002, userName: 'Bob Waiter' }

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

/**
 * Free till numbers for scratch terminals. See the note in test-cashup.ts for why a
 * scratch till must have one at all.
 *
 * Queried, not fixed, so this and test-cashup cannot collide even if they run together —
 * and so a terminal left behind by a crashed run (one holding a real document, which must
 * not be swept) does not fail the INSERT.
 */
async function freeTillNumbers(count: number): Promise<string[]> {
  const rows = await siteQuery<any>(
    SITE,
    'SELECT till_number FROM terminals WHERE till_number IS NOT NULL',
  )
  const taken = new Set(rows.map((r: any) => String(r.till_number)))
  const free: string[] = []
  // Down from 99, so a scratch till never takes a number a real shop would want.
  for (let n = 99; n >= 50 && free.length < count; n--) {
    if (!taken.has(String(n))) free.push(String(n))
  }
  if (free.length < count) {
    throw new Error('Not enough free till numbers in 50..99 — sweep the scratch terminals.')
  }
  return free
}

async function main() {
  const stamp = Date.now().toString().slice(-8)

  /* Sweep what an earlier crashed run left, so the unique till number is free. Only
     terminals with no documents — one holding a real sale must not be deleted. */
  const orphans = await siteQuery<any>(
    SITE,
    `SELECT id FROM terminals
      WHERE (code LIKE 'MA%' OR code LIKE 'MB%')
        AND (SELECT COUNT(*) FROM sales_documents d WHERE d.terminal_id = terminals.id) = 0`,
  )
  for (const o of orphans) {
    await siteExecute(SITE, 'DELETE FROM shifts WHERE terminal_id = ?', [o.id]).catch(() => null)
    await siteExecute(SITE, 'DELETE FROM document_sequences WHERE terminal_id = ?', [o.id]).catch(
      () => null,
    )
    await siteExecute(SITE, 'DELETE FROM terminals WHERE id = ?', [o.id]).catch(() => null)
  }

  const vat = await siteQueryOne<any>(SITE, "SELECT id, rate FROM vat_rates WHERE vat_type='sales' AND is_default=1 LIMIT 1")
  const rate = toNum(vat?.rate, 15)

  const [no1, no2] = await freeTillNumbers(2)
  const t1 = await siteExecute(SITE, 'INSERT INTO terminals (code, name, till_number) VALUES (?,?,?)', [`MA${stamp}`.slice(0, 24), 'Mode test till 1', no1])
  const t2 = await siteExecute(SITE, 'INSERT INTO terminals (code, name, till_number) VALUES (?,?,?)', [`MB${stamp}`.slice(0, 24), 'Mode test till 2', no2])
  const till1 = t1.insertId
  const till2 = t2.insertId
  /* A sequence each — see the note in test-cashup.ts. */
  for (const id of [till1, till2]) {
    await siteExecute(
      SITE,
      `INSERT INTO document_sequences (terminal_id, doc_type, prefix, next_number, padding)
       VALUES (?, 'invoice', 'INV', 1, 6)
       ON DUPLICATE KEY UPDATE doc_type = doc_type`,
      [id],
    )
  }

  const prod = await siteExecute(SITE,
    `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost, last_cost, selling_vat_rate_id, visible_in_pos)
     VALUES (?,?,'service',0,4,4,?,1)`, [`MOD${stamp}`, `Mode item ${stamp}`, vat?.id ?? null])
  const productId = prod.insertId

  const cash = await getTenderByCode(SITE, 'CASH')
  if (!cash) { console.log('missing CASH tender'); process.exit(1) }

  const originalMode = await cashupMode(SITE)

  /** Rings up a sale as `actor`, on `terminalId`. */
  const sell = async (actor: typeof ANN, terminalId: number, amount: number) => {
    const draft = await saveDraft(SITE, actor, {
      docType: 'invoice', customerName: 'Table', terminalId,
      terminalCode: (terminalId === till1 ? `MA${stamp}` : `MB${stamp}`).slice(0, 24),
      lines: [{ productId, productCode: `MOD${stamp}`, description: 'Mode item', productType: 'service', qty: 1, unitPriceIncl: amount, vatRatePct: rate, unitCostExcl: 4 }],
    })
    if (!draft.ok) return { ok: false as const, error: draft.error }
    return finaliseDocument(SITE, actor, { documentId: draft.id, tenders: [{ tenderTypeId: cash.id, amount }] })
  }

  try {
    // ── User mode ────────────────────────────────────────────────────────
    await setSetting(SITE, 'cashup_mode', 'user')
    ok('*** site is in user mode ***', (await cashupMode(SITE)) === 'user')

    const annShift = await openShift(SITE, ANN, null, 200)
    ok('Ann opens a shift with her own R200 float', annShift.ok, annShift.ok ? '' : annShift.error)
    const bobShift = await openShift(SITE, BOB, null, 150)
    ok('Bob opens his own shift on the same floor', bobShift.ok, bobShift.ok ? '' : bobShift.error)
    if (!annShift.ok || !bobShift.ok) process.exit(1)

    // The retail rule must NOT apply here: two people trading at once is the
    // entire point of the mode.
    ok('*** two people hold shifts simultaneously ***', annShift.shiftId !== bobShift.shiftId)
    ok('a second shift for the SAME person is refused', !(await openShift(SITE, ANN, null, 50)).ok)

    const annOpen = await openShiftForUser(SITE, ANN.userId)
    ok('Ann\'s shift is found by her user id', annOpen?.id === annShift.shiftId)
    ok('  and it carries no till', annOpen?.terminalId === null, String(annOpen?.terminalId))
    ok('  and records the mode it was opened under', annOpen?.mode === 'user', String(annOpen?.mode))
    ok('no shift is attached to till 1', (await openShiftFor(SITE, till1)) === null)

    // ── Table sharing: both waiters work both tills ──────────────────────
    ok('Ann sells R100 on till 1', (await sell(ANN, till1, 100)).ok)
    ok('Ann sells R60 on till 2', (await sell(ANN, till2, 60)).ok)
    ok('Bob sells R40 on till 1', (await sell(BOB, till1, 40)).ok)

    const annPos = (await shiftPosition(SITE, annShift.shiftId))!
    const bobPos = (await shiftPosition(SITE, bobShift.shiftId))!

    // THE HEART OF IT: takings follow the PERSON across tills, and one waiter's
    // sale on a shared till never lands in the other's cash-up.
    ok('*** Ann\'s takings are R160 across BOTH tills ***', annPos.takingsTotal === 160, String(annPos.takingsTotal))
    ok('*** Bob\'s takings are only his own R40 ***', bobPos.takingsTotal === 40, String(bobPos.takingsTotal))
    ok('Ann expects float + takings = 360', annPos.expectedCash === 360, String(annPos.expectedCash))
    ok('Bob expects float + takings = 190', bobPos.expectedCash === 190, String(bobPos.expectedCash))
    ok('Ann rang up 2 sales', annPos.salesCount === 2, String(annPos.salesCount))
    ok('Bob rang up 1 sale', bobPos.salesCount === 1, String(bobPos.salesCount))

    // A sale on a till nobody has a shift for still banks to the person.
    const doc = await siteQueryOne<any>(SITE,
      'SELECT shift_id, terminal_id FROM sales_documents WHERE user_id = ? AND terminal_id = ? ORDER BY id DESC LIMIT 1',
      [ANN.userId, till2])
    ok('*** the sale kept its till AND banked to Ann ***',
      Number(doc?.shift_id) === annShift.shiftId && Number(doc?.terminal_id) === till2,
      `shift ${doc?.shift_id} terminal ${doc?.terminal_id}`)

    // ── A payout naming which drawer it came from ────────────────────────
    const fromTill = await recordDrawerMovement(SITE, ANN, annShift.shiftId, { type: 'payout', amount: 30, reason: 'Bread run', terminalId: till1 })
    ok('payout recorded against a named till', fromTill.ok)
    const fromOwn = await recordDrawerMovement(SITE, ANN, annShift.shiftId, { type: 'payout', amount: 20, reason: 'Parking', terminalId: null })
    ok('payout from her own float recorded', fromOwn.ok)
    const moves = await listDrawerMovements(SITE, annShift.shiftId)
    ok('*** the drawer a payout came from is recorded ***',
      moves.some((m) => m.terminalCode?.startsWith('MA')) && moves.some((m) => m.terminalCode === null),
      JSON.stringify(moves.map((m) => `${m.reason}:${m.terminalCode ?? 'own'}`)))

    const afterPayouts = (await shiftPosition(SITE, annShift.shiftId))!
    ok('payouts reduced Ann\'s expected cash to 310', afterPayouts.expectedCash === 310, String(afterPayouts.expectedCash))

    // ── Each reconciles alone ────────────────────────────────────────────
    await setSetting(SITE, 'cashup_variance_tolerance', '5.00')
    const annClose = await closeShift(SITE, ANN, annShift.shiftId, [{ tenderTypeId: cash.id, amount: 310 }])
    ok('*** Ann cashes up exactly ***', annClose.ok && annClose.variance === 0, annClose.ok ? String(annClose.variance) : annClose.error)

    // Bob is untouched by Ann closing — his shift is a separate reconciliation.
    const bobStill = await getShift(SITE, bobShift.shiftId)
    ok('Bob\'s shift is still open after Ann closes', bobStill?.isOpen === true)
    const bobClose = await closeShift(SITE, BOB, bobShift.shiftId, [{ tenderTypeId: cash.id, amount: 180 }], 'Ten rand light, checked with the manager')
    ok('Bob cashes up R10 short', bobClose.ok && bobClose.variance === -10, bobClose.ok ? String(bobClose.variance) : bobClose.error)

    // Closing frees the person, not a till.
    const annAgain = await openShift(SITE, ANN, null, 100)
    ok('Ann can open a fresh shift once closed', annAgain.ok)
    if (annAgain.ok) await closeShift(SITE, ANN, annAgain.shiftId, [], 'Test cleanup')

    // ── Switching back to terminal mode ──────────────────────────────────
    await setSetting(SITE, 'cashup_mode', 'terminal')
    ok('*** back in terminal mode ***', (await cashupMode(SITE)) === 'terminal')

    const tillShift = await openShift(SITE, ANN, till1, 500)
    ok('a till shift opens again', tillShift.ok, tillShift.ok ? '' : tillShift.error)
    if (tillShift.ok) {
      ok('a second shift on that till is refused once more', !(await openShift(SITE, BOB, till1, 100)).ok)
      // In terminal mode the user index must not fire: Ann already had shifts.
      ok('*** but a DIFFERENT till still opens for the same person ***', (await openShift(SITE, ANN, till2, 100)).ok)

      const banked = await shiftToBankInto(SITE, till1, BOB.userId)
      ok('*** in terminal mode the TILL decides, not the person ***', banked === tillShift.shiftId, String(banked))

      // Cleanup of the two open till shifts.
      const open = await siteQuery<any>(SITE, 'SELECT id FROM shifts WHERE closed_at IS NULL AND terminal_id IN (?,?)', [till1, till2])
      for (const s of open) await closeShift(SITE, ANN, Number(s.id), [], 'Test cleanup')
    }

    ok('mode is recorded per shift, so history survives a switch',
      (await getShift(SITE, annShift.shiftId))?.mode === 'user')
  } finally {
    // ── Cleanup ──────────────────────────────────────────────────────────
    await setSetting(SITE, 'cashup_mode', originalMode)

    const shifts = await siteQuery<any>(SITE, 'SELECT id FROM shifts WHERE user_id IN (?,?) OR terminal_id IN (?,?)', [ANN.userId, BOB.userId, till1, till2])
    const ids = shifts.map((s: any) => Number(s.id))
    if (ids.length) {
      await siteExecute(SITE, `UPDATE sales_documents SET shift_id = NULL WHERE shift_id IN (${ids.map(() => '?').join(',')})`, ids)
      await siteExecute(SITE, `UPDATE stock_movements SET shift_id = NULL WHERE shift_id IN (${ids.map(() => '?').join(',')})`, ids)
    }
    const docs = await siteQuery<any>(SITE, 'SELECT id FROM sales_documents WHERE terminal_id IN (?,?)', [till1, till2])
    for (const d of docs) {
      await siteExecute(SITE, 'DELETE FROM stock_movements WHERE source_doc_id = ?', [d.id])
      await siteExecute(SITE, 'DELETE FROM sales_documents WHERE id = ?', [d.id])
    }
    await siteExecute(SITE, 'DELETE FROM shifts WHERE user_id IN (?,?) OR terminal_id IN (?,?)', [ANN.userId, BOB.userId, till1, till2])
    await siteExecute(SITE, 'DELETE FROM terminals WHERE id IN (?,?)', [till1, till2])
    await siteExecute(SITE, 'DELETE FROM stock_movements WHERE product_id = ?', [productId])
    await siteExecute(SITE, 'DELETE FROM products WHERE id = ?', [productId])
  }

  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}
main()
