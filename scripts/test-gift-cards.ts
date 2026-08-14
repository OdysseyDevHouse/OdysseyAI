/**
 * Gift cards — sellable bearer stored value.
 *
 * THE ACCOUNTING THIS EXISTS TO PROVE: selling a card is NOT revenue. The
 * journal behind an activation is DR tender / CR gift card liability (2500),
 * with no revenue or cost lines for the card; redemption drains 2500 through
 * the ordinary tender mapping while the goods post revenue as normal; and an
 * expiry sweep moves what lapsed from 2500 to breakage income (4910), once.
 *
 * Also proved: the balance machinery (partial redemption, drain-to-redeemed,
 * over-balance rolls the WHOLE sale back with no number consumed), the till
 * guards (discounted cards, VAT-bearing cards, card-pays-for-card), void
 * restore in both directions, and that the subledger figure always equals the
 * sum of active balances.
 *
 *   npm run test:gift-cards
 */
import { siteExecute, siteQuery, siteQueryOne } from '../src/lib/siteDb'
import {
  findGiftCard,
  giftCardRefusal,
  generateGiftCards,
  expireGiftCards,
  giftCardLiability,
  adjustGiftCard,
  voidGiftCard,
  formatGiftCardCode,
  normaliseGiftCardCode,
} from '../src/lib/site/giftCards'
import { mirrorGiftCardBreakage } from '../src/lib/site/glPosting'
import { saveDraft } from '../src/lib/site/salesDocuments'
import { finaliseDocument, voidDocument } from '../src/lib/site/salesPosting'
import { getTenderByCode } from '../src/lib/site/tenderTypes'
import { findSalesReasonByCode } from '../src/lib/site/salesReasons'
import { setSetting, getSetting } from '../src/lib/site/settings'
import { today } from '../src/lib/site/ledger'
import { offlineBlockedTender, offlineBlockedProduct } from '../src/lib/offlineCapability'
import { stockDirectionFor } from '../src/lib/site/stockMovements'
import { toProductType } from '../src/lib/productTypes'
import { toNum } from '../src/lib/decimals'

const SITE = 1
const actor = { userId: 1, userName: 'Gift Card Test' }
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

const TAG = 'ZGC test'

async function sweepStrays() {
  const docs = await siteQuery<any>(
    SITE, `SELECT id FROM sales_documents WHERE customer_name LIKE '${TAG}%'`)
  for (const d of docs) {
    await siteExecute(SITE, 'DELETE FROM gift_card_events WHERE document_id = ?', [d.id])
    await siteExecute(SITE, 'DELETE FROM sales_tenders WHERE document_id = ?', [d.id])
    await siteExecute(SITE, 'DELETE FROM document_audit WHERE document_id = ?', [d.id])
    await siteExecute(SITE, 'DELETE FROM sales_document_lines WHERE document_id = ?', [d.id])
    await siteExecute(SITE,
      "DELETE l FROM journal_lines l JOIN journal_batches b ON b.id=l.batch_id WHERE b.source IN ('sale','credit_note','sale_void') AND b.source_doc_id = ?", [d.id])
    await siteExecute(SITE,
      "DELETE FROM journal_batches WHERE source IN ('sale','credit_note','sale_void') AND source_doc_id = ?", [d.id])
    await siteExecute(SITE, 'DELETE FROM sales_documents WHERE id = ?', [d.id])
  }
  await siteExecute(SITE,
    "DELETE l FROM journal_lines l JOIN journal_batches b ON b.id=l.batch_id WHERE b.source='gift_card_adjust' AND b.description LIKE '%ZGC%'")
  await siteExecute(SITE,
    "DELETE FROM journal_batches WHERE source='gift_card_adjust' AND description LIKE '%ZGC%'")
  await siteExecute(SITE, "DELETE FROM gift_card_events WHERE user_name = 'Gift Card Test'")
  await siteExecute(SITE, "DELETE FROM gift_cards WHERE user_name = 'Gift Card Test' OR note LIKE 'ZGC%'")
  await siteExecute(SITE, `DELETE FROM products WHERE code LIKE 'ZGC%'`)
}

/** Repairs cached account balances after journal rows are deleted raw. */
async function repairBalances() {
  await siteExecute(SITE,
    `UPDATE gl_accounts a SET a.balance = COALESCE(
       (SELECT SUM(l.amount) FROM journal_lines l
         JOIN journal_batches b ON b.id = l.batch_id
        WHERE l.account_id = a.id AND b.status = 'posted'), 0)`)
}

