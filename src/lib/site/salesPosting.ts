import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteTransaction } from '../siteDb'
import { customerOwnerSite } from '../storeGroups'
import { round, toNum } from '../decimals'
import { assertBalanced, documentTotals, roundToCash } from '../documentMath'
import { headroomRefusal, NO_SPEND } from '../creditRules'
import { accountSpend } from './customerSpend'
import { toAccountType } from '../accountTypes'
import {
  adoptDocumentNumber,
  nextDocumentNumber,
  numberValueOf,
  SITE_SEQUENCE,
} from './sequences'
import { numberSegmentsFor } from './numbering'
import { recordMovement, stockDirectionFor, canSellNow } from './stockMovements'
import { ensureStock } from './referBreakdown'
import { getTenderType, getTenderByCode, checkTenders, type TenderType } from './tenderTypes'
import { validateTerminalClaim, terminalStockLocationId } from './terminals'
import { shiftToBankInto } from './shifts'
import { writeTips } from './tips'
/* The PURE planner, not the server module's re-export — same function either way, but
   importing it from here keeps the dependency pointing at the shared arithmetic that the
   tender pad also runs. */
import { planTips } from '../tipMath'
import { getNumericSetting, getSettings } from './settings'
import { today } from './ledger'
import { guardPosting } from './periodLocks'
import { getDocument, isEditable, type SalesDocument } from './salesDocuments'
import { requireSalesReason } from './salesReasons'
import {
  resolveComponents,
  explodingProducts,
  refillableProducts,
  type ResolvedComponent,
} from './productComposition'
import { checkSellable, markSold } from './serials'
import { postTransaction, reverseTransaction } from './customerLedger'
import type { Actor } from './activityLog'
import {
  getLoyaltySettings,
  listTiers,
  memberIdForCustomer,
  redeemPointsForSale,
  awardSaleLoyalty,
  reverseSaleLoyalty,
} from './loyalty'
import {
  loyaltySpendRefusal,
  redeemVoucherForSale,
  awardSaleStamps,
  reverseSaleStamps,
  restoreVoucherForDocument,
  findVoucher,
  type LoyaltyVoucher,
} from './loyaltyCards'
import { loyaltyTransaction } from './loyaltyDb'
import { spendWalletForSale, refundWalletForSale } from './loyaltyWallet'

/**
 * Finalise — the one moment a sale becomes real.
 *
 * EVERYTHING happens inside a single siteTransaction: stock moves, tenders are
 * recorded, the debtor ledger posts, and the document number is issued. Either
 * all of it commits or none of it does. A sale that moved stock but issued no
 * number, or issued a number but posted no ledger entry, is not recoverable by
 * any amount of tidying up afterwards.
 *
 * ── ORDER MATTERS ────────────────────────────────────────────────────────
 *
 * The document number is claimed LAST, immediately before commit. Claiming it
 * takes an exclusive lock on the sequence row that is held until commit, so
 * issuing it first would serialise every other write in the sale behind it and
 * turn a busy multi-till shop into a queue. See sequences.ts.
 *
 * ── WHAT THIS REFUSES ────────────────────────────────────────────────────
 *
 * Guards run BEFORE anything is written, so a refusal costs nothing and leaves
 * nothing behind. They are listed in finaliseGuards() rather than scattered.
 */

export type TenderInput = {
  tenderTypeId: number
  /** What the customer handed over — gross, not the amount owed. */
  amount: number
  reference?: string | null
}

export type FinaliseInput = {
  documentId: number
  tenders: TenderInput[]
  /** Required when a tender posts to an account. */
  customerId?: number | null
  /**
   * Who earns and spends the loyalty on this sale.
   *
   * Separate from customerId because they are separate things — see the note
   * where this is resolved. Omitted, it falls back to the member linked to the
   * attached customer, if there is one.
   */
  memberId?: number | null
  /**
   * Which individual units are going out, keyed by document line id. Only
   * serial-tracked lines need it, and one is required per unit sold.
   *
   * Supplied at finalise rather than saved on the draft because the cashier
   * picks the actual box off the shelf at the moment of sale — a serial chosen
   * when the basket was built may well not be the one they hand over.
   */
  serials?: Record<number, number[]>
  /**
   * Loyalty voucher codes the cashier scanned.
   *
   * Spent inside the sale's transaction, so a code cannot be used at two tills
   * at once. A rand-value voucher also funds part of the basket, and that slice
   * earns no points — see `fundedAmount` below.
   */
  voucherCodes?: string[]
  /**
   * A discount code already applied to the lines (140).
   *
   * The MONEY is on the lines — per-line discount_incl written at save — so
   * nothing here changes a figure. This SPENDS the code inside the sale's
   * transaction (the same lost-update guard the storefront uses: the last use
   * of a single-use code cannot be given to two tills at once) and stamps the
   * document with the why.
   */
  discountCode?: { codeId: number; code: string; amountIncl: number } | null
  /**
   * A number this sale was ALREADY printed under, for a sale rung up offline.
   *
   * Normally undefined and the number is allocated here, last, under the
   * document_sequences row lock — which is right for an online sale and must not
   * change. A sale rung up offline was already handed to a customer on a printed
   * tax invoice bearing a specific number, so that number is not ours to choose:
   * it is used as given and the till's sequence is advanced past it in this same
   * transaction. uq_doc_number is what refuses a genuine duplicate, so the number
   * is never simply trusted because a client sent it.
   */
  documentNumber?: string | null
  /**
   * The shift to bank into, when the caller already knows.
   *
   * For an online sale this is undefined and the shift is resolved here, because
   * "the shift that banked it" is the one open right now. An OFFLINE sale is
   * different: the cash went into a specific drawer at a specific moment, and by
   * the time it syncs — possibly the next morning — that shift may be closed and
   * another open. Banking it into whichever shift happens to be open at sync time
   * makes one drawer inexplicably over and another short by the same amount, and
   * no amount of counting afterwards can tell you which sale did it.
   *
   * `undefined` means "resolve it"; an explicit `null` means "belongs to no
   * shift", which shiftToBankInto already treats as legitimate.
   */
  shiftId?: number | null
  /**
   * Tips a cashier DECLARED at the pad, keyed by tender type id.
   *
   * Only cash needs this: R100 handed over on a R50 bill might be R50 change or R10 tip and
   * R40 change, and nothing can infer which. A no-change tender's over-tender is decided by
   * `tender_types.tip_on_over_tender` with no prompt at all.
   *
   * Keyed by TENDER TYPE rather than positional, because a basket may hold two payments on
   * one method and a tip row records the method, not the payment.
   *
   * Absent on every existing caller, which leaves the behaviour exactly as it was.
   */
  declaredTips?: Record<number, number>
  /**
   * A forced service charge, already worked out from the tier table.
   *
   * Passed in rather than computed here: the tiers live in the database and
   * `tips_tables_only` needs to know whether a table is attached, and this function runs
   * inside a transaction holding the most contended lock in the schema — two more queries
   * in there would widen it for every till.
   *
   * NOT added to the document total. It was added to what the customer owed before they
   * paid, so it is already inside the bill they settled; recorded as a tip because that is
   * what it is.
   */
  serviceCharge?: number
}

export type FinaliseResult =
  | { ok: true; documentId: number; documentNumber: string; change: number; roundingAdj: number }
  | { ok: false; error: string }

/**
 * Posts a document.
 *
 * Returns the issued number so the till can print immediately, and the change
 * so the drawer figure is never recomputed from a different rounding.
 */
