/**
 * Cash that reaches the drawer without a sale posting.
 *
 *   npm run test:offledger-cash
 *
 * ── WHAT THIS IS FOR ──────────────────────────────────────────────────────
 *
 * `expectedCash` was derived from `sales_tenders` alone — every rand that
 * arrived as part of a posted sale, and nothing else. But a lay-by deposit, a
 * deposit against a quote, a gift card sold and a loyalty top-up are all real
 * money handed over a counter, and none of them posts a sale at the moment it
 * is taken. That is the point of each: the customer pays now for something
 * that completes later.
 *
 * The declaration screen already SHOWED them. What it did not do was count
 * them, so a shift that took a R500 lay-by deposit displayed "Lay-by deposits
 * R500" beside an expected figure that excluded it — the drawer read R500 OVER,
 * and the cashier was asked to explain a surplus the screen had just told them
 * about. Acting on that reading (banking the surplus) takes out money the
 * lay-by is owed.
 *
 * ── WHAT IS ASSERTED ──────────────────────────────────────────────────────
 *
 *   1. A cash lay-by deposit raises expectedCash by exactly its amount.
 *   2. A CARD lay-by does not — that money is on the bank statement, and
 *      counting it would break the drawer in the opposite direction.
 *   3. The close agrees with the position, so a drawer holding the deposit
 *      reconciles to zero variance rather than closing "over".
 *   4. A shift whose ONLY money is a lay-by still expects its float — the
 *      drawer-wide figures used to be attached to a cash SALES row that a
 *      shift like that never has.
 *   5. Applying a deposit to a sale is not counted twice.
 */
import { siteExecute, siteQuery, siteQueryOne } from '../src/lib/siteDb'
import {
  openShift,
  closeShift,
  shiftPosition,
  offLedgerCash,
  shiftCounts,
} from '../src/lib/site/shifts'
import { getTenderByCode } from '../src/lib/site/tenderTypes'
import { setSetting } from '../src/lib/site/settings'
import { round } from '../src/lib/decimals'

const SITE = 1
const actor = { userId: 1, userName: 'Off-ledger test' }

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

/** The lowest free till number — `till_number` is UNIQUE. */
async function freeTillNumber(): Promise<number> {
  const row = await siteQueryOne<any>(
    SITE,
    'SELECT COALESCE(MAX(till_number), 0) + 1 AS n FROM terminals',
  )
  return Number(row?.n ?? 1)
}

/**
 * A lay-by with one payment against it, banked into `shiftId`.
 *
 * Written with raw SQL rather than through `takePayment`, deliberately: that
 * function resolves the shift ITSELF from the terminal, and a test that went
 * through it would be asserting on its own setup. Here the shift is stated, so
 * what is under test is only whether the cash-up counts it.
 */
async function layByPayment(
  shiftId: number,
  tenderTypeId: number,
  tenderName: string,
  amount: number,
  kind: 'deposit' | 'instalment' = 'deposit',
): Promise<{ laybyId: number; paymentId: number }> {
  /* customer_id is NOT NULL — a lay-by is always somebody's. Any customer will
     do here; what is under test is the drawer arithmetic, not the debtor. */
  const customer = await siteQueryOne<any>(SITE, 'SELECT id FROM customers LIMIT 1')
  if (!customer) throw new Error('the site needs at least one customer')

  const layby = await siteExecute(
    SITE,
    `INSERT INTO laybys (customer_id, status, total_incl, paid_total, user_name)
     VALUES (?, 'open', ?, ?, ?)`,
    [customer.id, amount.toFixed(4), amount.toFixed(4), actor.userName],
  )
  const payment = await siteExecute(
    SITE,
    `INSERT INTO layby_payments
       (layby_id, kind, amount, tender_type_id, tender_name, paid_on, shift_id, user_id, user_name)
     VALUES (?, ?, ?, ?, ?, CURDATE(), ?, ?, ?)`,
    [
      layby.insertId,
      kind,
      amount.toFixed(4),
      tenderTypeId,
      tenderName,
      shiftId,
      actor.userId,
      actor.userName,
    ],
  )
  return { laybyId: layby.insertId, paymentId: payment.insertId }
}

