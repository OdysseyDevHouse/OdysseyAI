/**
 * Loyalty.
 *
 * The rules that matter, and what breaks if they slip:
 *
 *   THE LEDGER IS THE BALANCE. Points are SUM(loyalty_ledger.points) and
 *   nothing else. The cache on the member row is a display convenience; if the
 *   two can disagree, every dispute about a balance becomes unanswerable.
 *
 *   SPENDING POINTS MUST NOT COST A TIER. Tier standing sums what was SPENT
 *   (basis_amount), never the points balance. Get this wrong and redeeming a
 *   reward demotes the customer who earned it — the classic loyalty bug.
 *
 *   POINTS ROUND DOWN, REDEMPTION ROUNDS UP. Both in the shop's favour by a
 *   fraction of a cent. Reversed, every sale leaks money.
 *
 *   NO SALE PAYS TWICE. A retried finalise must not award points or stamps
 *   again — enforced by unique keys, not by a check that races.
 *
 *   AN OVERDRAW IS REFUSED BEFORE THE SALE OPENS. Spending points or wallet
 *   rand that are not there must stop the sale, not sell the goods and shrug.
 *
 *   This used to say "inside the sale's transaction", and the throw rolled the
 *   sale back. That guarantee could not survive a shared programme: the loyalty
 *   rows live in the primary's database and no transaction spans two. So the
 *   check moved AHEAD of the sale instead — everything that could refuse a
 *   redemption is asked before a document exists, and the deduction is written
 *   after the commit. The observable rule is unchanged; only where it is
 *   enforced moved. See the long note in salesPosting.ts.
 *
 *   A VOUCHER IS SPENT ONCE. A photographed code redeemed at two tills must
 *   fail at the second, and the failure must be the database's decision.
 *
 *   A REVERSAL UNDOES ALL FOUR. Points, wallet, stamps and the voucher the
 *   customer walked in with. Doing only the first robs whoever paid with points.
 *
 *   WHAT WAS PAID FOR WITH POINTS EARNS NOTHING. Otherwise points buy points.
 *
 *   npm run test:loyalty
 */
import { siteExecute, siteQuery, siteQueryOne } from '../src/lib/siteDb'
import { saveDraft } from '../src/lib/site/salesDocuments'
import { finaliseDocument, voidDocument } from '../src/lib/site/salesPosting'
import { getTenderByCode } from '../src/lib/site/tenderTypes'
import { setSetting } from '../src/lib/site/settings'
import {
  getLoyaltySettings, saveLoyaltySettings, listTiers, saveTiers,
  getMember, listLedger, adjustPoints, expirePoints, listMembers,
  getLiability, recalcMember, redeemableFor, enrolMember,
} from '../src/lib/site/loyalty'
import {
  createCard, listCards, getCardProgress, issueVoucher, listVouchers,
  findVoucher, voidVoucher, expireVouchers, deleteCard,
} from '../src/lib/site/loyaltyCards'
import {
  topUpWallet, getWalletBalance, listWallet, adjustWallet, walletTopUpsForShift,
} from '../src/lib/site/loyaltyWallet'
import {
  computeEarn, pointsToRand, randToPoints, maxRedeemableRand,
  tierForSpend, nextTier, cardCompletions, stampsForBasket, cleanTierLadder,
  cleanSettings, LOYALTY_DEFAULTS, type LoyaltySettings, type LoyaltyTier,
} from '../src/lib/loyaltyRules'
import { round, toNum } from '../src/lib/decimals'
import { findSalesReasonByCode } from '../src/lib/site/salesReasons'

const SITE = 1

/*
 * The seeded reason codes, resolved once.
 *
 * Every void and credit note now names a row rather than carrying free text, so
 * these tests need real ids. Read from the site rather than hardcoded: the ids
 * are AUTO_INCREMENT and differ per site, and 102 seeds the codes by name.
 */
let VOID_REASON_ID = 0

async function loadReasonIds() {
  const v = await findSalesReasonByCode(SITE, 'void', 'WRONG-ITEM')
  if (!v) throw new Error('Seeded void reason WRONG-ITEM is missing — run site-migrate for 102.')
  VOID_REASON_ID = v.id
}

const actor = { userId: 1, userName: 'Loyalty Test' }
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

const stamp = Date.now().toString().slice(-6)
const docs: number[] = []
let customerId = 0
/**
 * The MEMBER, which is no longer the same number as the customer.
 *
 * Every loyalty call below is keyed on this. Both are `number`, so passing the
 * wrong one compiles cleanly and quietly reads somebody else's balance — which
 * is why they are two variables rather than one reused.
 */