export async function finaliseDocument(
  siteId: number,
  actor: Actor,
  input: FinaliseInput,
): Promise<FinaliseResult> {
  const document = await getDocument(siteId, input.documentId)
  if (!document) return { ok: false, error: 'That sale no longer exists.' }

  const guard = await finaliseGuards(siteId, document)
  if (guard) return { ok: false, error: guard }

  // Resolve every tender type up front: the engine branches on their flags, and
  // a missing one must fail before anything is written.
  const tenders: { input: TenderInput; type: TenderType }[] = []
  for (const tender of input.tenders) {
    const type = await getTenderType(siteId, tender.tenderTypeId)
    if (!type) return { ok: false, error: 'That payment method no longer exists.' }
    if (!type.isActive) return { ok: false, error: `${type.name} is not available.` }
    tenders.push({ input: tender, type })
  }

  const customerId = input.customerId ?? document.customerId ?? null

  /*
   * ── THE MEMBER, WHICH IS NOT THE CUSTOMER ────────────────────────────────
   *
   * Two attachments now, because they answer different questions: the customer
   * authorises account credit and carries terms and a price structure, the
   * member earns and spends loyalty. A walk-in member has no customer; an
   * account holder may never have joined.
   *
   * The till sends memberId explicitly. When it does not, and a customer IS
   * attached, the member linked to that customer is used — a customer who is
   * also a member does not have to be attached twice, and a cashier who scans
   * a card gets the loyalty without a second step. Auto rather than an offer,
   * per the decision recorded in docs/plans/loyalty-members.md.
   *
   * Resolved through the loyalty owner, so a branch finds the group's member.
   */
  const memberId =
    input.memberId ?? (customerId ? await memberIdForCustomer(siteId, customerId) : null)

  /*
   * ── A DEPOSIT ALREADY PAID IS A TENDER, NOT A DISCOUNT (172) ──────────────
   *
   * Money held against this document was handed over on an earlier day and
   * counted in that day's cash-up. So it settles the sale exactly like the
   * EXCHANGE tender settles the netted half of an exchange: added to the
   * tender list BEFORE the check below, so `check.outstanding` reaches zero
   * without the cashier keying money the customer is not handing over now.
   *
   * Reducing `netPayable` instead — the way a voucher does — would be wrong.
   * A voucher reduces what is owed because no money ever existed; a deposit is
   * real cash that was received, and the invoice has to say it was paid or the
   * customer's copy shows a total nobody settled.
   *
   * Capped at the document total by `tenderAtFinalise`, and `allows_change = 0`
   * on the tender row is the second guard: a deposit larger than the sale must
   * never hand back cash from a drawer that never received it.
   *
   * Added only when the caller has not already sent one, so the offline sync
   * path — which replays the tenders it captured at the till — is untouched.
   */
  const depositTender = await getTenderByCode(siteId, 'DEPOSIT')
  let depositApplied = 0
  if (depositTender?.isActive && !tenders.some((t) => t.type.code === 'DEPOSIT')) {
    const { tenderForDocument } = await import('./deposits')
    const held = await tenderForDocument(siteId, document.id)
    if (held.amount > 0) {
      depositApplied = held.amount
      tenders.push({
        input: { tenderTypeId: depositTender.id, amount: held.amount, reference: null },
        type: depositTender,
      })
    }
  }

  /* Checked AFTER the deposit is added, not before: a sale covered in full by
     money already paid is settled, and refusing it as "take a payment first"
     would leave the cashier keying a tender the customer does not owe. */
  if (tenders.length === 0) return { ok: false, error: 'Take a payment before finalising.' }

  // Which of the tenders spend a loyalty balance, and which vouchers were
  // scanned. Resolved before the tender arithmetic because a voucher changes
  // what is owed; the balances themselves are spent inside the transaction.
  const pointsTender = tenders.find(
    (t) => t.type.integrationKey === 'loyalty' && t.type.code === 'LOYALTY_POINTS',
  )
  const walletTender = tenders.find(
    (t) => t.type.integrationKey === 'loyalty' && t.type.code === 'LOYALTY_WALLET',
  )
  const voucherCodes = [...new Set((input.voucherCodes ?? []).map((c) => c.trim().toUpperCase()))]
    .filter(Boolean)

  const usesLoyalty = !!pointsTender || !!walletTender || voucherCodes.length > 0
  const loyaltySettings = usesLoyalty || customerId ? await getLoyaltySettings(siteId) : null

  /*
   * ── LOYALTY IS CHECKED HERE AND WRITTEN AFTER THE COMMIT ────────────────
   *
   * It used to be neither: the spend ran INSIDE the sale's transaction and
   * threw, so an unaffordable redemption rolled the whole sale back. That was
   * the right guarantee and it is no longer available — under a shared
   * programme the loyalty rows are in another database, and no transaction
   * spans two. The old arrangement did not degrade there, it failed outright:
   * ER_NO_REFERENCED_ROW_2 on loyalty_ledger, the throw propagating, and the
   * till unable to complete any sale to a member.
   *
   * So the guarantee is rebuilt rather than relocated. Everything that could
   * refuse the redemption is asked BEFORE the sale opens — programme running,
   * member attached and active, enough points, enough wallet, every voucher
   * valid and unspent. A sale that gets past this point is one the member can
   * afford.
   *
   * What is lost, stated plainly: a crash between the commit and the spend
   * leaves goods sold and the balance untouched. That is a real gap and it is
   * the better half of the trade — the alternative is a till that cannot sell
   * to a member at all. It is recoverable by hand from the document, which a
   * rolled-back sale in a queue is not.
   */
  if (usesLoyalty) {
    if (!loyaltySettings?.enabled) {
      return { ok: false, error: 'The loyalty programme is not running.' }
    }
    // A MEMBER, not a customer. The two tenders no longer carry
    // requires_customer — that would refuse every walk-in member, who is the
    // case the member file exists for — so this guard is the only thing
    // standing between a voucher and a sale with nobody to charge it to.
    if (!memberId) {
      return { ok: false, error: 'Attach a member before using loyalty.' }
    }

    const refusal = await loyaltySpendRefusal(siteId, memberId, {
      points: pointsTender ? Math.abs(pointsTender.input.amount) : 0,
      wallet: walletTender ? Math.abs(walletTender.input.amount) : 0,
      voucherCodes,
      settings: loyaltySettings,
    })
    if (refusal) return { ok: false, error: refusal }
  }

  // Recompute totals from the stored lines rather than trusting the header:
  // the header is a cache, and finalising against a stale one would post a
  // figure that does not match the lines it is made of.
  const totals = documentTotals(
    document.lines.map((line) => ({
      grossIncl: round(line.qty * line.unitPriceIncl, 2),
      discountIncl: line.discountIncl,
      lineTotalIncl: line.lineTotalIncl,
      lineTotalExcl: line.lineTotalExcl,
      lineVat: line.lineVat,
      vatRatePct: line.vatRatePct,
    })),
  )
  assertBalanced(totals)

  // 5c rounding applies to what the DRAWER takes, never to the invoice. The
  // invoice keeps its exact total so the VAT declared stays exact; the
  // difference is recorded as rounding_adj.
  /**
   * What the cashier actually hands back, after tips.
   *
   * Declared out here and set inside the transaction, the same way `roundingAdj` crosses
   * that boundary. Seeded from the raw excess so a sale with no tips is unchanged: the
   * whole excess is change, exactly as before.
   */
  let changeToHandBack: number | null = null

  const denomination = await getNumericSetting(siteId, 'sales_cash_rounding')
  const anyCash = tenders.some((t) => t.type.roundsToCashDenomination)
  const { rounded: payable, adjustment: roundingAdj } =
    anyCash && denomination > 0
      ? roundToCash(totals.totalIncl, denomination)
      : { rounded: totals.totalIncl, adjustment: 0 }

  // A rand-value voucher REDUCES WHAT IS OWED — it is not a tender. Priced here,
  // before the tender check, or the till would be asked to cover the voucher's
  // value in cash and every voucher sale would refuse with "still to pay".
  //
  // Priced from the stored row rather than from anything the till sent, so a
  // client claiming a R500 voucher gets the R25 the database says it is worth.
  // Only the value is read now; the state machine still flips inside the
  // transaction, which is what makes a code single-use.
  const voucherPreview = await previewVouchers(siteId, voucherCodes)
  if (!voucherPreview.ok) return { ok: false, error: voucherPreview.error }
  const voucherCredit = voucherPreview.credit

  // The tender row a redeemed voucher is recorded against. Looked up rather
  // than assumed: a store that has never switched loyalty on has no such row,
  // and in that case previewVouchers has already refused the sale.
  const voucherTenderId =
    voucherCredit > 0
      ? ((await getTenderByCode(siteId, 'LOYALTY_POINTS'))?.id ?? null)
      : null
  if (voucherCredit > 0 && !voucherTenderId) {
    return { ok: false, error: 'Switch the Loyalty points tender on before taking vouchers.' }
  }

  /*
   * ── GIFT CARDS (147): PREVIEWED HERE, SPENT INSIDE THE TRANSACTION ────────
   *
   * A gift card is a TENDER, not a voucher: the money was paid in when the
   * card sold, so redemption rides sales_tenders at what was drawn and never
   * nets off what is owed. The courtesy checks here refuse before anything is
   * written; the FOR UPDATE + conditional UPDATE inside the transaction is
   * the guard that makes two tills racing over one balance safe.
   */
  const giftTenders = tenders.filter((t) => t.type.integrationKey === 'gift_card')
  const giftLines = document.lines.filter((l) => l.productType === 'gift_card')

  if (giftTenders.length > 0 || giftLines.length > 0) {
    const { findGiftCard, giftCardRefusal, normaliseGiftCardCode } = await import('./giftCards')
    const localDate = today()

    // Buying a gift card WITH a gift card is a rollover loop that resets the
    // expiry clock and launders the trail — refused outright.
    if (giftTenders.length > 0 && giftLines.length > 0) {
      return { ok: false, error: 'A gift card cannot pay for another gift card.' }
    }

    const seen = new Set<string>()
    for (const tender of giftTenders) {
      const code = normaliseGiftCardCode(tender.input.reference ?? '')
      if (!code) return { ok: false, error: 'Scan or type the gift card number.' }
      if (seen.has(code)) {
        return { ok: false, error: 'The same gift card is entered twice.' }
      }
      seen.add(code)
      // A negative amount is a credit-note refund landing ON the card, which
      // needs no balance; spending does.
      if (tender.input.amount > 0) {
        const card = await findGiftCard(siteId, code)
        const refusal = giftCardRefusal(card, code, localDate)
        if (refusal) return { ok: false, error: refusal }
        if (card && round(tender.input.amount, 2) > round(card.balance, 2) + 0.005) {
          return {
            ok: false,
            error: `The card holds ${card.balance.toFixed(2)} — not enough for ${tender.input.amount.toFixed(2)}.`,
          }
        }
      }
    }

    for (const line of giftLines) {
      const name = line.description
      if (document.docType === 'credit_sale') {
        return {
          ok: false,
          error: `${name}: a gift card cannot go on a credit note — void the original sale, or adjust the card under Gift cards.`,
        }
      }
      if (round(line.qty, 3) !== 1) {
        return { ok: false, error: `${name}: gift cards sell one per line, so each line names its card.` }
      }
      if (round(line.discountIncl, 2) !== 0) {
        return { ok: false, error: `${name}: gift cards sell at face value — no discounts.` }
      }
      if (round(line.vatRatePct, 3) !== 0) {
        return { ok: false, error: `${name}: give the gift card product a 0% VAT rate — VAT belongs on the goods it eventually buys.` }
      }
      if (!(line.lineTotalIncl > 0)) {
        return { ok: false, error: `${name}: a gift card needs an amount above zero.` }
      }
      if (!line.giftCardCode) {
        return { ok: false, error: `${name}: the line is missing its card number — remove it and ring the card up again.` }
      }
    }
  }

  // Read outside the transaction — settings must not widen the numbering lock.
  const giftValidityMonths =
    giftLines.length > 0 ? await getNumericSetting(siteId, 'gift_card_validity_months') : 0

  /*
   * ── TIPS ARE PLANNED BEFORE THE TENDER CHECK, NOT AFTER ───────────────────
   *
   * `checkTenders` refuses any excess the drawer cannot give back as change. A tender that
   * takes tips has no change to give and is not in error, so the check has to be told how
   * much of the excess is already accounted for — otherwise a legitimate card tip is refused
   * with "Over-tendered by 50.00, but only 0.00 can give change".
   *
   * MEASURED: that is exactly what an offline card tip did at sync until this moved. The pad
   * had the identical bug and the identical fix; this is the server half of it.
   *
   * The plan is recomputed inside the transaction as well, against `check.change`, because
   * that is where the rows are written. Planning twice is cheap and pure; the alternative is
   * carrying a value across the transaction boundary for no gain.
   */
  const netPayable = round(Math.max(0, payable - voucherCredit), 2)
  const tenderedTotal = tenders.reduce((sum, t) => round(sum + t.input.amount, 2), 0)
  const preCheckTips = planTips({
    totalExcess: round(Math.max(0, tenderedTotal - netPayable), 2),
    tenders: tenders.map(({ input, type }) => ({
      tenderTypeId: type.id,
      amount: input.amount,
      allowsChange: type.allowsChange,
      tipOnOverTender: type.tipOnOverTender,
      tenderName: type.name,
    })),
    declared: input.declaredTips,
  })
  /* A refusal here is reported as the refusal it is, rather than being left to surface as a
     confusing change error a few lines down. */
  if (!preCheckTips.ok) return { ok: false, error: preCheckTips.error }
  /* Service tips excluded: a service charge was added to the bill BEFORE payment, so it is
     inside what the customer settled and never part of the excess. */
  const tippableExcess = round(
    preCheckTips.tips
      .filter((t) => t.source !== 'service')
      .reduce((sum, t) => sum + t.amount, 0),
    2,
  )

  const check = checkTenders(
    tenders.map((t) => ({ tender: t.type, amount: t.input.amount, reference: t.input.reference })),
    netPayable,
    customerId !== null,
    tippableExcess,
  )
  if (check.errors.length > 0) return { ok: false, error: check.errors[0] }
  if (check.outstanding > 0) {
    return { ok: false, error: `${check.outstanding.toFixed(2)} still to pay.` }
  }

  // Credit check before anything is written, so an over-limit account is
  // refused at the till rather than discovered in the age analysis.
  const accountTender = tenders.find((t) => t.type.postsToDebtor)
  if (accountTender) {
    if (!customerId) return { ok: false, error: 'Choose a customer for an account sale.' }
    const refusal = await creditRefusal(
      siteId,
      customerId,
      accountTender.input.amount,
      document.documentDate,
    )
    if (refusal) return { ok: false, error: refusal }
  }

  // Every line must be sellable BEFORE any stock moves — a basket that fails
  // halfway would otherwise leave some products decremented.
  for (const line of document.lines) {
    const sellable = canSellNow(line.productType)
    if (!sellable.ok) return { ok: false, error: `${line.description}: ${sellable.reason}` }
  }

  // Composed products (recipe, refer) move their COMPONENTS, not themselves.
  // Resolved out here, before the transaction opens, so a half-built recipe is
  // refused while nothing has moved rather than rolling back mid-sale.
  //
  // A MANUFACTURED recipe is excluded: it was built ahead of time and carries a
  // pile of its own, so it falls through to the ordinary stockDirectionFor path
  // below and the finished unit is what leaves.
  const exploding = await explodingProducts(
    siteId,
    document.lines
      .filter((l) => l.productId && (l.productType === 'recipe' || l.productType === 'refer'))
      .map((l) => l.productId as number),
  )

  /*
   * Which sold lines a bigger pack can be broken open for.
   *
   * Resolved by LINK rather than by product type, because the base of a ladder
   * is a `normal` product by design — see refillableProducts(). Guarding on the
   * type instead left the single at the bottom, the rung a case exists to
   * refill, as the one product that could never be refilled: selling it simply
   * drove it negative with full cases sitting on the shelf.
   *
   * Every line with a product is offered, not just the refer-typed ones, for
   * exactly that reason.
   */
  const refillable = await refillableProducts(
    siteId,
    document.lines.filter((l) => l.productId).map((l) => l.productId as number),
  )

  const composed = new Map<number, ResolvedComponent[]>()
  for (const line of document.lines) {
    if (!line.productId) continue
    if (line.productType !== 'recipe' && line.productType !== 'refer') continue
    if (!exploding.has(line.productId)) continue

    const resolved = await resolveComponents(siteId, line.productId, line.productType)
    if (!resolved.ok) return { ok: false, error: `${line.description}: ${resolved.error}` }
    composed.set(line.id, resolved.components)
  }

  /*
   * Costs for the products an ANSWER deducts — "extra bacon" taking a rasher.
   *
   * Resolved out here for the same reason the components above are: reading a
   * cost inside the transaction widens the most contended lock in the schema,
   * and this is one query for the whole document however many answers it
   * carries. Tolerant of the table not existing, so a site that has not run 082
   * still posts its sales.
   */
  const optionProductIds = [
    ...new Set(
      document.lines
        .flatMap((l) => l.instructions ?? [])
        .map((c) => c.productId)
        .filter((id): id is number => typeof id === 'number' && id > 0),
    ),
  ]
  const optionCosts = optionProductIds.length
    ? new Map(
        (
          await siteQuery<RowDataPacket & { id: number; average_cost: string | number }>(
            siteId,
            // `average_cost`, the same column a sale line's own unitCostExcl is
            // taken from — a modifier's stock movement must value at the same
            // basis as the line it hangs off, or the two disagree in the GP
            // report about a single sale.
            `SELECT id, average_cost FROM products
              WHERE id IN (${optionProductIds.map(() => '?').join(',')})`,
            optionProductIds,
          ).catch(() => [])
        ).map((r) => [Number(r.id), toNum(r.average_cost)]),
      )
    : new Map<number, number>()

  // Serial-tracked lines need one identified unit per item sold, checked here
  // so a sale is refused before any stock moves rather than halfway through.
  for (const line of document.lines) {
    if (!line.productId || line.productType !== 'serial') continue

    const picked = input.serials?.[line.id] ?? []
    const needed = Math.abs(round(line.qty, 0))

    if (picked.length !== needed) {
      return {
        ok: false,
        error: `${line.description}: choose ${needed} serial number${needed === 1 ? '' : 's'} — ${picked.length} selected.`,
      }
    }
    if (new Set(picked).size !== picked.length) {
      return { ok: false, error: `${line.description}: the same serial number is selected twice.` }
    }

    const sellable = await checkSellable(siteId, line.productId, picked)
    if (!sellable.ok) return { ok: false, error: `${line.description}: ${sellable.error}` }
  }

  // Which shift banks this sale — the till's in terminal mode, the operator's
  // own in user mode. Null when there is no open shift to bank into, which is
  // allowed: a store that does not cash up still needs to trade.
  //
  // The actor is the PIN operator, not the browser session (requireActor
  // resolves it that way), so in a restaurant this is the waiter who rang the
  // sale up rather than whoever opened the browser that morning.
  // `undefined` means resolve it here; an explicit null from an offline sale means
  // "belongs to no shift" and must not be resolved into whichever shift happens to
  // be open at sync time. See FinaliseInput.shiftId.
  const shiftId =
    input.shiftId !== undefined
      ? input.shiftId
      : await shiftToBankInto(siteId, document.terminalId ?? null, actor.userId ?? null)

  /* Which sequence numbers this document, resolved BEFORE the transaction opens.
     It reads `settings` and `terminals`, and the numbering statement runs while
     holding the most contended lock in the schema — two extra queries in there
     would widen it for every till. Null for anything that is not a till invoice. */
  const numbering = await numberSegmentsFor(
    siteId,
    document.docType,
    document.terminalId ?? null,
    document.origin,
  )

  /*
   * Which room this sale comes off.
   *
   * Null means the till names none — or there is no till, which is every
   * back-office invoice, paid online order and contract run — and null is
   * carried onward as null so `recordMovement` applies the main-location
   * fallback it has always applied, inside the transaction. Resolving main
   * here instead would move that read outside the transaction and reopen the
   * race the fallback exists to close. See terminalStockLocationId().
   *
   * Read BEFORE the transaction, like the numbering above and for the same
   * reason: this is one more query that has no business running while the
   * stock rows are locked.
   */
  const saleLocationId = await terminalStockLocationId(siteId, document.terminalId)

  // Rand of this basket paid for by a value voucher. Set inside the
  // transaction, read after it commits to keep that slice out of the earn
  // basis. Declared out here because a closure cannot return it and the
  // document number at once without restructuring the result.
  let voucherFunded = 0

  // Vouchers this sale consumed, collected inside the transaction and marked
  // spent after it commits. Held out here for the same reason as voucherFunded:
  // the closure cannot hand them back alongside the document number.
  const redeemedVouchers: LoyaltyVoucher[] = []

  try {
    const posted = await siteTransaction(siteId, async (tx) => {
      // 1. Stock. Direction comes from the product type, not from the sign of
      //    the quantity — a returnable puts stock IN when sold.
      for (const line of document.lines) {
        if (!line.productId) continue

        /*
         * What the ANSWERS took off the shelf, before anything else about this
         * line is decided.
         *
         * Before, deliberately: a composed line `continue`s a few lines down,
         * and extra bacon on a recipe burger still consumes a rasher of bacon.
         * Putting this after that jump would silently skip every modifier on
         * every recipe product — which in a kitchen is most of the menu.
         *
         * These movements are IN ADDITION to whatever the line itself moves.
         * The burger goes, and so does the bacon.
         */
        for (const chosen of line.instructions ?? []) {
          if (!chosen.productId) continue
          const taken = round(chosen.stockQtyPer * chosen.qty * line.qty, 3)
          if (taken === 0) continue

          await recordMovement(tx, actor, {
            productId: chosen.productId,
            movementType: line.qty > 0 ? 'sale' : 'sale_return',
            qtyChange: -taken,
            unitCostExcl: optionCosts.get(chosen.productId) ?? 0,
            source: document.docType,
            sourceDocId: document.id,
            sourceLineId: line.id,
            terminalId: document.terminalId,
            locationId: saleLocationId,
            shiftId,
            // Names the parent AND the answer, so the bacon's history reads
            // "the burger on invoice 1042 asked for two of these" rather than
            // looking like an unexplained deduction.
            note: `${line.productCode ?? line.description} · ${chosen.optionName} × ${chosen.qty}`.slice(
              0,
              190,
            ),
          })
        }

        // A composed product has no pile of its own — selling a burger moves a
        // patty, a bun and a slice of cheese. Each movement names a REAL
        // product and a REAL quantity, so Σ qty_change still equals
        // stock_on_hand for every one of them.
        const components = composed.get(line.id)
        if (components) {
          for (const component of components) {
            await recordMovement(tx, actor, {
              productId: component.productId,
              movementType: line.qty > 0 ? 'sale' : 'sale_return',
              qtyChange: round(-line.qty * component.qtyPerUnit, 3),
              unitCostExcl: component.unitCostExcl,
              source: document.docType,
              sourceDocId: document.id,
              sourceLineId: line.id,
              terminalId: document.terminalId,
              locationId: saleLocationId,
              shiftId,
              // Names the parent, so the component's history reads "used by"
              // rather than looking like an unexplained deduction.
              note: `${line.productCode ?? line.description} × ${component.qtyPerUnit}`.slice(0, 190),
            })
          }
          continue
        }

        /*
         * A line that reached here carries a pile of its own. Two types can:
         * a MANUFACTURED recipe, built ahead of time, and a NORMAL-METHOD
         * refer, a pack the shop physically owns. The exploding set above
         * filtered out the ones that deduct something else instead.
         */
        const carriesOwnStock =
          (line.productType === 'recipe' || line.productType === 'refer') &&
          !exploding.has(line.productId)

        const direction = stockDirectionFor(line.productType, carriesOwnStock)
        if (direction === 0) continue

        /*
         * Break a larger pack open if this one has run out.
         *
         * Selling a single with none on the shelf opens a six-pack; if there
         * are no six-packs either, it opens a case first. Done BEFORE the sale
         * movement below so the single is on the shelf to be sold, and inside
         * this transaction so the whole lot rolls back together.
         *
         * Membership of `refillable` is the whole test — a pack drawing on this
         * product under normal refers. NOT the product type: the base of a
         * ladder is `normal`, and testing the type here excluded the one rung
         * that most needs refilling. See refillableProducts().
         *
         * Only on the way OUT. A credit note (qty < 0) puts stock back and has
         * nothing to break open — and it must never re-close a case, because
         * the shop cannot un-open one either.
         */
        if (refillable.has(line.productId) && line.qty > 0) {
          await ensureStock(tx, actor, line.productId, line.qty, {
            source: document.docType,
            sourceDocId: document.id,
            sourceLineId: line.id,
            terminalId: document.terminalId,
            // The case is broken open IN THE ROOM THIS TILL SELLS FROM, so both
            // halves of the unpack — the case out, the singles in — land where
            // the goods physically are. Sending them to main would move a pack
            // the storeroom is holding.
            locationId: saleLocationId,
            shiftId,
          })
        }

        await recordMovement(tx, actor, {
          productId: line.productId,
          movementType: line.qty > 0 ? 'sale' : 'sale_return',
          // qty is negative on a credit note, so multiplying by the direction
          // reverses it correctly without a second branch.
          qtyChange: round(-line.qty * -direction, 3),
          unitCostExcl: line.unitCostExcl,
          source: document.docType,
          sourceDocId: document.id,
          sourceLineId: line.id,
          terminalId: document.terminalId,
          locationId: saleLocationId,
          shiftId,
          note: line.productCode ?? undefined,
        })

        // Which individual units went out. In the SAME transaction as the
        // movement, so stock and serials can never disagree about what left.
        const picked = input.serials?.[line.id]
        if (line.productType === 'serial' && picked && picked.length > 0) {
          await markSold(tx, actor, {
            serialIds: picked,
            productId: line.productId,
            documentId: document.id,
            documentLineId: line.id,
            customerId: customerId ?? document.customerId,
          })
        }
      }

      /*
       * 2. TIPS FIRST, then tenders.
       *
       * A tip and change are two claims on ONE excess, and the loop below divides what is
       * left as change — so tips have to come out of it first, or the same rand is recorded
       * twice: once handed back, once kept.
       *
       * ── PLANNED FROM THE RAW EXCESS, NOT FROM check.change ──────────────────
       *
       * Using `check.change` here was a bug, MEASURED: the check has already subtracted the
       * tip (that is what `tippableExcess` above is for), so by this point it reports ZERO
       * change on a fully-tipped over-payment — and the plan then had nothing to claim and
       * wrote no tip row. Right refusal, no record.
       *
       * So the pre-check plan is REUSED and only the service charge is added, rather than
       * planning a second time against a figure that has already been reduced.
       */
      const tipPlan = planTips({
        totalExcess: round(Math.max(0, tenderedTotal - netPayable), 2),
        tenders: tenders.map(({ input: paid, type }) => ({
          tenderTypeId: type.id,
          amount: paid.amount,
          allowsChange: type.allowsChange,
          tipOnOverTender: type.tipOnOverTender,
          tenderName: type.name,
        })),
        declared: input.declaredTips,
        serviceCharge:
          input.serviceCharge && input.serviceCharge > 0.005 && tenders[0]
            ? { tenderTypeId: tenders[0].type.id, amount: input.serviceCharge }
            : null,
      })
      /*
       * A refusal here is a real one and must abort the finalise.
       *
       * It means a no-change tender was paid over on a method that neither gives change nor
       * accepts tips — so there is no honest place for the money. Posting anyway would
       * either keep it silently or leave the document unbalanced against its tenders.
       *
       * In practice the pre-check above has already returned this refusal as a clean error;
       * this is the backstop for a service charge that only appears here.
       */
      if (!tipPlan.ok) throw new Error(tipPlan.error)

      /*
       * Carried OUT of the transaction, because the caller is told what to hand back and
       * that figure must be the post-tip one.
       *
       * The bug this fixes was measured: the tip row, `change_given` and the drawer were
       * all correct at R40, while the RETURN value still said R50 — so the receipt screen
       * would have told a cashier to hand back money the till had just kept as a gratuity.
       * Right in the database, wrong on the screen, which is the worse half to get wrong.
       */
      changeToHandBack = tipPlan.changeRemaining

      await writeTips(tx, {
        documentId: document.id,
        shiftId,
        /* Whoever the SALE is attributed to — the waiter who served the table. Not
           `actor`, which on a back-office finalise is whoever pressed the button. */
        userId: document.userId ?? actor.userId ?? null,
        userName: document.userName || actor.userName,
        tips: tipPlan.tips,
      })

      // 3. Tenders, as handed over. Change is recorded against the tender that
      //    gave it, so the drawer reconciles — and it divides what is left AFTER tips.
      let remainingChange = tipPlan.changeRemaining
      for (const { input: tender, type } of tenders) {
        const changeHere =
          type.allowsChange && remainingChange > 0 ? Math.min(remainingChange, tender.amount) : 0
        remainingChange = round(remainingChange - changeHere, 2)

        await tx.execute(
          `INSERT INTO sales_tenders
             (document_id, tender_type_id, tender_code, tender_name, amount, change_given, surcharge, reference)
           VALUES (?,?,?,?,?,?,?,?)`,
          [
            document.id,
            type.id,
            type.code,
            type.name,
            round(tender.amount, 2).toFixed(4),
            changeHere.toFixed(4),
            type.surchargePct > 0
              ? round(tender.amount * (type.surchargePct / 100), 2).toFixed(4)
              : '0.0000',
            tender.reference?.trim() || null,
          ] as never,
        )
      }

      /*
       * Deposits consumed (172), on THIS connection.
       *
       * Written inside the transaction so a deposit can never be recorded as
       * spent by a sale that then rolls back — the customer would have paid
       * money the system had forgotten and the sale would still be owing.
       *
       * The row is negative with kind 'applied', so Σ amount falls to zero and
       * nothing is still held, while what was taken and when stays readable on
       * the document afterwards.
       */
      if (depositApplied > 0) {
        const { applyDepositsTx } = await import('./deposits')
        await applyDepositsTx(
          tx,
          actor,
          document.id,
          depositApplied,
          shiftId,
          document.terminalId ?? null,
        )
      }

      // 3. The number, LAST. See the module comment on lock ordering.
      /*
       * Three paths, and only the first is the common one:
       *
       *   · a normal sale allocates from its sequence — the site-wide row, or this
       *     till's own row when the store numbers per till;
       *   · an offline sale arrives carrying the number already printed on the
       *     customer's slip, so the sequence is advanced PAST it rather than
       *     allocating a second one;
       *   · everything that is not a till invoice keeps numbering site-wide,
       *     because `numbering` is null for it.
       */
      let documentNumber: string
      if (input.documentNumber) {
        const value = numberValueOf(input.documentNumber)
        if (value === null) {
          throw new Error(`Cannot read a counter out of the number "${input.documentNumber}".`)
        }
        await adoptDocumentNumber(
          tx,
          document.docType,
          numbering?.terminalId ?? SITE_SEQUENCE,
          value,
        )
        documentNumber = input.documentNumber
      } else {
        documentNumber = await nextDocumentNumber(
          tx,
          document.docType,
          new Date(),
          numbering?.terminalId ?? SITE_SEQUENCE,
          numbering?.segments,
        )
      }

      // 4. The SALE's half of a loyalty spend.
      //
      // Only the rows that belong to this document are written here. The
      // loyalty-side rows — the points deduction, the wallet debit, the
      // voucher's own status — are written after this transaction commits, by
      // the block marked "loyalty spend, after the commit" below.
      //
      // The split is not a preference. Those rows live in the loyalty owner's
      // database whenever the programme is shared, and `tx` cannot reach it.
      // What CAN be kept transactional is kept transactional: the voucher's
      // tender row has to rise and fall with the sale, because a tender row
      // without its sale is a document that does not balance.
      //
      // Affordability was settled before this transaction opened. A voucher
      // read here is one loyaltySpendRefusal already found valid and unspent.
      if (usesLoyalty && memberId && loyaltySettings) {
        for (const code of voucherCodes) {
          const voucher = await findVoucher(siteId, code)
          if (!voucher) throw new Error(`No voucher with code ${code}.`)
          redeemedVouchers.push(voucher)

          // Recorded against the LOYALTY_POINTS tender so the document balances:
          // total_incl stays the exact figure the customer was charged (and so
          // the VAT declared stays exact), while tendered_total accounts for
          // every rand of it. Writing the voucher off as a discount instead
          // would understate turnover and the VAT on it.
          if (voucher.rewardType === 'value' && voucher.rewardValue > 0 && voucherTenderId) {
            await tx.execute(
              `INSERT INTO sales_tenders
                 (document_id, tender_type_id, tender_code, tender_name, amount, change_given, surcharge, reference)
               VALUES (?,?,?,?,?,'0.0000','0.0000',?)`,
              [
                document.id,
                voucherTenderId,
                'LOYALTY_POINTS',
                'Loyalty voucher',
                round(voucher.rewardValue, 2).toFixed(4),
                voucher.code,
              ] as never,
            )
          }

          // A rand-value voucher pays for part of the basket, so that slice
          // must not also earn points — otherwise a reward buys the next one.
          if (voucher.rewardType === 'value') {
            voucherFunded = round(voucherFunded + voucher.rewardValue, 2)
          }
        }
      }

      /*
       * Spend the discount code, AFTER the number is issued so the use row can
       * never precede its document, and INSIDE the transaction so the throw
       * rolls the whole sale back — the customer keeps their basket and the
       * cashier reads why. Same guard as the storefront's checkout.
       */
      if (input.discountCode) {
        const { redeemCode } = await import('./discountCodes')
        const spent = await redeemCode(tx, {
          codeId: input.discountCode.codeId,
          documentId: document.id,
          customerId: customerId ?? null,
          contactEmail: '',
          amountIncl: input.discountCode.amountIncl,
        })
        if (!spent) throw new Error('That code has been fully used.')
        await tx.execute(
          `UPDATE sales_documents SET discount_code_id = ?, discount_code = ? WHERE id = ?`,
          [input.discountCode.codeId, input.discountCode.code.slice(0, 40), document.id] as never,
        )
      }

      /*
       * Gift cards (147), after the number exists so every event names its
       * sale. Both directions THROW on refusal — an unsellable card or a
       * short balance rolls the whole sale back, stock, number and all.
       */
      if (giftLines.length > 0 || giftTenders.length > 0) {
        const { activateGiftCardForSale, redeemGiftCardForSale } = await import('./giftCards')
        for (const line of giftLines) {
          await activateGiftCardForSale(tx, actor, siteId, {
            code: line.giftCardCode ?? '',
            amount: line.lineTotalIncl,
            documentId: document.id,
            documentNumber,
            validityMonths: giftValidityMonths,
            shiftId,
            terminalId: document.terminalId ?? null,
          })
        }
        for (const tender of giftTenders) {
          // The sign carries the direction: positive spends the card, and a
          // credit note's negative tender pays the refund back ONTO it.
          await redeemGiftCardForSale(tx, actor, siteId, {
            code: tender.input.reference ?? '',
            amount: round(tender.input.amount, 2),
            documentId: document.id,
            documentNumber,
            shiftId,
            terminalId: document.terminalId ?? null,
          })
        }
      }

      await tx.execute(
        `UPDATE sales_documents SET
           status = 'finalised', document_number = ?, finalised_at = NOW(),
           customer_id = ?, shift_id = ?, subtotal_excl = ?, vat_total = ?, discount_total = ?,
           total_incl = ?, rounding_adj = ?, tendered_total = ?, change_given = ?
         WHERE id = ?`,
        [
          documentNumber,
          customerId,
          // Stamped at finalise rather than at capture: a sale belongs to the
          // shift that BANKED it, and a saved basket may be recalled by the
          // next person on the till.
          shiftId,
          totals.subtotalExcl.toFixed(4),
          totals.vatTotal.toFixed(4),
          totals.discountTotal.toFixed(4),
          totals.totalIncl.toFixed(4),
          roundingAdj.toFixed(4),
          // The vouchers count towards what settled the sale — they have their
          // own sales_tenders rows — so the header total has to include them or
          // it disagrees with the rows beneath it.
          round(check.tendered + voucherCredit, 2).toFixed(4),
          check.change.toFixed(4),
          document.id,
        ] as never,
      )

      await tx.execute(
        `INSERT INTO document_audit (document_id, action, detail, user_id, user_name)
         VALUES (?, 'finalised', ?, ?, ?)`,
        [
          document.id,
          `${documentNumber} · ${totals.totalIncl.toFixed(2)} · ${tenders.map((t) => t.type.name).join(', ')}`,
          actor.userId,
          actor.userName.slice(0, 120),
        ] as never,
      )

      return { documentNumber }
    })

    // 4. The debtor ledger, AFTER the sale is safely committed.
    //
    // Deliberately outside the transaction: the ledger lives in its own
    // consistent world with its own invariant, and a failure to post there must
    // not un-sell goods that have already left the shop. A missing ledger entry
    // is visible on the account and fixable; an un-posted sale with stock gone
    // is not.
    if (accountTender && customerId) {
      await postTransaction(siteId, actor, {
        customerId,
        // THE BOUNDARY. A sales-side `credit_sale` posts to the ledger as a
        // `credit_note`, because on an account that is what it is: a credit
        // adjustment against the balance. Same event, two vocabularies, and
        // this line is where one becomes the other.
        docType: document.docType === 'credit_sale' ? 'credit_note' : 'invoice',
        amount: Math.abs(accountTender.input.amount),
        docDate: document.documentDate,
        docNumber: posted.documentNumber,
        description: `${document.docLabel} ${posted.documentNumber}`,
        source: 'sale',
        sourceDocId: document.id,
      })
    }

    // 5. The general ledger, also after the commit and for the same reason.
    //
    // Revenue, VAT, what was tendered, and — the pair that makes a profit and
    // loss mean anything — cost of sales against stock. Without those two,
    // revenue appears with no cost against it and every month looks wildly
    // profitable.
    //
    // Cannot fail the sale: the GL is a derived mirror, so a missing journal is
    // a reporting gap that ledgerHealth() reports rather than a reason to
    // un-sell goods that have left the shop. See 045.
    const { mirrorSale } = await import('./glPosting')
    const isCreditSale = document.docType === 'credit_sale'

    // Revenue per department, so a departmental profit and loss is possible.
    const revenueByDepartment = new Map<number | null, number>()
    let costOfSales = 0
    let giftCardLiability = 0
    for (const line of document.lines) {
      // Stored value sold is not revenue — it is money held for the bearer.
      // These lines go to the liability instead, and carry no cost: nothing
      // left the shelf. VAT is zero by the guard above, so incl equals excl.
      if (line.productType === 'gift_card') {
        giftCardLiability = round(giftCardLiability + line.lineTotalIncl, 2)
        continue
      }
      const departmentId = line.departmentId ?? null
      revenueByDepartment.set(
        departmentId,
        round((revenueByDepartment.get(departmentId) ?? 0) + line.lineTotalExcl, 2),
      )

      /*
       * A COMPOSED LINE COSTS WHAT WENT INTO IT.
       *
       * line.unitCostExcl comes from products.average_cost, which for an
       * exploding recipe is 0.0000 — nothing was ever purchased called
       * "burger". Using it debited cost of sales with nothing while the
       * component movements credited stock with their real cost, so every
       * recipe sale reported 100% gross profit and the two halves of the
       * journal described different events.
       *
       * The components are already resolved above, with each one's cost on it,
       * so the true figure costs no extra query. A MANUFACTURED recipe is not
       * in this map and needs none of it: its build wrote a real average_cost.
       */
      const components = composed.get(line.id)
      const unitCost = components
        ? round(
            components.reduce((sum, c) => sum + c.qtyPerUnit * c.unitCostExcl, 0),
            4,
          )
        : line.unitCostExcl

      costOfSales = round(costOfSales + line.qty * unitCost, 2)
    }

    await mirrorSale(siteId, actor, {
      documentId: document.id,
      documentNumber: posted.documentNumber,
      documentDate: document.documentDate,
      isCreditNote: isCreditSale,
      revenueLines: [...revenueByDepartment.entries()].map(([departmentId, excl]) => ({
        departmentId,
        excl,
      })),
      vatTotal: totals.vatTotal,
      costOfSales,
      // The voucher rides along as a tender here for the same reason it is one
      // on the document: the journal must account for every rand of the total,
      // and a voucher-funded slice with no tender behind it leaves the entry
      // unbalanced by exactly its value.
      tenders: [
        ...tenders.map((t) => ({
          tenderTypeId: t.type.id,
          isAccount: t.type.postsToDebtor,
          amount: Math.abs(t.input.amount),
        })),
        ...(voucherCredit > 0 && voucherTenderId
          ? [{ tenderTypeId: voucherTenderId, isAccount: false, amount: voucherCredit }]
          : []),
      ],
      customerId,
      roundingAdjustment: roundingAdj,
      giftCardLiability,
    })

    /*
     * 5b. Loyalty SPEND, after the commit.
     *
     * ── WHY THIS IS NOT FAIL-SOFT ────────────────────────────────────────
     *
     * Earning below swallows its errors, because missing points are a small
     * debt to a member that anyone can grant by hand. Spending is the
     * opposite: a failure here means the member kept a balance they have
     * already been given goods for. That is a loss to the shop, and it must
     * be loud.
     *
     * So each failure is logged with the document number — the one thing
     * needed to put it right — and the sale still stands. Refusing to return
     * a committed sale would be worse: the till would show a failure for a
     * document that exists, and the cashier would ring it up twice.
     *
     * ── WHY IT IS ALMOST NEVER REACHED ───────────────────────────────────
     *
     * Every affordability question was asked before the sale opened. What
     * remains is a genuine fault — the owner's database gone in the seconds
     * since, or another till taking the same balance first. Both are rare and
     * both need a person, which is what `console.error` summons.
     */
    if (usesLoyalty && memberId && loyaltySettings) {
      const tiers = await listTiers(siteId)

      if (pointsTender) {
        try {
          await loyaltyTransaction(siteId, (ltx) =>
            redeemPointsForSale(
              ltx,
              actor,
              // The store making the sale. Under a shared programme the ledger
              // lives elsewhere, and document.id only identifies a document
              // alongside the site it came from.
              siteId,
              {
                memberId,
                documentId: document.id,
                documentNumber: posted.documentNumber,
                randAmount: Math.abs(pointsTender.input.amount),
              },
              loyaltySettings,
              tiers,
            ),
          )
        } catch (error) {
          console.error(
            '[loyalty] POINTS NOT DEDUCTED for',
            posted.documentNumber,
            '— member',
            memberId,
            error,
          )
        }
      }

      if (walletTender) {
        try {
          await loyaltyTransaction(siteId, (ltx) =>
            spendWalletForSale(ltx, actor, siteId, {
              memberId,
              documentId: document.id,
              documentNumber: posted.documentNumber,
              amount: Math.abs(walletTender.input.amount),
            }),
          )
        } catch (error) {
          console.error(
            '[loyalty] WALLET NOT DEBITED for',
            posted.documentNumber,
            '— member',
            memberId,
            error,
          )
        }
      }

      // Marked spent one at a time, so one already-used voucher does not strand
      // the others. redeemVoucherForSale re-checks status under its own lock:
      // this is where a race with another till is actually caught.
      for (const voucher of redeemedVouchers) {
        try {
          await loyaltyTransaction(siteId, (ltx) =>
            redeemVoucherForSale(ltx, {
              code: voucher.code,
              documentId: document.id,
              documentNumber: posted.documentNumber,
            }),
          )
        } catch (error) {
          console.error(
            '[loyalty] VOUCHER NOT MARKED SPENT:',
            voucher.code,
            'on',
            posted.documentNumber,
            error,
          )
        }
      }
    }

    // 6. Loyalty EARNING, after the commit and fail-soft.
    //
    // Spending a balance is a condition of the sale and earning is a
    // consequence of it — which is why the two are checked so differently.
    // Everything that could refuse a spend is asked before the sale opens;
    // earning is never allowed to refuse anything at all. A loyalty table that
    // is briefly unreachable must never stop a shop trading: missing points are
    // visible on the account and can be granted by hand, while an un-postable
    // sale at a queue of customers cannot be undone.
    //
    // Skipped entirely for a credit note: a return does not earn. What it does
    // instead is reverse the original sale's points, which happens in
    // reverseLoyaltyForDocument when the credit note names its parent.
    if (memberId && loyaltySettings?.enabled && !isCreditSale) {
      // Gift-card lines earn nothing: buying stored value is moving money,
      // not spending it. The points come later, on the goods it buys.
      const loyaltyLines = document.lines
        .filter((line) => line.productType !== 'gift_card')
        .map((line) => ({
          productId: line.productId ?? null,
          departmentId: line.departmentId ?? null,
          qty: line.qty,
          lineTotalIncl: line.lineTotalIncl,
          discountIncl: line.discountIncl,
        }))

      // Points and wallet rand already belong to the customer, so the slice
      // they paid for earns nothing. Wallet spend is excluded too: the points
      // were granted when the money was spent, not when it was loaded.
      const funded = round(
        (pointsTender ? Math.abs(pointsTender.input.amount) : 0) +
          (walletTender ? Math.abs(walletTender.input.amount) : 0) +
          voucherFunded,
        2,
      )

      try {
        await awardSaleLoyalty(siteId, actor, {
          memberId,
          documentId: document.id,
          documentNumber: posted.documentNumber,
          lines: loyaltyLines,
          fundedAmount: funded,
        })
      } catch (error) {
        console.error('[loyalty] award failed for', posted.documentNumber, error)
      }

      try {
        await awardSaleStamps(siteId, actor, {
          memberId,
          documentId: document.id,
          documentNumber: posted.documentNumber,
          lines: loyaltyLines,
        })
      } catch (error) {
        console.error('[loyalty] stamps failed for', posted.documentNumber, error)
      }
    }

    // The webhook queue, post-commit and fail-soft like every mirror above —
    // enqueueEvent swallows its own errors, and delivery happens on the tick.
    try {
      const { enqueueEvent } = await import('./webhooks')
      await enqueueEvent(siteId, 'sale.finalised', {
        documentId: document.id,
        documentNumber: posted.documentNumber,
        docType: document.docType,
        documentDate: document.documentDate,
        totalIncl: document.totalIncl,
        customerId: document.customerId,
      })
    } catch (error) {
      console.error('[webhooks] enqueue failed for', posted.documentNumber, error)
    }

    /*
     * Auto-email the invoice, post-commit and fail-soft.
     *
     * On this side of the commit for the same reason as loyalty and the
     * webhook queue: the sale is already posted, the customer is already at
     * the counter, and a mail server that is down or slow must never be the
     * reason a shop cannot trade. A missing email is visible and re-sendable
     * from the document screen; an un-postable sale is not recoverable.
     *
     * Awaited rather than fired and forgotten, because the process may be
     * serverless and a floating promise would be killed when the response is
     * returned — the send would simply not happen, silently, on exactly the
     * deployments where nobody is watching a console.
     */
    if (customerId && !isCreditSale) {
      try {
        // Dynamic, like the webhook and loyalty hooks above: this pulls in the
        // PDF renderer and the mail transport, which no till sale that is not
        // auto-emailing should pay to load.
        const { autoEmailInvoice } = await import('./invoiceEmail')
        await autoEmailInvoice(siteId, actor, customerId, document.id)
      } catch (error) {
        console.error('[invoice] auto-email failed for', posted.documentNumber, error)
      }
    }

    return {
      ok: true,
      documentId: document.id,
      documentNumber: posted.documentNumber,
      /* Post-tip. `?? check.change` keeps every existing caller identical: with no tips
         planned the two are the same number, and a sale that never reached the tip step
         still reports the full excess. */
      change: changeToHandBack ?? check.change,
      roundingAdj,
    }
  } catch (error) {
    // The transaction has rolled back, so no stock moved and no number was
    // consumed. Surface the reason rather than a generic failure — at a till,
    // "something went wrong" is unactionable.
    const message = error instanceof Error ? error.message : 'The sale could not be posted.'
    return { ok: false, error: message }
  }
}

