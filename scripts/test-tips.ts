/**
 * Tips, on the server: planning them, writing them, and who is owed what.
 *
 *   npx tsx --conditions=react-server --env-file=.env scripts/test-tips.ts
 *
 * `test-tip-math` covers the arithmetic with no database. This covers the part that can
 * lose money: the ORDER in which a tip and change claim the same over-tender, and whether
 * a tip can be moved off somebody without a trace.
 *
 * ── THE PROPERTY THIS FILE EXISTS FOR ─────────────────────────────────────
 *
 * A tip and change are two claims on ONE excess. If both are honoured the same rand is
 * recorded twice, the drawer is expected to hold it twice, and every cash-up with a tip in
 * it reads short by exactly the tip. `planTips` returns both halves precisely so
 * finaliseDocument cannot allocate change over money already taken as a tip.
 */
import { siteExecute, siteQuery, siteQueryOne } from '../src/lib/siteDb'
import {
  planTips,
  writeTips,
  tipsForShift,
  expectedTipsInDrawer,
  reassignTip,
  recordServiceChargeRemoval,
  serviceChargeForBill,
  tipsOwed,
  type TenderForTips,
} from '../src/lib/site/tips'
import { siteTransaction } from '../src/lib/siteDb'
import { getTenderByCode } from '../src/lib/site/tenderTypes'
import { saveDraft } from '../src/lib/site/salesDocuments'
import { setSetting, getSetting } from '../src/lib/site/settings'
import { toNum, round } from '../src/lib/decimals'

const SITE = 1
const ACTOR = { userId: 1, userName: 'Tips test' }
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