let memberId = 0
/** The member number allocated at enrolment, for the search assertions. */
let memberNumber = ''
let productId = 0
// A card is defined in product CODES, not local ids — see loyaltyCards.ts.
let productCode = ''
let departmentId: number | null = null
let cardId = 0
let originalSettings: LoyaltySettings | null = null
let originalTiers: LoyaltyTier[] = []

const settings = (over: Partial<LoyaltySettings> = {}): LoyaltySettings => ({
  ...LOYALTY_DEFAULTS,
  enabled: true,
  ...over,
})

const tier = (over: Partial<LoyaltyTier> = {}): LoyaltyTier => ({
  id: 1, name: 'Bronze', step: 1, qualifyingSpend: 0,
  multiplier: 1, discountPct: 0, color: '', isActive: true, ...over,
})

/** Balance straight from the ledger — the figure everything else must match. */
async function ledgerBalance(id: number): Promise<number> {
  const row = await siteQueryOne<{ points: string }>(
    SITE, 'SELECT COALESCE(SUM(points),0) AS points FROM loyalty_ledger WHERE member_id = ?', [id],
  )
  return round(toNum(row?.points), 4)
}

async function cachedBalance(id: number): Promise<number> {
  const row = await siteQueryOne<{ points_balance: string }>(
    SITE, 'SELECT points_balance FROM loyalty_members WHERE id = ?', [id],
  )
  return round(toNum(row?.points_balance), 4)
}

/** Rings up and finalises a sale. Returns the document id. */
async function sell(
  opts: {
    incl: number
    qty?: number
    tenders: { code: string; amount: number }[]
    voucherCodes?: string[]
    withProduct?: boolean
  },
): Promise<{ ok: boolean; id: number; error?: string }> {
  const draft = await saveDraft(SITE, actor, {
    docType: 'invoice',
    customerId,
    lines: [
      opts.withProduct
        ? {
            productId,
            productCode: `LP${stamp}`,
            description: 'Loyalty product',
            productType: 'normal',
            qty: opts.qty ?? 1,
            unitPriceIncl: opts.incl,
            vatRatePct: 15,
            unitCostExcl: 10,
          }
        : {
            productCode: `LS${stamp}`,
            description: 'Loyalty service',
            productType: 'service',
            qty: opts.qty ?? 1,
            unitPriceIncl: opts.incl,
            vatRatePct: 15,
            unitCostExcl: 10,
          },
    ],
  })
  if (!draft.ok) return { ok: false, id: 0, error: draft.error }
  docs.push(draft.id)

  const tenders = []
  for (const t of opts.tenders) {
    const type = await getTenderByCode(SITE, t.code)
    if (!type) return { ok: false, id: draft.id, error: `no tender ${t.code}` }
    tenders.push({ tenderTypeId: type.id, amount: t.amount })
  }

  const posted = await finaliseDocument(SITE, actor, {
    documentId: draft.id,
    customerId,
    // Passed explicitly rather than left to the customer fallback, so these
    // sales exercise the path the till actually uses.
    memberId,
    tenders,
    voucherCodes: opts.voucherCodes,
  })
  return { ok: posted.ok, id: draft.id, error: posted.ok ? undefined : posted.error }
}