async function main() {
  const stamp = Date.now().toString().slice(-8)
  const cash = await getTenderByCode(SITE, 'CASH')
  const card = await getTenderByCode(SITE, 'CARD')
  if (!cash || !card) throw new Error('CASH and CARD tender types are required')
  ok('CASH counts as drawer cash', cash.countsAsDrawerCash === true)
  ok('CARD does not', card.countsAsDrawerCash === false)

  await setSetting(SITE, 'cashup_variance_tolerance', '0.00')

  const term = await siteExecute(
    SITE,
    'INSERT INTO terminals (code, name, till_number) VALUES (?,?,?)',
    [`OL${stamp}`.slice(0, 24), 'Off-ledger test till', await freeTillNumber()],
  )
  const terminalId = term.insertId
  const laybyIds: number[] = []

  try {
    /* ── 1 & 2. A cash lay-by counts; a card one does not ─────────────────── */

    const FLOAT = 200
    const opened = await openShift(SITE, actor, terminalId, FLOAT)
    if (!opened.ok) throw new Error(`could not open a shift: ${opened.error}`)
    const shiftId = opened.shiftId

    const before = await shiftPosition(SITE, shiftId)
    ok('a fresh shift expects exactly its float', before?.expectedCash === FLOAT, String(before?.expectedCash))
    ok('  and no off-ledger cash yet', before?.offLedgerTotal === 0, String(before?.offLedgerTotal))

    const cashLayby = await layByPayment(shiftId, cash.id, 'Cash', 500)
    laybyIds.push(cashLayby.laybyId)

    const afterCash = await shiftPosition(SITE, shiftId)
    ok(
      '*** a cash lay-by deposit raises the expected drawer ***',
      afterCash?.expectedCash === FLOAT + 500,
      `${FLOAT} + 500 = ${afterCash?.expectedCash}`,
    )
    ok('  and is reported as off-ledger', afterCash?.offLedgerTotal === 500, String(afterCash?.offLedgerTotal))

    const cardLayby = await layByPayment(shiftId, card.id, 'Card', 750)
    laybyIds.push(cardLayby.laybyId)

    const afterCard = await shiftPosition(SITE, shiftId)
    /*
     * THE ASSERTION THAT KEEPS THE FIX HONEST.
     *
     * Counting every lay-by rather than only the cash ones would be an easy
     * version of this change and a worse bug than the one it fixes: the drawer
     * would read SHORT by every card payment, and a cashier would be asked to
     * find money that was never in the till.
     */
    ok(
      '*** a CARD lay-by does not touch the drawer ***',
      afterCard?.expectedCash === FLOAT + 500,
      `still ${afterCard?.expectedCash} after a 750 card payment`,
    )

    /* Sanity: the helper reports the same figure the position uses. */
    ok(
      '  offLedgerCash agrees with the position',
      (await offLedgerCash(SITE, shiftId)) === afterCard?.offLedgerTotal,
      String(await offLedgerCash(SITE, shiftId)),
    )

    /* ── 3 & 4. The close agrees, with no cash SALE anywhere ──────────────── */

    /*
     * This shift rang up nothing at all — its only money is the float and one
     * lay-by. That is what makes it the interesting case: `position.tenders`
     * has no rows, because there are no sales tenders, so before this work the
     * close expected R0.00 against a drawer holding R700 and reported the float
     * itself as a surplus.
     */
    const counted = FLOAT + 500
    const closed = await closeShift(SITE, actor, shiftId, [
      { tenderTypeId: cash.id, amount: counted },
    ])
    ok(
      '*** a drawer holding the float and the deposit reconciles ***',
      closed.ok && closed.variance === 0,
      closed.ok ? `variance ${closed.variance}` : closed.error,
    )

    const counts = await shiftCounts(SITE, shiftId)
    const cashRow = counts.find((c) => c.tenderCode === 'CASH')
    ok(
      '  the frozen cash row expects float + deposit',
      cashRow?.expected === counted,
      `expected ${cashRow?.expected}, counted ${cashRow?.counted}`,
    )

    /* ── 5. An applied deposit is not counted twice ───────────────────────── */

    /*
     * Applying a deposit moves NO cash: the money went into the drawer when the
     * deposit was taken, and the sale posting now records its own tender. A
     * naive "sum every sale_deposits row" would count the same note on its way
     * in and again on its way out.
     */
    const second = await openShift(SITE, actor, terminalId, 0)
    if (!second.ok) throw new Error(`could not open a second shift: ${second.error}`)

    await siteExecute(
      SITE,
      `INSERT INTO sale_deposits
         (document_id, basket_uid, kind, amount, tender_type_id, tender_name, taken_on,
          shift_id, user_id, user_name)
       VALUES (NULL, ?, 'deposit', ?, ?, 'Cash', CURDATE(), ?, ?, ?)`,
      [`OLTEST${stamp}`, '300.0000', cash.id, second.shiftId, actor.userId, actor.userName],
    )
    const withDeposit = await shiftPosition(SITE, second.shiftId)
    ok(
      'a sale deposit reaches the drawer',
      withDeposit?.offLedgerTotal === 300,
      String(withDeposit?.offLedgerTotal),
    )

    await siteExecute(
      SITE,
      `INSERT INTO sale_deposits
         (document_id, basket_uid, kind, amount, tender_type_id, tender_name, taken_on,
          shift_id, user_id, user_name)
       VALUES (NULL, ?, 'applied', ?, ?, 'Cash', CURDATE(), ?, ?, ?)`,
      [`OLTEST${stamp}`, '-300.0000', cash.id, second.shiftId, actor.userId, actor.userName],
    )
    const afterApply = await shiftPosition(SITE, second.shiftId)
    ok(
      '*** applying it moves no more cash ***',
      afterApply?.offLedgerTotal === 300,
      `still ${afterApply?.offLedgerTotal} after the apply row`,
    )

    /* A refund DOES move cash, outward — asserted alongside so the sign is
       pinned down rather than assumed. */
    await siteExecute(
      SITE,
      `INSERT INTO sale_deposits
         (document_id, basket_uid, kind, amount, tender_type_id, tender_name, taken_on,
          shift_id, user_id, user_name)
       VALUES (NULL, ?, 'refund', ?, ?, 'Cash', CURDATE(), ?, ?, ?)`,
      [`OLTEST${stamp}R`, '-120.0000', cash.id, second.shiftId, actor.userId, actor.userName],
    )
    const afterRefund = await shiftPosition(SITE, second.shiftId)
    ok(
      'a refunded deposit takes cash back OUT',
      afterRefund?.offLedgerTotal === 180,
      `300 - 120 = ${afterRefund?.offLedgerTotal}`,
    )

    await closeShift(SITE, actor, second.shiftId, [{ tenderTypeId: cash.id, amount: 180 }])
  } finally {
    /* ── Cleanup ───────────────────────────────────────────────────────────
       Leaving rows behind here is what makes an unrelated suite fail later —
       see the run notes on test litter. */
    await siteExecute(SITE, 'DELETE FROM sale_deposits WHERE basket_uid LIKE ?', [
      `OLTEST${stamp}%`,
    ]).catch(() => null)
    for (const id of laybyIds) {
      await siteExecute(SITE, 'DELETE FROM layby_payments WHERE layby_id = ?', [id]).catch(() => null)
      await siteExecute(SITE, 'DELETE FROM laybys WHERE id = ?', [id]).catch(() => null)
    }
    /* The close mirrors a variance to the ledger when there is one. These shifts
       close clean, but a failed run mid-way might not have — give any back, then
       repair the balances the lines were counted into. */
    const batches = await siteQuery<any>(
      SITE,
      `SELECT id FROM journal_batches WHERE source = 'cashup'
         AND source_doc_id IN (SELECT id FROM shifts WHERE terminal_id = ?)`,
      [terminalId],
    ).catch(() => [])
    for (const b of batches) {
      await siteExecute(SITE, 'DELETE FROM journal_lines WHERE batch_id = ?', [b.id]).catch(() => null)
      await siteExecute(SITE, 'DELETE FROM journal_batches WHERE id = ?', [b.id]).catch(() => null)
    }
    if (batches.length > 0) {
      await siteExecute(
        SITE,
        `UPDATE gl_accounts a
            SET a.balance = COALESCE((
                  SELECT SUM(l.amount) FROM journal_lines l
                    JOIN journal_batches b ON b.id = l.batch_id
                   WHERE l.account_id = a.id AND b.status = 'posted'
                ), 0)`,
      ).catch(() => null)
    }
    await siteExecute(
      SITE,
      'DELETE FROM shift_counts WHERE shift_id IN (SELECT id FROM shifts WHERE terminal_id = ?)',
      [terminalId],
    ).catch(() => null)
    await siteExecute(SITE, 'DELETE FROM shifts WHERE terminal_id = ?', [terminalId]).catch(
      () => null,
    )
    await siteExecute(SITE, 'DELETE FROM document_sequences WHERE terminal_id = ?', [
      terminalId,
    ]).catch(() => null)
    await siteExecute(SITE, 'DELETE FROM terminals WHERE id = ?', [terminalId]).catch(() => null)
  }

  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