/**
 * Prices scanned vouchers, before anything is written.
 *
 * Two jobs. It tells the tender engine how much of the basket the vouchers
 * cover — a R25 voucher means R25 less to collect, not R25 of tender — and it
 * refuses a code that cannot be spent while the sale can still be abandoned
 * cleanly. Nothing is reserved here: the row is re-read and flipped under a
 * lock inside the transaction, which is what actually makes a code single-use.
 *
 * A `free_item` voucher contributes NOTHING to the credit. The free product is
 * rung up as a line at zero, so crediting its value here would discount the
 * basket twice.
 */
async function previewVouchers(
  siteId: number,
  codes: readonly string[],
): Promise<{ ok: true; credit: number } | { ok: false; error: string }> {
  if (codes.length === 0) return { ok: true, credit: 0 }

  // Local date, not toISOString(): a voucher must not expire two hours early
  // because UTC midnight came first.
  const todayStr = today()
  let credit = 0

  for (const code of codes) {
    const voucher = await findVoucher(siteId, code)
    if (!voucher) return { ok: false, error: `No voucher with code ${code}.` }
    if (voucher.status === 'redeemed') {
      return { ok: false, error: `Voucher ${code} has already been used.` }
    }
    if (voucher.status === 'void') return { ok: false, error: `Voucher ${code} has been cancelled.` }
    if (voucher.status === 'expired') return { ok: false, error: `Voucher ${code} has expired.` }
    if (voucher.expiresOn && voucher.expiresOn < todayStr) {
      return { ok: false, error: `Voucher ${code} expired on ${voucher.expiresOn}.` }
    }

    if (voucher.rewardType === 'value') credit = round(credit + voucher.rewardValue, 2)
  }

  return { ok: true, credit }
}