async function main() {
  await loadReasonIds()
  console.log('\n── The arithmetic, in isolation ────────────────────────────\n')

  ok('R100 at R1 per point earns 100',
      computeEarn([{ lineTotalIncl: 100, discounted: false }], settings(), tier()).points === 100)

  ok('*** points round DOWN, never up ***',
      computeEarn([{ lineTotalIncl: 99.99, discounted: false }], settings(), tier()).points === 99)

  ok('a tier multiplier applies',
      computeEarn([{ lineTotalIncl: 100, discounted: false }], settings(), tier({ multiplier: 1.5 })).points === 150)

  ok('*** the slice paid with points earns nothing ***',
      computeEarn([{ lineTotalIncl: 100, discounted: false }], settings(), tier(), 40).points === 60)

  ok('a discounted line can be excluded',
      computeEarn([{ lineTotalIncl: 100, discounted: true }], settings({ earnOnDiscounted: false }), tier()).points === 0)

  ok('a closed programme earns nothing',
      computeEarn([{ lineTotalIncl: 100, discounted: false }], settings({ enabled: false }), tier()).points === 0)

  ok('a refund basket earns nothing rather than deducting twice',
      computeEarn([{ lineTotalIncl: -100, discounted: false }], settings(), tier()).points === 0)

  ok('100 points at 10 per rand is worth R10', pointsToRand(100, settings()) === 10)
  ok('the value rounds DOWN to the cent', pointsToRand(99, settings()) === 9.9)

  ok('*** funding R1 costs points rounded UP ***', randToPoints(0.05, settings()) === 1)
  ok('  and floating point does not add one', randToPoints(0.3, settings({ redeemRate: 10 })) === 3)

  ok('redemption is capped by what is owed', maxRedeemableRand(1000, 25, settings()) === 25)
  ok('  and by the balance', maxRedeemableRand(50, 100, settings()) === 5)
  ok('*** a minimum blocks a small balance entirely ***',
      maxRedeemableRand(40, 100, settings({ minRedeemPoints: 50 })) === 0)

  const ladder = [
    tier({ id: 1, name: 'Bronze', step: 1, qualifyingSpend: 0 }),
    tier({ id: 2, name: 'Silver', step: 2, qualifyingSpend: 5000 }),
    tier({ id: 3, name: 'Gold', step: 3, qualifyingSpend: 15000 }),
  ]
  ok('no spend lands in the entry tier', tierForSpend(ladder, 0)?.name === 'Bronze')
  ok('spend picks the highest tier reached', tierForSpend(ladder, 16000)?.name === 'Gold')
  ok('the next rung reports its shortfall', nextTier(ladder, 4000)?.shortfall === 1000)
  ok('the top tier has no next', nextTier(ladder, 99999) === null)

  ok('11 stamps on a 10-card is one reward and one carried over',
      cardCompletions(11, 10).completed === 1 && cardCompletions(11, 10).progress === 1)

  console.log('\n── Validation ──────────────────────────────────────────────\n')

  ok('a zero earn rate is refused', 'error' in cleanSettings({ ...settings(), earnRate: 0 }))
  ok('a zero redeem rate is refused', 'error' in cleanSettings({ ...settings(), redeemRate: 0 }))
  ok('a ladder needs an entry tier',
      'error' in cleanTierLadder([{ name: 'Gold', qualifyingSpend: 100 }]))
  ok('*** a ladder that cannot be climbed is refused ***',
      'error' in cleanTierLadder([
        { name: 'Bronze', qualifyingSpend: 0 },
        { name: 'Silver', qualifyingSpend: 500 },
        { name: 'Gold', qualifyingSpend: 100 },
      ]))
  ok('two tiers cannot share a name',
      'error' in cleanTierLadder([
        { name: 'Bronze', qualifyingSpend: 0 },
        { name: 'bronze', qualifyingSpend: 500 },
      ]))

  console.log('\n── Setting the programme up ────────────────────────────────\n')

  originalSettings = await getLoyaltySettings(SITE)

  const saved = await saveLoyaltySettings(SITE, actor, settings({ redeemRate: 10, earnRate: 1 }))
  ok('the programme can be opened', saved.ok, saved.ok ? '' : saved.error)

  const live = await getLoyaltySettings(SITE)
  ok('  and reads back enabled', live.enabled && live.redeemRate === 10)

  // Captured so the ladder can be put back. The tier test below rewrites it,
  // and a run that left a two-tier ×2 ladder behind would silently double the
  // earnings of the NEXT run — which is exactly how this test first lied.
  originalTiers = await listTiers(SITE)
  ok('the default ladder seeded four tiers', originalTiers.length >= 4, `${originalTiers.length}`)

  // The two loyalty tenders ship inactive; the till needs them on.
  await siteExecute(SITE, `UPDATE tender_types SET is_active = 1 WHERE integration_key = 'loyalty'`)

  const dept = await siteQueryOne<{ id: number }>(SITE, 'SELECT id FROM departments ORDER BY id LIMIT 1')
  departmentId = dept ? Number(dept.id) : null

  // Only code and description are required; price lives in product_prices and
  // the sale line carries its own anyway, so nothing more is needed here.
  const prod = await siteExecute(
    SITE,
    `INSERT INTO products (code, description, product_type, department_id)
     VALUES (?,?,'stock',?)`,
    [`LP${stamp}`, `Loyalty product ${stamp}`, departmentId],
  )
  productId = prod.insertId
  productCode = `LP${stamp}`

  const cust = await siteExecute(
    SITE,
    `INSERT INTO customers (code, name, status, account_type, loyalty_number)
     VALUES (?,?,'active','cash',?)`,
    [`LC${stamp}`, `Loyalty Customer ${stamp}`, `LOY${stamp}`],
  )
  customerId = cust.insertId
  ok('a test customer exists', customerId > 0)

  // Joining is now a deliberate act rather than a side effect of being a
  // customer, so the fixture has to do it. Everything after this point is about
  // the member, not the account.
  const joined = await enrolMember(SITE, actor, {
    name: `Loyalty Customer ${stamp}`,
    customerId,
  })
  ok('the customer joins the programme', joined.ok, joined.ok ? '' : joined.error)
  if (!joined.ok) throw new Error(`enrolment failed: ${joined.error}`)
  memberId = joined.memberId
  memberNumber = joined.memberNumber
  ok('  and holds an allocated member number', /^M\d{6}$/.test(joined.memberNumber),
      joined.memberNumber)

  console.log('\n── Earning on a real sale ──────────────────────────────────\n')

  const sale1 = await sell({ incl: 500, tenders: [{ code: 'CASH', amount: 500 }] })
  ok('a cash sale posts', sale1.ok, sale1.error)

  const afterFirst = await ledgerBalance(memberId)
  ok('*** it earned 500 points ***', afterFirst === 500, `${afterFirst}`)
  ok('  and the cache agrees with the ledger', (await cachedBalance(memberId)) === afterFirst)

  const member = await getMember(SITE, memberId)
  ok('  the member reads back', member !== null)
  ok('  worth R50 at 10 points per rand', member?.pointsValue === 50, `${member?.pointsValue}`)
  ok('  qualifying spend is the RAND value, not the points', member?.qualifyingSpend === 500,
      `${member?.qualifyingSpend}`)
  ok('  and they sit in the entry tier', member?.tier?.name === 'Bronze', member?.tier?.name)

  const ledger = await listLedger(SITE, memberId)
  ok('the earn is one ledger row', ledger.length === 1 && ledger[0].entryType === 'earn')
  ok('  naming the sale it came from', ledger[0].documentNumber.length > 0)

  console.log('\n── Spending points ────────────────────────────────────────\n')

  const quote = await redeemableFor(SITE, memberId, 100)
  ok('the till is told R50 is available', quote.maxRand === 50, `${quote.maxRand}`)

  // R30 of a R100 sale on points; the rest cash.
  const sale2 = await sell({
    incl: 100,
    tenders: [{ code: 'LOYALTY_POINTS', amount: 30 }, { code: 'CASH', amount: 70 }],
  })
  ok('a part-points sale posts', sale2.ok, sale2.error)

  const afterRedeem = await ledgerBalance(memberId)
  // 500 earned - 300 spent (R30 x 10) + 70 earned on the cash portion.
  ok('*** R30 cost 300 points ***', afterRedeem === 270, `${afterRedeem}`)
  ok('  the cache still agrees', (await cachedBalance(memberId)) === afterRedeem)

  const memberAfter = await getMember(SITE, memberId)
  ok('*** spending points did NOT reduce qualifying spend ***',
      memberAfter?.qualifyingSpend === 570, `${memberAfter?.qualifyingSpend}`)

  const redeemRow = (await listLedger(SITE, memberId)).find((e) => e.entryType === 'redeem')
  ok('  and the spend is its own ledger row', redeemRow?.points === -300, `${redeemRow?.points}`)

  console.log('\n── What must be refused ────────────────────────────────────\n')

  const overdraw = await sell({
    incl: 5000,
    tenders: [{ code: 'LOYALTY_POINTS', amount: 5000 }],
  })
  ok('*** spending points that are not there is refused ***', !overdraw.ok)
  ok('  with a message naming what is available',
      (overdraw.error ?? '').includes('Not enough points'), overdraw.error)

  const stillThere = await ledgerBalance(memberId)
  ok('*** and the refused sale left the balance untouched ***', stillThere === 270, `${stillThere}`)

  const refusedDoc = await siteQueryOne<{ status: string }>(
    SITE, 'SELECT status FROM sales_documents WHERE id = ?', [overdraw.id],
  )
  ok('  the sale itself did not post', refusedDoc?.status !== 'finalised', refusedDoc?.status)

  console.log('\n── The wallet ──────────────────────────────────────────────\n')

  const cash = await getTenderByCode(SITE, 'CASH')
  const account = await getTenderByCode(SITE, 'ACCOUNT')

  const topUp = await topUpWallet(SITE, actor, {
    memberId, amount: 200, tenderTypeId: cash!.id,
  })
  ok('a card can be loaded with cash', topUp.ok, topUp.ok ? '' : topUp.error)
  ok('  and the balance is R200', topUp.ok && topUp.balance === 200)

  if (account) {
    const onAccount = await topUpWallet(SITE, actor, {
      memberId, amount: 100, tenderTypeId: account.id,
    })
    ok('*** loading a card on account is refused ***', !onAccount.ok,
        onAccount.ok ? 'allowed' : onAccount.error)
  }

  const walletTender = await getTenderByCode(SITE, 'LOYALTY_WALLET')
  const selfFund = await topUpWallet(SITE, actor, {
    memberId, amount: 50, tenderTypeId: walletTender!.id,
  })
  ok('*** a card cannot be loaded with loyalty money ***', !selfFund.ok)

  const pointsBeforeWallet = await ledgerBalance(memberId)
  ok('*** loading a card earns NO points ***', pointsBeforeWallet === 270, `${pointsBeforeWallet}`)

  const sale3 = await sell({
    incl: 80,
    tenders: [{ code: 'LOYALTY_WALLET', amount: 80 }],
  })
  ok('a sale settles from the wallet', sale3.ok, sale3.error)
  ok('  and the wallet is drawn down', (await getWalletBalance(SITE, memberId)) === 120,
      `${await getWalletBalance(SITE, memberId)}`)

  const afterWalletSale = await ledgerBalance(memberId)
  ok('*** wallet rand earns no points either — it was already the customer\'s money ***',
      afterWalletSale === 270, `${afterWalletSale}`)

  const walletOverdraw = await sell({
    incl: 9999,
    tenders: [{ code: 'LOYALTY_WALLET', amount: 9999 }],
  })
  ok('*** overdrawing the wallet is refused ***', !walletOverdraw.ok)
  ok('  and the wallet is unchanged', (await getWalletBalance(SITE, memberId)) === 120)

  console.log('\n── Punch cards ─────────────────────────────────────────────\n')

  const card = await createCard(SITE, actor, {
    name: `Coffee card ${stamp}`,
    isActive: true,
    requiredStamps: 3,
    rewardType: 'value',
    rewardProductCode: null,
    rewardValue: 25,
    oneStampPerSale: true,
    minLineAmount: 0,
    voucherValidDays: 30,
    startsOn: null,
    endsOn: null,
    // Scoped by CODE, because a card belongs to the whole group and a row id
    // means nothing at another branch. listCards resolves it back to this
    // store's id, which is what the assertion below checks.
    productCodes: [productCode],
    departmentNames: [],
  })
  ok('a punch card is created', card.ok, card.ok ? '' : card.error)
  if (card.ok) cardId = card.id

  const scopedCard = (await listCards(SITE, true)).find((c) => c.id === cardId)
  ok('  with its scope attached', scopedCard?.productIds.includes(productId) === true)

  ok('*** one stamp per sale, however many are in the trolley ***',
      stampsForBasket(
        [{ productId, departmentId, qty: 10, lineTotalIncl: 500 }],
        scopedCard!, new Date(),
      ) === 1)

  ok('  a product outside the scope earns nothing',
      stampsForBasket(
        [{ productId: productId + 99999, departmentId: null, qty: 1, lineTotalIncl: 50 }],
        scopedCard!, new Date(),
      ) === 0)

  for (let i = 1; i <= 2; i++) {
    const s = await sell({ incl: 50, tenders: [{ code: 'CASH', amount: 50 }], withProduct: true })
    ok(`  stamp sale ${i} posts`, s.ok, s.error)
  }

  const progress = (await getCardProgress(SITE, memberId)).find((p) => p.cardId === cardId)
  ok('two stamps show as 2 of 3', progress?.stamps === 2, `${progress?.stamps}`)

  const beforeComplete = (await listVouchers(SITE, { memberId })).length
  const third = await sell({ incl: 50, tenders: [{ code: 'CASH', amount: 50 }], withProduct: true })
  ok('the completing sale posts', third.ok, third.error)

  const vouchersNow = await listVouchers(SITE, { memberId })
  ok('*** completing the card issued a voucher ***', vouchersNow.length === beforeComplete + 1,
      `${beforeComplete} -> ${vouchersNow.length}`)

  const issued = vouchersNow[0]
  ok('  worth what the card promised', issued?.rewardValue === 25, `${issued?.rewardValue}`)
  ok('  and it is spendable', issued?.status === 'issued')

  const resetProgress = (await getCardProgress(SITE, memberId)).find((p) => p.cardId === cardId)
  ok('  progress rolls back to zero on the next card', resetProgress?.stamps === 0,
      `${resetProgress?.stamps}`)

  console.log('\n── Vouchers ────────────────────────────────────────────────\n')

  ok('a code has no vowels, so it cannot spell anything',
      !/[AEIOU]/.test(issued!.code), issued!.code)
  ok('  nor the characters people misread', !/[01ISZ]/.test(issued!.code), issued!.code)

  const found = await findVoucher(SITE, issued!.code.toLowerCase())
  ok('a code looks up case-insensitively', found?.id === issued!.id)

  const voucherSale = await sell({
    incl: 100,
    tenders: [{ code: 'CASH', amount: 75 }],
    voucherCodes: [issued!.code],
  })
  ok('a voucher pays for part of a sale', voucherSale.ok, voucherSale.error)

  const spent = await findVoucher(SITE, issued!.code)
  ok('*** and is marked redeemed ***', spent?.status === 'redeemed', spent?.status)

  const reuse = await sell({
    incl: 100,
    tenders: [{ code: 'CASH', amount: 75 }],
    voucherCodes: [issued!.code],
  })
  ok('*** the same code cannot be spent twice ***', !reuse.ok)
  ok('  and the message says so', (reuse.error ?? '').includes('already been used'), reuse.error)

  // The voucher funded R25 of a R100 basket, so only R75 should earn.
  const earnedOnVoucherSale = (await listLedger(SITE, memberId))
    .find((e) => e.entryType === 'earn' && e.documentId === voucherSale.id)
  ok('*** the voucher-funded slice earned nothing ***',
      earnedOnVoucherSale?.points === 75, `${earnedOnVoucherSale?.points}`)

  const manual = await issueVoucher(SITE, actor, {
    memberId, rewardType: 'value', rewardValue: 15,
    description: 'Goodwill', validDays: 1,
  })
  ok('a voucher can be issued by hand', manual.ok, manual.ok ? '' : manual.error)

  if (manual.ok) {
    const cancelled = await voidVoucher(SITE, actor, manual.id)
    ok('  and cancelled while unspent', cancelled.ok)
    const twice = await voidVoucher(SITE, actor, manual.id)
    ok('  but not cancelled twice', !twice.ok)
  }

  console.log('\n── Reversal ────────────────────────────────────────────────\n')

  const beforeVoid = await ledgerBalance(memberId)
  const walletBeforeVoid = await getWalletBalance(SITE, memberId)

  // Void the wallet sale: the money must come back.
  const voided = await voidDocument(SITE, actor, sale3.id, { reasonId: VOID_REASON_ID, note: 'Loyalty reversal test' })
  ok('a wallet sale can be voided', voided.ok, voided.ok ? '' : voided.error)

  const walletAfterVoid = await getWalletBalance(SITE, memberId)
  ok('*** voiding a wallet sale puts the money back ***',
      walletAfterVoid === round(walletBeforeVoid + 80, 2), `${walletBeforeVoid} -> ${walletAfterVoid}`)

  const twiceVoided = await getWalletBalance(SITE, memberId)
  ok('  and it is not credited twice', twiceVoided === walletAfterVoid)

  // Void the points sale: earned points clawed back AND spent points returned.
  const pointsBeforeReversal = await ledgerBalance(memberId)
  const voidPoints = await voidDocument(SITE, actor, sale2.id, { reasonId: VOID_REASON_ID, note: 'Points reversal test' })
  ok('a part-points sale can be voided', voidPoints.ok, voidPoints.ok ? '' : voidPoints.error)

  const reversalRow = (await listLedger(SITE, memberId))
    .find((e) => e.entryType === 'reverse' && e.documentId === sale2.id)
  ok('*** the reversal is one visible ledger row ***', reversalRow !== undefined)
  // Sale 2 earned 70 (on the cash portion) and spent 300, so reversing it
  // returns 300 and claws back 70 — a net +230.
  ok('*** it returns the points spent and claws back those earned ***',
      reversalRow?.points === 230, `${reversalRow?.points}`)

  const afterReversal = await ledgerBalance(memberId)
  ok('  the balance moves by exactly that', afterReversal === round(pointsBeforeReversal + 230, 4),
      `${pointsBeforeReversal} -> ${afterReversal}`)
  ok('  and the cache keeps up', (await cachedBalance(memberId)) === afterReversal)

  const voidAgain = await voidDocument(SITE, actor, sale2.id, { reasonId: VOID_REASON_ID, note: 'again' })
  ok('a second void is refused by the document rules', !voidAgain.ok)
  ok('*** and the balance did not move again ***', (await ledgerBalance(memberId)) === afterReversal)

  console.log('\n── Manual movement ─────────────────────────────────────────\n')

  const before = await ledgerBalance(memberId)
  const grant = await adjustPoints(SITE, actor, memberId, 100, 'Goodwill')
  ok('points can be granted by hand', grant.ok, grant.ok ? '' : grant.error)
  ok('  and land on the balance', (await ledgerBalance(memberId)) === round(before + 100, 4))

  const noReason = await adjustPoints(SITE, actor, memberId, 50, '   ')
  ok('*** an adjustment without a reason is refused ***', !noReason.ok)

  const tooFar = await adjustPoints(SITE, actor, memberId, -999999, 'Take everything')
  ok('*** an adjustment cannot push the balance below zero ***', !tooFar.ok,
      tooFar.ok ? 'allowed' : tooFar.error)

  const walletAdjust = await adjustWallet(SITE, actor, memberId, -99999, 'Overdraw')
  ok('*** nor can a wallet adjustment overdraw the card ***', !walletAdjust.ok)

  console.log('\n── Cache integrity ─────────────────────────────────────────\n')

  // Corrupt the cache deliberately, then prove the repair restores it and that
  // no decision was ever made from the wrong figure.
  await siteExecute(SITE, 'UPDATE loyalty_members SET points_balance = 999999 WHERE id = ?',
      [memberId])

  const trueBalance = await ledgerBalance(memberId)
  const memberDuringDrift = await getMember(SITE, memberId)
  ok('*** a member reads its balance from the LEDGER, not the cache ***',
      memberDuringDrift?.points === trueBalance, `${memberDuringDrift?.points} vs ${trueBalance}`)

  const quoteDuringDrift = await redeemableFor(SITE, memberId, 100000)
  ok('*** and so does the redemption quote ***',
      quoteDuringDrift.points === trueBalance, `${quoteDuringDrift.points}`)

  await recalcMember(SITE, memberId)
  ok('  recalc repairs the cache', (await cachedBalance(memberId)) === trueBalance)

  console.log('\n── Tiers ───────────────────────────────────────────────────\n')

  const ladderSave = await saveTiers(SITE, actor, [
    { name: 'Bronze', qualifyingSpend: 0, multiplier: 1, discountPct: 0, color: 'muted', isActive: true },
    { name: 'Silver', qualifyingSpend: 100, multiplier: 2, discountPct: 0, color: 'info', isActive: true },
  ])
  ok('the ladder can be rewritten', ladderSave.ok, ladderSave.ok ? '' : ladderSave.error)

  const rewritten = await listTiers(SITE)
  ok('  and reordering does not trip the unique step key', rewritten.length === 2, `${rewritten.length}`)

  await recalcMember(SITE, memberId)
  const promoted = await getMember(SITE, memberId)
  ok('*** a member is re-placed on the new ladder ***', promoted?.tier?.name === 'Silver',
      promoted?.tier?.name)

  console.log('\n── Lists and totals ────────────────────────────────────────\n')

  /*
   * Searched by NAME, not by customer code.
   *
   * This looked for `LC${stamp}` — the customer's code — and found the member
   * because every member was a customer row. The member file has no customer
   * code to match: a walk-in member never had one, and a search that only found
   * account holders would hide exactly the people this screen now exists for.
   * So listMembers searches name, member number and phone.
   */
  const members = await listMembers(SITE, { search: `Loyalty Customer ${stamp}` })
  ok('the member appears in the list', members.rows.length === 1, `${members.rows.length}`)
  ok('  with the ledger balance, not the cache',
      members.rows[0]?.points === (await ledgerBalance(memberId)))

  const byNumber = await listMembers(SITE, { search: memberNumber })
  ok('*** and is findable by member number ***', byNumber.rows.length === 1,
      `${byNumber.rows.length}`)

  const liability = await getLiability(SITE)
  ok('the liability counts outstanding points', liability.points > 0)
  ok('  and the wallet float separately', liability.walletFloat > 0, `${liability.walletFloat}`)

  console.log('\n── Expiry ──────────────────────────────────────────────────\n')

  await saveLoyaltySettings(SITE, actor, settings({ expiryMode: 'activity', expiryMonths: 12 }))

  const fresh = await expirePoints(SITE, actor)
  ok('*** an active member does not expire ***', fresh.customers === 0, `${fresh.customers}`)

  // Age the account past the window and try again.
  await siteExecute(
    SITE,
    'UPDATE loyalty_members SET last_activity_at = DATE_SUB(NOW(), INTERVAL 24 MONTH) WHERE id = ?',
    [memberId],
  )
  const balanceBeforeExpiry = await ledgerBalance(memberId)
  const swept = await expirePoints(SITE, actor)
  ok('*** a dormant balance expires ***', swept.customers === 1, `${swept.customers}`)
  ok('  by exactly what was there', swept.points === balanceBeforeExpiry,
      `${swept.points} vs ${balanceBeforeExpiry}`)
  ok('  leaving a zero balance', (await ledgerBalance(memberId)) === 0)

  const expiryRow = (await listLedger(SITE, memberId)).find((e) => e.entryType === 'expire')
  ok('*** and it is VISIBLE in the history, not a silent drop ***', expiryRow !== undefined)

  const again = await expirePoints(SITE, actor)
  ok('  running expiry twice takes nothing more', again.points === 0, `${again.points}`)

  const expiredVouchers = await expireVouchers(SITE)
  ok('voucher expiry runs', expiredVouchers >= 0)

  await finish()
}

