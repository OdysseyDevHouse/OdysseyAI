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
import { finaliseDocument } from '../src/lib/site/salesPosting'
import { shiftPosition } from '../src/lib/site/shifts'
import { postOfflineSale } from '../src/lib/site/offlineSync'
import { setSetting, getSetting } from '../src/lib/site/settings'
import { toNum, round } from '../src/lib/decimals'

const SITE = 1
const ACTOR = { userId: 1, userName: 'Tips test' }
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}


/**
 * A till number no terminal is using.
 *
 * QUERIED, never hardcoded: several suites make scratch terminals and till_number is
 * UNIQUE, so a fixed value dies on a leftover row before reaching an assertion.
 */
async function freeTillNumber(): Promise<string> {
  const rows = await siteQuery<{ till_number: string }>(
    SITE,
    'SELECT till_number FROM terminals WHERE till_number IS NOT NULL',
  )
  const taken = new Set(rows.map((r) => String(r.till_number)))
  for (let n = 99; n >= 50; n--) if (!taken.has(String(n))) return String(n)
  throw new Error('No free till number in 50..99 — sweep the scratch terminals.')
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

  /* ── 8. A REAL tipped sale, and a drawer that balances ─────────────────────
     Everything above tests the parts. This posts a sale through finaliseDocument with a
     declared tip and then asks closeShift's own arithmetic what the drawer should hold —
     which is the only assertion that catches the two halves disagreeing. */

  {
    const SCRATCH_USER = 99_124
    await siteExecute(SITE, 'DELETE FROM shifts WHERE user_id = ?', [SCRATCH_USER])
    const shift = await siteExecute(
      SITE,
      `INSERT INTO shifts (mode, terminal_id, terminal_code, user_id, user_name, opening_float)
       VALUES ('user', NULL, NULL, ?, 'Tips finalise test', '100.0000')`,
      [SCRATCH_USER],
    )

    const sale = await saveDraft(SITE, ACTOR, {
      docType: 'invoice',
      documentDate: new Date().toISOString().slice(0, 10),
      customerName: `Tips test finalise ${stamp}`,
      lines: [
        { productId: null, description: 'Dinner', qty: 1, unitPriceIncl: 50, vatRatePct: 15, unitCostExcl: 10 },
      ],
    } as never)
    if (!sale.ok) throw new Error(sale.error)

    /* R100 handed over on a R50 bill, R10 declared as a tip. So: R10 tip, R40 change. */
    const posted = await finaliseDocument(SITE, ACTOR, {
      documentId: sale.id,
      shiftId: shift.insertId,
      tenders: [{ tenderTypeId: cash.id, amount: 100 }],
      declaredTips: { [cash.id]: 10 },
    } as never)
    ok('a tipped sale finalises', posted.ok === true, posted.ok ? '' : posted.error)

    if (posted.ok) {
      ok('*** and hands back R40, not R50 ***', posted.change === 40, String(posted.change))

      const tip = await siteQueryOne<any>(
        SITE,
        'SELECT amount, source, shift_id FROM sales_tips WHERE document_id = ?',
        [sale.id],
      )
      ok('the tip row is written by the finalise', toNum(tip?.amount) === 10, String(tip?.amount))
      ok('  as declared', tip?.source === 'declared')
      ok('  banked into the shift that took it', Number(tip?.shift_id) === shift.insertId)

      const tender = await siteQueryOne<any>(
        SITE,
        'SELECT amount, change_given FROM sales_tenders WHERE document_id = ?',
        [sale.id],
      )
      ok(
        'the tender records what was HANDED OVER',
        toNum(tender?.amount) === 100,
        String(tender?.amount),
      )
      ok(
        '*** and change_given is R40 — the tip is NOT given back ***',
        toNum(tender?.change_given) === 40,
        String(tender?.change_given),
      )

      const invoice = await siteQueryOne<any>(
        SITE,
        'SELECT total_incl, subtotal_excl, vat_total FROM sales_documents WHERE id = ?',
        [sale.id],
      )
      /* The whole reason a tip is not a line: the invoice is the goods, and it still
         balances. A tip line would have made this 60 with VAT on a gratuity. */
      ok(
        '*** the INVOICE is still R50 — no VAT on the tip ***',
        toNum(invoice?.total_incl) === 50,
        String(invoice?.total_incl),
      )
      ok(
        '  and it still balances',
        round(toNum(invoice?.subtotal_excl) + toNum(invoice?.vat_total), 2) === 50,
        `${invoice?.subtotal_excl} + ${invoice?.vat_total}`,
      )

      /*
       * THE ONE THAT MATTERS. closeShift's own arithmetic, unmodified.
       *
       * R100 opening float + (R100 handed over − R40 change) = R160. The R10 tip is inside
       * that already, because `amount - change_given` counts it — which is why closeShift
       * needed NO change for tips, and why adding expectedTipsInDrawer to it would have
       * double-counted every one.
       */
      const position = await shiftPosition(SITE, shift.insertId)
      ok(
        '*** the expected drawer is R160 — the tip counted exactly once ***',
        position !== null && position.expectedCash === 160,
        `${position?.expectedCash} (float 100 + 100 taken − 40 change)`,
      )
      /* And the reporting figure agrees about how much of it is gratuity. */
      const gratuity = await expectedTipsInDrawer(SITE, shift.insertId)
      ok('  of which R10 is a tip', gratuity === 10, String(gratuity))

      await siteExecute(SITE, 'DELETE FROM sales_tips WHERE document_id = ?', [sale.id])
      await siteExecute(SITE, 'DELETE FROM sales_tenders WHERE document_id = ?', [sale.id])
      await siteExecute(SITE, 'DELETE FROM sales_document_lines WHERE document_id = ?', [sale.id])
      await siteExecute(SITE, 'DELETE FROM stock_movements WHERE document_id = ?', [sale.id]).catch(
        () => null,
      )
      await siteExecute(SITE, 'DELETE FROM sales_documents WHERE id = ?', [sale.id])
    }
    await siteExecute(SITE, 'DELETE FROM shifts WHERE id = ?', [shift.insertId])
  }

  /* ── 9. A tip rung up OFFLINE survives the round trip ──────────────────────
     The gap this closes was worse than "tips are lost": the offline slip reported the whole
     excess as change, so a customer leaving a R150 card tip was told the till owed them
     R150 — and at sync the server planned no tip either, so the money silently became
     change on the books. Both halves wrong in the same direction. */

  {
    const SCRATCH_TILL = await freeTillNumber()
    const tillIns = await siteExecute(
      SITE,
      'INSERT INTO terminals (code, till_number, name, is_active) VALUES (?,?,?,1)',
      [`TIPOFF${stamp}`.slice(0, 24), SCRATCH_TILL, `Tips offline till ${stamp}`],
    )
    const terminalId = tillIns.insertId
    await siteExecute(
      SITE,
      `INSERT INTO document_sequences (terminal_id, doc_type, prefix, next_number, padding)
       VALUES (?, 'invoice', 'INV', 1, 6) ON DUPLICATE KEY UPDATE doc_type = doc_type`,
      [terminalId],
    )

    const uid = `30000000-3000-4000-8000-${Date.now().toString(16).padStart(12, '0').slice(-12)}`
    const offlineSale = {
      saleUid: uid,
      documentNumber: `INV_01_${SCRATCH_TILL}_000501`,
      terminalId,
      terminalCode: `TIPOFF${stamp}`.slice(0, 24),
      operatorUserId: 1,
      operatorName: 'Offline tipper',
      shiftId: null,
      takenAt: new Date().toISOString(),
      documentDate: new Date().toISOString().slice(0, 10),
      priceStructureId: null,
      customerId: null,
      customerName: 'Offline tip test',
      customerVatNo: null,
      customerPhone: null,
      lines: [
        {
          productId: null,
          productCode: null,
          description: 'Dinner',
          productType: 'normal' as const,
          departmentId: null,
          qty: 1,
          unitPriceIncl: 100,
          discountPct: 0,
          specialId: null,
          vatRatePct: 15,
          unitCostExcl: 20,
        },
      ],
      /* R150 on a R100 bill, on CARD — which gives no change. With tips on, the R50 excess
         is a tip; the slip said so, and the sync must agree. */
      tenders: [{ tenderTypeId: card.id, tenderCode: 'CARD', amount: 150, reference: null }],
      claimedTotalIncl: 100,
      claimedTenderedTotal: 150,
      claimedChange: 0,
      declaredTips: {},
      serviceCharge: 0,
    }

    /* CARD must accept tips for this to be a tip rather than a refusal. Restored after. */
    const cardBefore = await siteQueryOne<any>(
      SITE,
      'SELECT tip_on_over_tender FROM tender_types WHERE id = ?',
      [card.id],
    )
    await siteExecute(SITE, 'UPDATE tender_types SET tip_on_over_tender = 1 WHERE id = ?', [card.id])

    try {
      const synced = await postOfflineSale(SITE, offlineSale as never)
      ok('an offline sale with a tip posts', synced.ok === true, synced.error ?? '')

      if (synced.ok) {
        const tip = await siteQueryOne<any>(
          SITE,
          'SELECT amount, source FROM sales_tips WHERE document_id = ?',
          [synced.documentId],
        )
        ok(
          '*** the R50 card excess becomes a TIP at sync, not change ***',
          toNum(tip?.amount) === 50,
          `tip = ${tip?.amount ?? 'none'}`,
        )
        ok('  recorded as an over-tender', tip?.source === 'over_tender', String(tip?.source))

        const tender = await siteQueryOne<any>(
          SITE,
          'SELECT amount, change_given FROM sales_tenders WHERE document_id = ?',
          [synced.documentId],
        )
        ok(
          '*** and NO change is recorded against the card ***',
          toNum(tender?.change_given) === 0,
          `change_given = ${tender?.change_given}`,
        )
        ok('  with the full amount handed over', toNum(tender?.amount) === 150)

        const doc = await siteQueryOne<any>(
          SITE,
          'SELECT total_incl FROM sales_documents WHERE id = ?',
          [synced.documentId],
        )
        ok('  the invoice is still R100', toNum(doc?.total_incl) === 100, String(doc?.total_incl))

        await siteExecute(SITE, 'DELETE FROM sales_tips WHERE document_id = ?', [synced.documentId])
        await siteExecute(SITE, 'DELETE FROM sales_tenders WHERE document_id = ?', [synced.documentId])
        await siteExecute(SITE, 'DELETE FROM sales_document_lines WHERE document_id = ?', [synced.documentId])
        await siteExecute(SITE, 'DELETE FROM stock_movements WHERE document_id = ?', [synced.documentId]).catch(() => null)
        await siteExecute(SITE, 'DELETE FROM sales_documents WHERE id = ?', [synced.documentId])
      }

      /*
       * AND an OLD queued sale — one with no tip fields at all — must still post.
       *
       * The outbox is the one store whose rows cannot be recreated, so a sale queued before
       * tips shipped has to go through unchanged. `declaredTips` and `serviceCharge` are
       * optional for exactly this.
       */
      const legacyUid = `30000000-3000-4000-8000-${(Date.now() + 1).toString(16).padStart(12, '0').slice(-12)}`
      const { declaredTips: _d, serviceCharge: _s, ...legacy } = offlineSale
      const legacySale = {
        ...legacy,
        saleUid: legacyUid,
        documentNumber: `INV_01_${SCRATCH_TILL}_000502`,
        tenders: [{ tenderTypeId: cash.id, tenderCode: 'CASH', amount: 100, reference: null }],
      }
      const legacyPosted = await postOfflineSale(SITE, legacySale as never)
      ok(
        '*** a sale queued BEFORE tips existed still posts ***',
        legacyPosted.ok === true,
        legacyPosted.error ?? '',
      )
      if (legacyPosted.ok) {
        const none = await siteQueryOne<any>(
          SITE,
          'SELECT COUNT(*) AS n FROM sales_tips WHERE document_id = ?',
          [legacyPosted.documentId],
        )
        ok('  with no tip invented for it', toNum(none?.n) === 0, String(none?.n))
        await siteExecute(SITE, 'DELETE FROM sales_tenders WHERE document_id = ?', [legacyPosted.documentId])
        await siteExecute(SITE, 'DELETE FROM sales_document_lines WHERE document_id = ?', [legacyPosted.documentId])
        await siteExecute(SITE, 'DELETE FROM stock_movements WHERE document_id = ?', [legacyPosted.documentId]).catch(() => null)
        await siteExecute(SITE, 'DELETE FROM sales_documents WHERE id = ?', [legacyPosted.documentId])
      }
    } finally {
      await siteExecute(SITE, 'UPDATE tender_types SET tip_on_over_tender = ? WHERE id = ?', [
        cardBefore?.tip_on_over_tender ?? 0,
        card.id,
      ])
      await siteExecute(SITE, 'DELETE FROM offline_sync_claims WHERE sale_uid IN (?,?)', [
        uid,
        `30000000-3000-4000-8000-${(Date.now() + 1).toString(16).padStart(12, '0').slice(-12)}`,
      ]).catch(() => null)
      await siteExecute(SITE, 'DELETE FROM document_sequences WHERE terminal_id = ?', [terminalId])
      await siteExecute(SITE, 'DELETE FROM terminals WHERE id = ?', [terminalId])
    }
  }

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