/** Everything that stops a document being posted. Runs before any write. */
async function finaliseGuards(siteId: number, document: SalesDocument): Promise<string | null> {
  if (!isEditable(document.status)) {
    return document.status === 'finalised'
      ? `This sale was already finalised as ${document.documentNumber}.`
      : `A ${document.status} document cannot be finalised.`
  }
  if (document.lines.length === 0) return 'Add at least one line before finalising.'

  // A quote or an order is not a tax document; converting it creates a linked
  // invoice rather than posting the quote itself.
  if (document.docType === 'quote' || document.docType === 'sales_order') {
    return `A ${document.docLabel.toLowerCase()} is not posted — convert it to an invoice.`
  }

  const lockRefusal = await guardPosting(siteId, document.documentDate, 'sales')
  if (lockRefusal) return lockRefusal

  // A deactivated till stops working on its next sale, not at the next sign-in.
  //
  // Only for a sale that came FROM that till. A back-office invoice records the
  // machine it was captured on as attribution, and that is not a claim to be
  // trading through it: someone finishing an invoice on a laptop whose till
  // registration was released this morning is not a till failure, and refusing
  // to post it would strand real work behind a setup screen.
  if (document.origin === 'till' && document.terminalId) {
    const terminal = await validateTerminalClaim(siteId, document.terminalId)
    if (!terminal) return 'This till is no longer registered. Re-register it in Setup → Tills.'
  }

  return null
}