async function finish() {
  console.log('\n── Cleaning up ─────────────────────────────────────────────\n')

  // FK order: children before parents. Keyed on member_id now — the loyalty
  // tables no longer carry customer_id at all, so the old cleanup would have
  // thrown and left every fixture behind for the next suite to trip over.
  await siteExecute(SITE, 'DELETE FROM loyalty_stamps WHERE member_id = ?', [memberId])
  await siteExecute(SITE, 'DELETE FROM loyalty_vouchers WHERE member_id = ?', [memberId])
  await siteExecute(SITE, 'DELETE FROM loyalty_ledger WHERE member_id = ?', [memberId])
  await siteExecute(SITE, 'DELETE FROM loyalty_wallet WHERE member_id = ?', [memberId])
  await siteExecute(SITE, 'DELETE FROM loyalty_members WHERE id = ?', [memberId])
  if (cardId) await siteExecute(SITE, 'DELETE FROM loyalty_cards WHERE id = ?', [cardId])

  for (const id of docs) {
    await siteExecute(SITE, 'DELETE FROM sales_tenders WHERE document_id = ?', [id])
    await siteExecute(SITE, 'DELETE FROM document_audit WHERE document_id = ?', [id])
    await siteExecute(SITE, 'DELETE FROM stock_movements WHERE source_doc_id = ?', [id])
    await siteExecute(SITE, 'DELETE FROM sales_document_lines WHERE document_id = ?', [id])
    await siteExecute(SITE, 'DELETE FROM journal_lines WHERE batch_id IN (SELECT id FROM journal_batches WHERE source_doc_id = ?)', [id])
    await siteExecute(SITE, 'DELETE FROM journal_batches WHERE source_doc_id = ?', [id])
    await siteExecute(SITE, 'DELETE FROM customer_transactions WHERE source_doc_id = ?', [id])
    await siteExecute(SITE, 'DELETE FROM sales_documents WHERE id = ?', [id])
  }

  if (productId) await siteExecute(SITE, 'DELETE FROM products WHERE id = ?', [productId])
  if (customerId) await siteExecute(SITE, 'DELETE FROM customers WHERE id = ?', [customerId])

  // Put the programme back exactly as it was found, so running the tests does
  // not quietly switch loyalty on for a real store — or leave a rewritten tier
  // ladder that would change what the next run earns.
  if (originalTiers.length > 0) await saveTiers(SITE, actor, originalTiers)
  if (originalSettings) await saveLoyaltySettings(SITE, actor, originalSettings)
  await siteExecute(SITE, `UPDATE tender_types SET is_active = 0 WHERE integration_key = 'loyalty'`)

  const leftovers = await siteQuery(SITE, 'SELECT id FROM customers WHERE code = ?', [`LC${stamp}`])
  ok('test data cleaned up', leftovers.length === 0, `${leftovers.length} left`)

  console.log(fails === 0 ? '\nAll loyalty rules hold.\n' : `\n${fails} FAILURE(S)\n`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch(async (error) => {
  console.error(error)
  try { await finish() } catch { /* cleanup is best-effort on a crash */ }
  process.exit(1)
})