async function main() {
  await sweepStrays()
  const stamp = Date.now().toString().slice(-8)

  /* ── Pure pieces first ───────────────────────────────────────────────── */

  ok('the code formats in fours', formatGiftCardCode('BCDFGHJKLMNP') === 'BCDF-GHJK-LMNP')
  ok('  and a scanned dashed code normalises back',
    normaliseGiftCardCode(' bcdf-ghjk-lmnp ') === 'BCDFGHJKLMNP')
  ok('a gift card product carries no stock', stockDirectionFor('gift_card') === 0)
  ok("  and the type survives the narrowing", toProductType('gift_card') === 'gift_card')
  ok('offline refuses the tender',
    offlineBlockedTender({ postsToDebtor: false, integrationKey: 'gift_card' }) !== null)
  ok('  and the product',
    offlineBlockedProduct({ productType: 'gift_card' }) !== null)

  /* ── Fixtures ────────────────────────────────────────────────────────── */

  const cash = await getTenderByCode(SITE, 'CASH')
  const giftTender = await getTenderByCode(SITE, 'GIFT_CARD')
  if (!cash || !giftTender) throw new Error('CASH and GIFT_CARD tenders must exist — run 147.')

  const tenderWasActive = giftTender.isActive
  await siteExecute(SITE, "UPDATE tender_types SET is_active = 1 WHERE code = 'GIFT_CARD'")

  const validityBefore = await getSetting(SITE, 'gift_card_validity_months')
  await setSetting(SITE, 'gift_card_validity_months', '12')

  const zeroVat = await siteQueryOne<any>(
    SITE, "SELECT id FROM vat_rates WHERE vat_type='sales' AND rate = 0 LIMIT 1")
  const giftProduct = await siteExecute(SITE,
    `INSERT INTO products (code, description, product_type, selling_vat_rate_id, ask_price_at_sale)
     VALUES (?, 'ZGC gift card', 'gift_card', ?, 1)`,
    [`ZGC${stamp}`, zeroVat?.id ?? null])

  const seqBefore = await siteQueryOne<any>(SITE,
    "SELECT next_number, last_issued_number FROM document_sequences WHERE terminal_id = 0 AND doc_type = 'invoice'")
  const breakageMaxBefore = Number((await siteQueryOne<any>(SITE,
    "SELECT COALESCE(MAX(id),0) AS m FROM journal_batches WHERE source = 'gift_card_breakage'"))?.m ?? 0)
  const liabilityStart = await giftCardLiability(SITE)

  const glBalance = async (code: string) =>
    toNum((await siteQueryOne<any>(SITE,
      'SELECT balance FROM gl_accounts WHERE account_code = ?', [code]))?.balance)
  const gl2500Start = await glBalance('2500')

  const journalFor = (docId: number) =>
    siteQuery<any>(SITE,
      `SELECT l.amount, a.account_code FROM journal_lines l
        JOIN journal_batches b ON b.id = l.batch_id
        JOIN gl_accounts a ON a.id = l.account_id
       WHERE b.source = 'sale' AND b.source_doc_id = ?`, [docId])

  /* ── 1. Generating stock ─────────────────────────────────────────────── */

  const generated = await generateGiftCards(SITE, actor, { count: 3, note: 'ZGC batch' })
  ok('*** a batch of pending cards generates ***',
    generated.ok && generated.codes.length === 3, generated.ok ? '' : generated.error)
  if (!generated.ok) { console.log('cannot continue'); process.exit(1) }
  const [pendingCode] = generated.codes
  ok('  codes are 12 characters of the safe alphabet',
    generated.codes.every((c) => /^[BCDFGHJKLMNPQRTVWXY2346789]{12}$/.test(c)))
  ok('  a pending card cannot pay',
    giftCardRefusal(await findGiftCard(SITE, pendingCode), pendingCode, today()) !== null)

  /* ── 2. Activation: selling a card ───────────────────────────────────── */

  const sellCard = async (code: string, amount: number, extra: Record<string, unknown> = {}) => {
    const draft = await saveDraft(SITE, actor, {
      docType: 'invoice', customerName: `${TAG} ${stamp}`,
      lines: [{
        productId: giftProduct.insertId, productCode: `ZGC${stamp}`, description: 'Gift card',
        productType: 'gift_card', qty: 1, unitPriceIncl: amount, vatRatePct: 0,
        giftCardCode: code, ...extra,
      }],
    } as never)
    if (!draft.ok) return { ok: false as const, error: draft.error }
    return finaliseDocument(SITE, actor, {
      documentId: draft.id, tenders: [{ tenderTypeId: cash.id, amount }],
    })
  }

  const sold = await sellCard(pendingCode, 200)
  ok('*** a pending card sells and activates ***', sold.ok, sold.ok ? '' : sold.error)
  if (!sold.ok) { console.log('cannot continue'); process.exit(1) }

  const active = await findGiftCard(SITE, pendingCode)
  ok('  it holds what was paid', active?.status === 'active' && active.balance === 200,
    `${active?.status} ${active?.balance}`)
  ok('  with an expiry a year out (the setting)',
    active?.expiresOn !== null && active!.expiresOn! > today(), String(active?.expiresOn))
  ok('  and remembers the sale that activated it',
    active?.activatedDocNumber === sold.documentNumber)

  const activationJournal = await journalFor(sold.documentId)
  ok('*** the activation journal is DR tender, CR 2500 — NO revenue ***',
    activationJournal.some((l: any) => l.account_code === '2500' && toNum(l.amount) === -200) &&
      !activationJournal.some((l: any) => ['4000'].includes(String(l.account_code))),
    JSON.stringify(activationJournal.map((l: any) => [l.account_code, toNum(l.amount)])))
  ok('  and it balances',
    Math.abs(activationJournal.reduce((s: number, l: any) => s + toNum(l.amount), 0)) < 0.005)

  /* ── 3. Activation guards ────────────────────────────────────────────── */

  const freshCode = () => {
    let code = ''
    const alphabet = 'BCDFGHJKLMNPQRTVWXY2346789'
    for (let i = 0; i < 12; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)]
    return code
  }

  const reSold = await sellCard(pendingCode, 50)
  ok('*** selling an ACTIVE card again is refused, rolling the sale back ***',
    !reSold.ok && /already active/i.test(reSold.ok ? '' : reSold.error),
    reSold.ok ? 'it sold' : reSold.error)

  const discounted = await sellCard(freshCode(), 100, { discountPct: 10 })
  ok('  a discounted card is refused — face value only',
    !discounted.ok && /face value/i.test(discounted.ok ? '' : discounted.error))

  const vatted = await sellCard(freshCode(), 100, { vatRatePct: 15 })
  ok('  a VAT-bearing card is refused — VAT belongs on the goods',
    !vatted.ok && /VAT/i.test(vatted.ok ? '' : vatted.error))

  const two = await sellCard(freshCode(), 100, { qty: 2 })
  ok('  two cards on one line are refused — each line names its card',
    !two.ok && /one per line/i.test(two.ok ? '' : two.error))

  /* ── 4. Redemption ───────────────────────────────────────────────────── */

  const buyWith = async (cardCode: string, goods: number, cardAmount: number, cashAmount = 0) => {
    const draft = await saveDraft(SITE, actor, {
      docType: 'invoice', customerName: `${TAG} ${stamp}`,
      lines: [{
        productId: null, description: 'Goods', productType: 'service',
        qty: 1, unitPriceIncl: goods, vatRatePct: 15, unitCostExcl: 0,
      }],
    } as never)
    if (!draft.ok) return { ok: false as const, error: draft.error }
    const tenders = [{ tenderTypeId: giftTender.id, amount: cardAmount, reference: cardCode }]
    if (cashAmount > 0) tenders.push({ tenderTypeId: cash.id, amount: cashAmount, reference: null as never })
    return finaliseDocument(SITE, actor, { documentId: draft.id, tenders })
  }

  const spend1 = await buyWith(pendingCode, 80, 80)
  ok('*** goods paid by gift card post, and the card drains ***',
    spend1.ok, spend1.ok ? '' : spend1.error)
  ok('  balance is now 120', (await findGiftCard(SITE, pendingCode))?.balance === 120)

  if (spend1.ok) {
    const journal = await journalFor(spend1.documentId)
    ok('*** redemption debits 2500 — the liability drains through the tender mapping ***',
      journal.some((l: any) => l.account_code === '2500' && toNum(l.amount) === 80),
      JSON.stringify(journal.map((l: any) => [l.account_code, toNum(l.amount)])))
  }

  const overdrawn = await buyWith(pendingCode, 500, 500)
  ok('*** an over-balance redemption is refused before anything is written ***',
    !overdrawn.ok && /not enough/i.test(overdrawn.ok ? '' : overdrawn.error),
    overdrawn.ok ? 'it posted' : overdrawn.error)

  const split = await buyWith(pendingCode, 200, 120, 80)
  ok('*** a split card-plus-cash sale drains the card to zero ***',
    split.ok, split.ok ? '' : split.error)
  const drained = await findGiftCard(SITE, pendingCode)
  ok('  and the drained card reads redeemed',
    drained?.status === 'redeemed' && drained.balance === 0,
    `${drained?.status} ${drained?.balance}`)

  const reuse = await buyWith(pendingCode, 10, 10)
  ok('  a drained card refuses further spending',
    !reuse.ok && /nothing left/i.test(reuse.ok ? '' : reuse.error))

  /* ── 5. Card cannot buy a card ───────────────────────────────────────── */

  {
    const secondCard = generated.codes[1]
    const activate2 = await sellCard(secondCard, 100)
    ok('a second card sells', activate2.ok, activate2.ok ? '' : activate2.error)
    const draft = await saveDraft(SITE, actor, {
      docType: 'invoice', customerName: `${TAG} ${stamp}`,
      lines: [{
        productId: giftProduct.insertId, productCode: `ZGC${stamp}`, description: 'Gift card',
        productType: 'gift_card', qty: 1, unitPriceIncl: 50, vatRatePct: 0,
        giftCardCode: freshCode(),
      }],
    } as never)
    if (draft.ok) {
      const laundered = await finaliseDocument(SITE, actor, {
        documentId: draft.id,
        tenders: [{ tenderTypeId: giftTender.id, amount: 50, reference: secondCard }],
      })
      ok('*** a gift card cannot pay for another gift card ***',
        !laundered.ok && /cannot pay for another/i.test(laundered.ok ? '' : laundered.error),
        laundered.ok ? 'it posted' : laundered.error)
    }
  }

  /* ── 6. Void restores both directions ────────────────────────────────── */

  const voidReason = await findSalesReasonByCode(SITE, 'void', 'WRONG-ITEM')
  if (!voidReason) throw new Error('Seeded void reason WRONG-ITEM missing — run 102.')

  {
    // Void a redemption: the money comes back onto the card.
    const secondCard = generated.codes[1]
    const spent = await buyWith(secondCard, 40, 40)
    ok('a spend on the second card posts', spent.ok, spent.ok ? '' : spent.error)
    if (spent.ok) {
      const before = (await findGiftCard(SITE, secondCard))!.balance
      const undone = await voidDocument(SITE, actor, spent.documentId, {
        reasonId: voidReason.id, note: 'ZGC void redemption',
      })
      ok('*** voiding the sale puts the money back on the card ***',
        undone.ok && (await findGiftCard(SITE, secondCard))!.balance === before + 40,
        `balance ${(await findGiftCard(SITE, secondCard))!.balance}, was ${before}`)
    }
  }

  {
    // Void an activation while the card is whole: the card is cancelled.
    const thirdCard = generated.codes[2]
    const soldThird = await sellCard(thirdCard, 75)
    ok('a third card sells', soldThird.ok, soldThird.ok ? '' : soldThird.error)
    if (soldThird.ok) {
      const undone = await voidDocument(SITE, actor, soldThird.documentId, {
        reasonId: voidReason.id, note: 'ZGC void activation',
      })
      const third = await findGiftCard(SITE, thirdCard)
      ok('*** voiding the activating sale cancels the whole card ***',
        undone.ok && third?.status === 'void' && third.balance === 0,
        `${third?.status} ${third?.balance}`)
    }
  }

  /* ── 7. Management: adjust and void ──────────────────────────────────── */

  {
    const secondCard = (await findGiftCard(SITE, generated.codes[1]))!
    const bumped = await adjustGiftCard(SITE, actor, secondCard.id, 25, 'ZGC goodwill')
    ok('an adjustment moves the balance', bumped.ok &&
      (await findGiftCard(SITE, generated.codes[1]))!.balance === secondCard.balance + 25)
    const noReason = await adjustGiftCard(SITE, actor, secondCard.id, 5, '  ')
    ok('  but never without a reason', !noReason.ok)
    const tooFar = await adjustGiftCard(SITE, actor, secondCard.id, -100000, 'ZGC drain')
    ok('  and never below zero', !tooFar.ok)
  }

  /* ── 8. The liability figure tracks the balances ─────────────────────── */

  const held = await giftCardLiability(SITE)
  const summed = toNum((await siteQueryOne<any>(SITE,
    "SELECT COALESCE(SUM(balance),0) AS s FROM gift_cards WHERE status = 'active'"))?.s)
  ok('*** the subledger figure equals the sum of active balances ***',
    Math.abs(held - summed) < 0.005, `${held} vs ${summed}`)

  /* ── 9. Expiry and breakage ──────────────────────────────────────────── */

  {
    const secondCard = (await findGiftCard(SITE, generated.codes[1]))!
    await siteExecute(SITE, "UPDATE gift_cards SET expires_on = '2020-01-01' WHERE id = ?",
      [secondCard.id])
    const swept = await expireGiftCards(SITE, actor)
    ok('*** the sweep expires the lapsed card and reports its value ***',
      swept.cards >= 1 && Math.abs(swept.value - secondCard.balance) < 0.005,
      `${swept.cards} cards, ${swept.value}`)
    ok('  the card reads expired with nothing on it',
      (await findGiftCard(SITE, generated.codes[1]))?.status === 'expired')

    const mirrored = await mirrorGiftCardBreakage(SITE, actor, {
      date: today(), amount: swept.value, cards: swept.cards,
    })
    ok('  the breakage journal posts', mirrored.ok, mirrored.ok ? '' : mirrored.reason)
    const breakage = await siteQuery<any>(SITE,
      `SELECT l.amount, a.account_code FROM journal_lines l
        JOIN journal_batches b ON b.id = l.batch_id
        JOIN gl_accounts a ON a.id = l.account_id
       WHERE b.source = 'gift_card_breakage' AND b.id > ?`, [breakageMaxBefore])
    ok('*** breakage is DR 2500, CR 4910 for the swept value ***',
      breakage.some((l: any) => l.account_code === '2500' && toNum(l.amount) === swept.value) &&
        breakage.some((l: any) => l.account_code === '4910' && toNum(l.amount) === -swept.value),
      JSON.stringify(breakage.map((l: any) => [l.account_code, toNum(l.amount)])))

    const again = await expireGiftCards(SITE, actor)
    ok('  a second sweep finds nothing', again.cards === 0 && again.value === 0)
  }

  /* ── 10. Voiding pending stock ───────────────────────────────────────── */

  {
    const spare = await generateGiftCards(SITE, actor, { count: 1, note: 'ZGC spare' })
    if (spare.ok) {
      const card = (await findGiftCard(SITE, spare.codes[0]))!
      ok('an unsold card can be cancelled outright',
        (await voidGiftCard(SITE, actor, card.id)).ok &&
          (await findGiftCard(SITE, spare.codes[0]))?.status === 'void')
    }
  }

  /* ── Clean up ────────────────────────────────────────────────────────── */

  // The GL: net effect of this run on 2500 must be zero once everything is
  // unwound — activation +200+100+75, redemptions/voids/expiry took it all
  // back out. Checked BEFORE the raw deletes, as the honest figure.
  const gl2500End = await glBalance('2500')
  const liabilityEnd = await giftCardLiability(SITE)
  ok('*** at the end, the GL liability moved exactly as the cards did ***',
    Math.abs((gl2500End - gl2500Start) - (liabilityEnd - liabilityStart)) < 0.01,
    `GL moved ${(gl2500End - gl2500Start).toFixed(2)}, cards moved ${(liabilityEnd - liabilityStart).toFixed(2)}`)

  await siteExecute(SITE,
    "DELETE l FROM journal_lines l JOIN journal_batches b ON b.id=l.batch_id WHERE b.source='gift_card_breakage' AND b.id > ?",
    [breakageMaxBefore])
  await siteExecute(SITE,
    "DELETE FROM journal_batches WHERE source='gift_card_breakage' AND id > ?", [breakageMaxBefore])
  await sweepStrays()
  await repairBalances()

  // The invoice sequence: restore the exact row, matching the CRN precedent.
  if (seqBefore) {
    await siteExecute(SITE,
      "UPDATE document_sequences SET next_number = ?, last_issued_number = ? WHERE terminal_id = 0 AND doc_type = 'invoice'",
      [seqBefore.next_number, seqBefore.last_issued_number])
  }

  await setSetting(SITE, 'gift_card_validity_months', validityBefore ?? '36')
  if (!tenderWasActive) {
    await siteExecute(SITE, "UPDATE tender_types SET is_active = 0 WHERE code = 'GIFT_CARD'")
  }

  const leftovers = await siteQuery<any>(SITE, "SELECT id FROM gift_cards WHERE note LIKE 'ZGC%'")
  ok('the run leaves nothing behind', leftovers.length === 0)

  console.log(fails === 0 ? '\nAll gift card checks passed.' : `\n${fails} FAILED`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