/**
 * Why this account cannot take this amount on credit. Null means it can.
 *
 * Re-checked here even though the till already asked: a basket can sit on
 * screen for ten minutes while someone else settles — or exhausts — the same
 * account. The RULES come from lib/creditRules.ts, so this and the till cannot
 * reach different conclusions; only the freshness of the balance differs, and
 * this one is authoritative.
 */
async function creditRefusal(
  siteId: number,
  customerId: number,
  amount: number,
  documentDate: string,
): Promise<string | null> {
  /*
   * ── WHEN THE SHARED CUSTOMER FILE CANNOT BE REACHED ──────────────────────
   *
   * The customer may live in the group's primary store rather than here — see
   * customerOwnerSite(). This is the credit check, so reading the wrong
   * database would authorise credit against a balance that is not the real one.
   *
   * But the owner is another machine's database, and it can be down while this
   * till is perfectly online. That is a state a single store never had, and the
   * WRONG thing to invent a third behaviour for: the shop already has a settled
   * answer for "cannot check the balance right now", and it is the offline
   * account-sales setting the owner configured deliberately.
   *
   *   OFF (the default)  refuse the account sale, saying why. Cash and card are
   *                      untouched, so the shop keeps trading.
   *   ON                 sell on account anyway. Exactly what an offline till
   *                      does — see offlineCapability.ts, which spells out what
   *                      the owner accepted when they switched it on.
   *
   * Only a CONNECTION failure lands here. A customer that does not exist, or a
   * query that is wrong, still surfaces as itself.
   */
  let row: (RowDataPacket & Record<string, unknown>) | null
  try {
    row = await siteQueryOne<RowDataPacket & Record<string, unknown>>(
      (await customerOwnerSite(siteId)).siteId,
      `SELECT name, status, account_type, credit_limit, daily_limit, monthly_limit, balance
         FROM customers WHERE id = ? LIMIT 1`,
      [customerId],
    )
  } catch {
    return sharedFileUnreachableRefusal(siteId)
  }
  if (!row) return 'That customer no longer exists.'

  const account = {
    name: String(row.name),
    status: String(row.status),
    accountType: toAccountType(row.account_type),
    creditLimit: toNum(row.credit_limit),
    dailyLimit: toNum(row.daily_limit),
    monthlyLimit: toNum(row.monthly_limit),
    balance: toNum(row.balance),
  }

  // Measured against the document's OWN date, not today: a back-dated invoice
  // belongs to the window it falls in, and charging it against this morning's
  // daily limit would refuse it for spending that happened in another month.
  // Skipped entirely where no cap is set — the common case, and a month of
  // tenders is not worth summing to reach a conclusion that cannot change.
  const spend =
    account.dailyLimit > 0 || account.monthlyLimit > 0
      ? await accountSpend(siteId, customerId, documentDate)
      : NO_SPEND

  // A group-wide measurement that could not read every branch gives a FLOOR,
  // not a total — and the branch it could not read is exactly where the rest of
  // today's drawdown would be. Approving on that basis is how one limit becomes
  // five, so it is treated as the same question as an unverifiable balance and
  // answered by the same shop setting.
  //
  // Checked before headroomRefusal rather than after: if the partial figure
  // already breaches the cap the sale is refused either way, but when it does
  // NOT breach, "within the limit" is a claim this data cannot support.
  if (spend.unreadable?.length) {
    const refusal = await sharedFileUnreachableRefusal(siteId)
    if (refusal) return refusal
  }

  return headroomRefusal(account, amount, spend)
}