async function main() {
  const stamp = Date.now().toString().slice(-8)

  /* Sweep an earlier crashed run — tips cascade from their document, so removing the
     documents is enough, but the tiers and removals do not and must go explicitly. */
  const old = await siteQuery<any>(
    SITE,
    "SELECT id FROM sales_documents WHERE customer_name LIKE 'Tips test%'",
  )
  for (const d of old) {
    await siteExecute(SITE, 'DELETE FROM sales_tips WHERE document_id = ?', [d.id])
    await siteExecute(SITE, 'DELETE FROM sales_document_lines WHERE document_id = ?', [d.id])
    await siteExecute(SITE, 'DELETE FROM sales_documents WHERE id = ?', [d.id])
  }
  await siteExecute(SITE, "DELETE FROM service_charge_tiers WHERE percent IN (10,8,5)")
  await siteExecute(SITE, "DELETE FROM service_charge_removals WHERE reason LIKE 'Tips test%'")
  if (old.length) console.log(`      (swept ${old.length} document(s) from an earlier run)`)

  const cash = await getTenderByCode(SITE, 'CASH')
  const card = await getTenderByCode(SITE, 'CARD')
  if (!cash || !card) throw new Error('This site needs a CASH and a CARD tender.')

  const CASH_T: TenderForTips = {
    tenderTypeId: cash.id,
    amount: 0,
    allowsChange: true,
    tipOnOverTender: false,
    tenderName: 'Cash',
  }
  const CARD_T: TenderForTips = {
    tenderTypeId: card.id,
    amount: 0,
    allowsChange: false,
    tipOnOverTender: true,
    tenderName: 'Card',
  }

  /* ── 1. Planning: a tip and change cannot both claim one rand ───────────── */

  {
    /* R120 on a R100 card bill. No change is possible, tips are on, so the whole R20 is a
       tip and NOTHING is left for change. */
    const plan = planTips({ totalExcess: 20, tenders: [{ ...CARD_T, amount: 120 }] })
    ok('a card over-tender becomes a tip', plan.ok && plan.tips.length === 1 && plan.tips[0].amount === 20)
    ok(
      '*** and leaves NOTHING for change to allocate ***',
      plan.ok && plan.changeRemaining === 0,
      plan.ok ? String(plan.changeRemaining) : '',
    )
  }
  {
    /* The same excess on CASH is change, untouched — a till must not decide for itself
       that money nobody offered is a tip. */
    const plan = planTips({ totalExcess: 20, tenders: [{ ...CASH_T, amount: 120 }] })
    ok('*** a cash over-tender stays CHANGE ***', plan.ok && plan.tips.length === 0)
    ok('  with the whole excess still to give back', plan.ok && plan.changeRemaining === 20)
  }
  {
    /* Declared: R100 cash on a R50 bill, R10 declared. R10 tip, R40 change. */
    const plan = planTips({
      totalExcess: 50,
      tenders: [{ ...CASH_T, amount: 100 }],
      declared: { [cash.id]: 10 },
    })
    ok(
      '*** a declared cash tip takes R10 and leaves R40 change ***',
      plan.ok && plan.tips[0]?.amount === 10 && plan.changeRemaining === 40,
      plan.ok ? JSON.stringify(plan) : '',
    )
    ok('  and is recorded as declared', plan.ok && plan.tips[0]?.source === 'declared')
  }
  {
    /* Conservation, the property that keeps a drawer balancing: tips + change always
       equals the excess, whatever the mix of tenders and declarations. */
    let bad = 0
    for (const excess of [0, 1, 7, 20, 55.55, 100]) {
      for (const declared of [0, 1, 10, excess, excess + 10]) {
        const plan = planTips({
          totalExcess: excess,
          tenders: [
            { ...CASH_T, amount: 200 },
            { ...CARD_T, amount: 0 },
          ],
          declared: { [cash.id]: declared },
        })
        if (!plan.ok) continue
        const tipped = plan.tips.reduce((s, t) => s + t.amount, 0)
        if (Math.abs(round(tipped + plan.changeRemaining, 2) - round(excess, 2)) > 0.005) bad++
      }
    }
    ok('*** tips + change always equals the excess ***', bad === 0, `${bad} combination(s) failed`)
  }
  {
    /* A strict no-change tender must REFUSE an over-tender rather than keep it. Keeping a
       mis-keyed R20 because the customer cannot be given change is theft by typo. */
    const plan = planTips({
      totalExcess: 20,
      tenders: [{ ...CARD_T, amount: 120, tipOnOverTender: false }],
    })
    ok('*** a strict card over-tender is REFUSED, not pocketed ***', plan.ok === false)
    ok(
      '  and the message says how to fix it',
      !plan.ok && /turn on tips|correct the amount/i.test(plan.error),
      plan.ok ? '' : plan.error,
    )
  }
  {
    /* A service charge was added to the bill BEFORE payment, so it is already inside what
       the customer settled — it must not also eat the change. */
    const plan = planTips({
      totalExcess: 20,
      tenders: [{ ...CASH_T, amount: 120 }],
      serviceCharge: { tenderTypeId: cash.id, amount: 60 },
    })
    ok(
      '*** a service charge does not compete for the change ***',
      plan.ok && plan.changeRemaining === 20,
      plan.ok ? String(plan.changeRemaining) : '',
    )
    ok('  and is recorded as a service tip', plan.ok && plan.tips.some((t) => t.source === 'service'))
  }

  /* ── 2. Writing them, in the caller's transaction ───────────────────────── */

  const draft = await saveDraft(SITE, ACTOR, {
    docType: 'invoice',
    documentDate: new Date().toISOString().slice(0, 10),
    customerName: `Tips test ${stamp}`,
    lines: [
      { productId: null, description: 'Dinner', qty: 1, unitPriceIncl: 100, vatRatePct: 15, unitCostExcl: 20 },
    ],
  } as never)
  if (!draft.ok) throw new Error(draft.error)
  await siteExecute(SITE, "UPDATE sales_documents SET status='finalised', shift_id=NULL WHERE id=?", [
    draft.id,
  ])

  await siteTransaction(SITE, async (tx) => {
    await writeTips(tx, {
      documentId: draft.id,
      shiftId: null,
      userId: 1,
      userName: 'Ruth',
      tips: [
        { tenderTypeId: cash.id, amount: 20, source: 'declared' },
        { tenderTypeId: card.id, amount: 35, source: 'over_tender' },
      ],
    })
  })

  const written = await siteQuery<any>(
    SITE,
    'SELECT tender_type_id, amount, source, user_id, user_name, original_user_id FROM sales_tips WHERE document_id = ? ORDER BY id',
    [draft.id],
  )
  ok('both tips are written', written.length === 2, String(written.length))
  ok('attributed to the person who served it', written[0]?.user_name === 'Ruth')
  /* Stamped at capture so a later reassignment can always name who it came from. */
  ok('with the original owner stamped', Number(written[0]?.original_user_id) === 1)

  /* ── 3. Cash-up: only what is IN the drawer ─────────────────────────────── */

  {
    /* The card tip is not in the till — it arrives via the card machine and pays out
       through payroll. Expecting it at the counter would leave the shift short by it. */
    const forShift = await tipsForShift(SITE, 0)
    ok('a shift with no tips reads empty', forShift.length === 0)

    /*
     * Columns copied from shifts.ts's own INSERT rather than guessed — my first attempt
     * invented `opened_by_user_id`, `opened_at` and `status`.
     *
     * And a SCRATCH user id, because `uq_shift_open_user` allows one open shift per
     * person and user 1 has a real one on this site. Borrowing it would have meant either
     * failing here or closing somebody's live shift to make a test pass.
     */
    const SCRATCH_USER = 99_123
    await siteExecute(SITE, 'DELETE FROM shifts WHERE user_id = ?', [SCRATCH_USER])
    const shift = await siteExecute(
      SITE,
      `INSERT INTO shifts (mode, terminal_id, terminal_code, user_id, user_name, opening_float)
       VALUES ('user', NULL, NULL, ?, 'Tips test', '0.0000')`,
      [SCRATCH_USER],
    )
    await siteExecute(SITE, 'UPDATE sales_documents SET shift_id = ? WHERE id = ?', [
      shift.insertId,
      draft.id,
    ])
    await siteExecute(SITE, 'UPDATE sales_tips SET shift_id = ? WHERE document_id = ?', [
      shift.insertId,
      draft.id,
    ])

    const tips = await tipsForShift(SITE, shift.insertId)
    ok('the shift now sees both tips', tips.length === 2, String(tips.length))
    const expected = await expectedTipsInDrawer(SITE, shift.insertId)
    ok(
      '*** only the CASH tip is expected in the drawer ***',
      expected === 20,
      `${expected} (cash 20 + card 35 = 55 if the flag were ignored)`,
    )

    await siteExecute(SITE, 'DELETE FROM shifts WHERE id = ?', [shift.insertId])
  }

  /* ── 4. Service-charge tiers, and the tables-only setting ───────────────── */

  await siteExecute(
    SITE,
    `INSERT INTO service_charge_tiers (min_total, max_total, percent, is_active)
     VALUES ('500.00','1000.00','10.000',1), ('1000.00','1500.00','8.000',1), ('1500.00',NULL,'5.000',1)`,
  )

  const previous = await getSetting(SITE, 'tips_tables_only')
  try {
    await setSetting(SITE, 'tips_tables_only', '1')
    ok(
      '*** with tables-only ON, a counter sale earns no service charge ***',
      (await serviceChargeForBill(SITE, { total: 600, hasTable: false })) === 0,
    )
    ok(
      '  but a table does',
      (await serviceChargeForBill(SITE, { total: 600, hasTable: true })) === 60,
      String(await serviceChargeForBill(SITE, { total: 600, hasTable: true })),
    )

    await setSetting(SITE, 'tips_tables_only', '0')
    ok(
      'with it OFF, a counter sale earns one too',
      (await serviceChargeForBill(SITE, { total: 600, hasTable: false })) === 60,
    )
  } finally {
    await setSetting(SITE, 'tips_tables_only', previous ?? '1')
  }

  /* ── 5. A tip cannot be moved off somebody quietly ──────────────────────── */

  const tipId = Number(
    (await siteQueryOne<any>(SITE, 'SELECT id FROM sales_tips WHERE document_id = ? LIMIT 1', [draft.id]))
      ?.id,
  )

  const noReason = await reassignTip(SITE, ACTOR, {
    tipId,
    toUserId: null,
    toUserName: '',
    reason: '   ',
  })
  ok('reassigning with no reason is REFUSED', noReason.ok === false, noReason.ok ? '' : noReason.error)

  const moved = await reassignTip(SITE, { userId: 7, userName: 'Manager Mo' }, {
    tipId,
    toUserId: null,
    toUserName: '',
    reason: 'Tips test — moved to the pool',
  })
  ok('a tip moves to the pool', moved.ok === true, moved.ok ? '' : moved.error)

  const after = await siteQueryOne<any>(
    SITE,
    'SELECT user_id, original_user_id, reassigned_by, reassigned_by_name, reassign_reason FROM sales_tips WHERE id = ?',
    [tipId],
  )
  /* NULL user_id IS the pool — there is no separate flag to disagree with it. */
  ok('the pool is a null owner', after?.user_id === null)
  ok(
    '*** and the trail names who it came from and who moved it ***',
    Number(after?.original_user_id) === 1 && Number(after?.reassigned_by) === 7,
    JSON.stringify(after),
  )
  ok('with the reason kept', /moved to the pool/i.test(String(after?.reassign_reason ?? '')))

  {
    /* Moved twice: original_user_id must still name the FIRST owner, not the last holder,
       or the trail loses the person the tip actually came from. */
    await reassignTip(SITE, { userId: 7, userName: 'Manager Mo' }, {
      tipId,
      toUserId: 2,
      toUserName: 'Second Person',
      reason: 'Tips test — moved again',
    })
    const twice = await siteQueryOne<any>(
      SITE,
      'SELECT user_id, original_user_id FROM sales_tips WHERE id = ?',
      [tipId],
    )
    ok(
      '*** moved twice, the original owner is still the FIRST one ***',
      Number(twice?.original_user_id) === 1 && Number(twice?.user_id) === 2,
      JSON.stringify(twice),
    )
  }

  /* ── 6. The owed report, including the pool ─────────────────────────────── */

  const today = new Date().toISOString().slice(0, 10)
  const owed = await tipsOwed(SITE, { from: today, to: today })
  ok('the owed report returns rows', owed.length > 0, String(owed.length))
  ok(
    'and the amounts are real numbers',
    owed.every((r) => Number.isFinite(r.total) && r.total > 0),
    JSON.stringify(owed.slice(0, 3)),
  )

  /* ── 7. A removed service charge is recorded ────────────────────────────── */

  await recordServiceChargeRemoval(SITE, { userId: 7, userName: 'Manager Mo' }, {
    documentId: draft.id,
    amount: 60,
    reason: 'Tips test — customer refused',
  })
  const removal = await siteQueryOne<any>(
    SITE,
    'SELECT amount, user_name, reason FROM service_charge_removals WHERE document_id = ?',
    [draft.id],
  )
  /* A forced charge that a manager removes must leave a record — that is what makes the
     policy enforceable rather than merely strict. */
  ok(
    '*** removing a forced service charge is recorded with who did it ***',
    toNum(removal?.amount) === 60 && removal?.user_name === 'Manager Mo',
    JSON.stringify(removal),
  )

  /* ── Clean up ───────────────────────────────────────────────────────────── */

  await siteExecute(SITE, 'DELETE FROM service_charge_removals WHERE document_id = ?', [draft.id])
  await siteExecute(SITE, 'DELETE FROM sales_tips WHERE document_id = ?', [draft.id])
  await siteExecute(SITE, 'DELETE FROM sales_document_lines WHERE document_id = ?', [draft.id])
  await siteExecute(SITE, 'DELETE FROM sales_documents WHERE id = ?', [draft.id])
  await siteExecute(SITE, "DELETE FROM service_charge_tiers WHERE percent IN ('10.000','8.000','5.000')")

  console.log(fails === 0 ? '\nAll tips checks passed.' : `\n${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}

main()