/**
 * What to do when the group's customer file cannot be read.
 *
 * Returns a refusal, or null to let the sale through unchecked.
 *
 * ── WHY THIS REUSES THE OFFLINE SETTING ──────────────────────────────────
 *
 * The question is identical to the one an offline till faces: may this shop
 * sell on account without being able to verify the balance? A shop that
 * answered it once should not be asked again in different words because the
 * cause happens to be a sibling store's database rather than its own network.
 *
 * The refusal names the real cause rather than saying "offline", because the
 * till is not offline — every other tender still works — and a cashier told the
 * wrong thing will go looking for the wrong problem.
 *
 * Never throws. If even the SETTING cannot be read, the answer is the safe one:
 * refuse the credit, keep taking cash.
 */
async function sharedFileUnreachableRefusal(siteId: number): Promise<string | null> {
  try {
    const settings = await getSettings(siteId, ['pos_offline_account_sales'])
    if (settings.pos_offline_account_sales === '1') return null
  } catch {
    // Fall through to the refusal.
  }
  return (
    'The shared customer file cannot be reached, so this account’s balance ' +
    'cannot be checked. Take cash or card, or ask an owner to allow account ' +
    'sales when the balance cannot be verified.'
  )
}

/**
 * creditRefusal, exposed for scripts/test-shared-customer-queries.ts.
 *
 * The unreachable-owner path can only be exercised by actually breaking the
 * connection, and a test that reached in through a private function would be
 * testing a copy of the logic instead of the real one.
 */
export const creditRefusalForTest = creditRefusal

/* ── Void ────────────────────────────────────────────────────────────────── */

export type VoidResult = { ok: true } | { ok: false; error: string }

/**
 * What the person voiding said, and why.
 *
 * The code is what a report groups by and is required. The note is the detail
 * that never fits a code, is optional, and is only offered for reasons whose
 * `allowsNote` says the code does not speak for itself.
 */
export type VoidReasonInput = {
  reasonId: number
  note?: string | null
}

/**
 * Voids a finalised document — same trading day only.
 *
 * Keeps its number and all its lines. A void is not a deletion: the number must
 * still resolve to a document, with a stated reason, or the sequence has an
 * unexplainable hole in it.
 *
 * Cross-day voids are refused deliberately. A void changes a period's reported
 * figures, and after the day is banked that period may already have been
 * reported on. The instrument for a later correction is a credit note.
 */
export async function voidDocument(
  siteId: number,
  actor: Actor,
  documentId: number,
  input: VoidReasonInput,
): Promise<VoidResult> {
  // Resolved before anything else: the id came from a client, and one from the
  // returns list would satisfy the foreign key while labelling the void with
  // the wrong vocabulary.
  const chosen = await requireSalesReason(siteId, 'void', input.reasonId)
  if (!chosen.ok) return { ok: false, error: chosen.error }

  // The narration a person reads. The code alone is terse on a ledger line, and
  // the note alone loses the grouping — so the stored text is both, and it is
  // what the free-text column keeps holding for every reader that predates the
  // codes.
  const note = input.note?.trim() ?? ''
  const reason = note ? `${chosen.reason.name} — ${note}` : chosen.reason.name

  const document = await getDocument(siteId, documentId)
  if (!document) return { ok: false, error: 'That document no longer exists.' }
  if (document.status === 'cancelled') return { ok: false, error: 'That document is already void.' }
  if (document.status !== 'finalised') {
    return { ok: false, error: 'Only a finalised document can be voided.' }
  }

  // Local date, matching how the sale was stamped. toISOString() is UTC, and in
  // the hours after local midnight it refused voiding a sale rung up minutes
  // earlier — the cashup suite caught it at 00:30 SAST.
  const todayStr = today()
  if (document.documentDate !== todayStr) {
    return {
      ok: false,
      error: `${document.documentNumber} was issued on ${document.documentDate}. Raise a credit note instead — voiding it would change a day that has already been banked.`,
    }
  }

  const voidLockRefusal = await guardPosting(siteId, document.documentDate, 'sales')
  if (voidLockRefusal) return { ok: false, error: voidLockRefusal }

  // An ACCOUNT sale put a debit on the customer's card. Voiding the sale
  // without reversing that debit would leave them owing money for goods that
  // came back — wrong on the balance, the statement and the age analysis
  // alike. Found and located BEFORE any stock moves, because the reversal can
  // legitimately refuse (a payment already allocated against it), and
  // discovering that after the stock is back is too late to do anything about.
  const ledgerEntry = document.customerId
    ? await findSaleTransaction(siteId, document.customerId, document.id)
    : null

  if (ledgerEntry) {
    const reversal = await reverseTransaction(
      siteId,
      actor,
      ledgerEntry,
      `Void of ${document.documentNumber}: ${reason}`,
    )
    if (!reversal.ok) {
      return {
        ok: false,
        error: `${document.documentNumber} cannot be voided: ${reversal.error}`,
      }
    }
  }

  /*
   * What each line took off the shelf, so the void can put exactly that back.
   *
   * A product that carries its own pile — a manufactured recipe, a
   * normal-method refer — returns the unit itself. One that explodes took its
   * COMPONENTS, and until now the void reversed nothing for it: the parent
   * returned 0 from stockDirectionFor and the components were never mirrored,
   * so every void of a burger or a subtract-pack six-pack leaked stock.
   *
   * Resolved out here, before the transaction, for the same reason finalise
   * resolves it there: a broken setup is refused while nothing has moved.
   * Unlike finalise this cannot refuse the whole operation — a void must
   * always be possible, or a bad refer link would trap a document forever — so
   * an unresolvable line falls back to reversing the parent, which is what it
   * did before.
   */
  const voidExploding = await explodingProducts(
    siteId,
    document.lines.filter((l) => l.productId).map((l) => l.productId as number),
  )

  const voidComposed = new Map<number, ResolvedComponent[]>()
  for (const line of document.lines) {
    if (!line.productId) continue
    if (!voidExploding.has(line.productId)) continue

    const resolved = await resolveComponents(siteId, line.productId, line.productType)
    if (resolved.ok) voidComposed.set(line.id, resolved.components)
  }

  await siteTransaction(siteId, async (tx) => {
    /*
     * Where the goods GO BACK TO: the room they actually left.
     *
     * Read off the original movements rather than from the till's current
     * setting, and that distinction is the whole point. A till can be
     * re-pointed at another room between the sale and the void — it is a
     * dropdown in setup, and a manager fixing a mis-set till mid-morning is the
     * ordinary case — and a void that honoured the NEW setting would put the
     * goods somewhere they never came from, leaving the original room short by
     * exactly the amount the void was supposed to give it back.
     *
     * This is the same rule the serial restore below already follows, in as
     * many words: "The room it LEFT is on its own 'sold' movement." Keeping the
     * quantity and the units on one rule means they cannot disagree about which
     * shelf a voided sale went back to.
     *
     * Keyed by line, because one document's lines can genuinely differ — an
     * unpack writes into the sale's room while a line captured before this
     * feature landed carries main.
     */
    const [originRows] = await tx.query<(RowDataPacket & Record<string, unknown>)[]>(
      `SELECT source_line_id, product_id, location_id
         FROM stock_movements
        WHERE source_doc_id = ? AND source = ? AND source_line_id IS NOT NULL`,
      [document.id, document.docType] as never,
    )
    const soldFrom = new Map<string, number>()
    for (const r of originRows) {
      if (r.location_id === null || r.source_line_id === null) continue
      soldFrom.set(`${Number(r.source_line_id)}:${Number(r.product_id)}`, Number(r.location_id))
    }
    /* Null when the original movement cannot be found — a document posted
       before this column existed. Null is carried onward as null so
       recordMovement falls back to main, which is exactly where such a sale
       took its stock from. */
    const returnTo = (lineId: number, productId: number): number | null =>
      soldFrom.get(`${lineId}:${productId}`) ?? null

    // Reversing movements. The originals stay — an audit row is never deleted.
    for (const line of document.lines) {
      if (!line.productId) continue

      // The mirror of the explosion at finalise: what the components gave up,
      // they get back. Same quantities, same costs, opposite sign.
      const components = voidComposed.get(line.id)
      if (components) {
        for (const component of components) {
          await recordMovement(tx, actor, {
            productId: component.productId,
            movementType: 'sale_return',
            qtyChange: round(line.qty * component.qtyPerUnit, 3),
            unitCostExcl: component.unitCostExcl,
            source: 'cancelled',
            sourceDocId: document.id,
            sourceLineId: line.id,
            terminalId: document.terminalId,
            locationId: returnTo(line.id, component.productId),
            note: `Void of ${document.documentNumber}`,
          })
        }
        continue
      }

      const direction = stockDirectionFor(
        line.productType,
        (line.productType === 'recipe' || line.productType === 'refer') &&
          !voidExploding.has(line.productId),
      )
      if (direction === 0) continue

      await recordMovement(tx, actor, {
        productId: line.productId,
        movementType: 'sale_return',
        qtyChange: round(line.qty * -direction, 3),
        unitCostExcl: line.unitCostExcl,
        source: 'cancelled',
        sourceDocId: document.id,
        sourceLineId: line.id,
        terminalId: document.terminalId,
        locationId: returnTo(line.id, line.productId),
        note: `Void of ${document.documentNumber}`,
        // A voided batch line returns to the lots IT took (148).
        batch: { returnOfLineId: line.id },
      })
    }

    // Serial-tracked units go back on the shelf as sellable. The stock movement
    // above already returned the quantity; without this the individual units
    // would stay marked 'sold' and reconcileSerials would report drift for a
    // sale that never happened.
    //
    // Resellable without asking, unlike a credit note: a void means the sale
    // never happened, so the goods never left and there is nothing to inspect.
    //
    // location_id has to come back with the status. markSold clears it — a sold
    // unit is in no room — so restoring 'in_stock' without a room would leave a
    // sellable unit sitting nowhere, which the per-location reconciliation
    // reports as drift and which no picking list could find.
    //
    // The room it LEFT is on its own 'sold' movement. Falling back to main
    // covers a unit sold before locations existed, whose history predates the
    // column.
    await tx.execute(
      `UPDATE product_serials s
          SET s.status = 'in_stock', s.sold_doc_id = NULL, s.sold_line_id = NULL,
              s.sold_at = NULL, s.customer_id = NULL,
              s.location_id = COALESCE(
                (SELECT sm.from_location_id
                   FROM serial_movements sm
                  WHERE sm.serial_id = s.id AND sm.action = 'sold'
                    AND sm.document_id = ?
                    AND sm.from_location_id IS NOT NULL
                  ORDER BY sm.id DESC LIMIT 1),
                (SELECT id FROM stock_locations WHERE is_main = 1 ORDER BY id LIMIT 1)
              )
        WHERE s.sold_doc_id = ? AND s.status = 'sold'`,
      [document.id, document.id] as never,
    )

    await tx.execute(
      `INSERT INTO serial_movements (serial_id, action, document_id, user_id, user_name, note)
       SELECT id, 'returned', ?, ?, ?, ?
         FROM product_serials WHERE sold_doc_id IS NULL AND id IN (
           SELECT serial_id FROM serial_movements
            WHERE document_id = ? AND action = 'sold'
         )`,
      [
        document.id,
        actor.userId,
        actor.userName.slice(0, 120),
        `Void of ${document.documentNumber}`,
        document.id,
      ] as never,
    )

    await tx.execute(
      `UPDATE sales_documents
          SET status = 'cancelled', cancel_reason = ?, cancel_reason_id = ?,
              cancelled_at = NOW(), cancelled_by_user_id = ?
        WHERE id = ?`,
      [reason.slice(0, 190), chosen.reason.id, actor.userId, document.id] as never,
    )

    await tx.execute(
      `INSERT INTO document_audit (document_id, action, detail, user_id, user_name)
       VALUES (?, 'cancelled', ?, ?, ?)`,
      [document.id, reason.slice(0, 400), actor.userId, actor.userName.slice(0, 120)] as never,
    )
  })

  // Loyalty, after the void has committed and fail-soft for the same reason
  // earning is: the goods are already back on the shelf, and a loyalty table
  // that is briefly unreachable must not leave the document half-voided.
  await reverseLoyaltyForDocument(siteId, actor, document.id, `Void of ${document.documentNumber}`)

  // The GENERAL LEDGER, after the commit and fail-soft like the mirror at
  // finalise. Without this every voided sale left its journal standing —
  // revenue, VAT and tender all overstated by a sale that never happened.
  // The reversal negates the posted batch exactly, as `sale_void`.
  try {
    const { mirrorSaleReversal } = await import('./glPosting')
    await mirrorSaleReversal(siteId, actor, {
      documentId: document.id,
      documentNumber: document.documentNumber,
      date: today(),
    })
  } catch (error) {
    console.error('[gl] sale reversal failed for document', document.id, error)
  }

  // Gift cards, same side of the commit and same fail-soft rule: redemptions
  // come back as balance, an activation is voided while the card is still
  // whole — and left standing with a log entry when it is not, because
  // clawing value out of a part-spent bearer card is a conversation.
  try {
    const { restoreGiftCardsForDocument } = await import('./giftCards')
    await restoreGiftCardsForDocument(siteId, document.id)
  } catch (error) {
    console.error('[gift-cards] restore failed for document', document.id, error)
  }

  // The bell — voids are the till event a supervisor wants to hear about.
  // Same side of the commit, and notify() swallows its own errors.
  try {
    const { notify } = await import('./notifications')
    await notify(siteId, {
      event: 'sale_voided',
      audience: 'sales.void',
      title: `${document.documentNumber} voided`,
      body: `${reason.slice(0, 120)} — R${document.totalIncl.toFixed(2)}, by ${actor.userName}`,
      href: `/sales/${document.id}`,
    })
  } catch (error) {
    console.error('notify failed for void of document', document.id, error)
  }

  // The webhook queue, same posture.
  try {
    const { enqueueEvent } = await import('./webhooks')
    await enqueueEvent(siteId, 'sale.voided', {
      documentId: document.id,
      documentNumber: document.documentNumber,
      docType: document.docType,
      totalIncl: document.totalIncl,
      reason: reason.slice(0, 200),
    })
  } catch (error) {
    console.error('[webhooks] enqueue failed for void of', document.id, error)
  }

  return { ok: true }
}

/**
 * Undoes everything a sale did to a loyalty account.
 *
 * Called on a void, and by the credit-note path when a sale comes back. Covers
 * all four things a sale can touch, because doing only the obvious one leaves a
 * customer either robbed or paid twice:
 *
 *   POINTS — earned points clawed back, spent points returned.
 *   WALLET — money settled from the card put back on it.
 *   STAMPS — this sale's stamps removed, and any voucher they issued voided.
 *   VOUCHERS — a voucher SPENT on this sale restored to `issued`, so the
 *              customer still has the reward they came in with.
 *
 * Never throws. Each step is independent, so one failing does not abandon the
 * rest, and every failure is logged with the document it belongs to.
 */
export async function reverseLoyaltyForDocument(
  siteId: number,
  actor: Actor,
  documentId: number,
  reason: string,
): Promise<void> {
  const steps: [string, () => Promise<unknown>][] = [
    ['points', () => reverseSaleLoyalty(siteId, actor, documentId, reason)],
    ['wallet', () => refundWalletForSale(siteId, actor, documentId, reason)],
    ['stamps', () => reverseSaleStamps(siteId, documentId)],
    ['voucher', () => restoreVoucherForDocument(siteId, documentId)],
  ]

  for (const [label, run] of steps) {
    try {
      await run()
    } catch (error) {
      console.error(`[loyalty] ${label} reversal failed for document`, documentId, error)
    }
  }
}

/**
 * The ledger entry a sale posted, if it was an account sale.
 *
 * Matched on `source_doc_id` rather than the document number, because the
 * number is a display string that a correction or an import could legitimately
 * repeat, while the source link is the actual relationship.
 *
 * Ignores an entry that has already been reversed, so voiding is not blocked
 * by its own earlier reversal in a retry.
 */
async function findSaleTransaction(
  siteId: number,
  customerId: number,
  documentId: number,
): Promise<number | null> {
  // customer_transactions travels with the customer, so this reads the owner.
  //
  // source_doc_id points at a sales_documents.id in the CALLER's database, and
  // document ids are per-database — store 3 and store 7 both have a 5,001. This
  // query is safe because it also scopes by customer_id, which a shared file
  // does not duplicate. Four other lookups match on source_doc_id ALONE and are
  // not safe; see docs/shared-customer-file-origin-site.md.
  const row = await siteQueryOne<RowDataPacket & Record<string, unknown>>(
    (await customerOwnerSite(siteId)).siteId,
    `SELECT t.id
       FROM customer_transactions t
      WHERE t.customer_id = ? AND t.source_doc_id = ? AND t.source = 'sale'
        AND NOT EXISTS (
          SELECT 1 FROM customer_transactions r WHERE r.reverses_id = t.id
        )
      ORDER BY t.id DESC LIMIT 1`,
    [customerId, documentId],
  )
  return row ? Number(row.id) : null
}

/** Bumps the reprint counter. Some jurisdictions require reprints marked COPY. */
export async function recordPrint(siteId: number, documentId: number): Promise<void> {
  await siteTransaction(siteId, async (tx) => {
    await tx.execute(
      'UPDATE sales_documents SET print_count = print_count + 1, last_printed_at = NOW() WHERE id = ?',
      [documentId] as never,
    )
  })
}
