'use server'

import { revalidatePath } from 'next/cache'
import { actorForModule } from '@/lib/auth'
import {
  saveLoyaltySettings,
  saveTiers,
  adjustPoints,
  expirePoints,
  recalcMember,
  getLoyaltySettings,
  getMember,
} from '@/lib/site/loyalty'
import {
  createCard,
  updateCard,
  setCardActive,
  deleteCard,
  issueVoucher,
  voidVoucher,
  expireVouchers,
  listVouchers,
  type CardInput,
} from '@/lib/site/loyaltyCards'
import { topUpWallet, adjustWallet, getWalletBalance } from '@/lib/site/loyaltyWallet'
import {
  cleanSettings,
  maxRedeemableRand,
  type LoyaltySettings,
  type LoyaltyTier,
} from '@/lib/loyaltyRules'

/**
 * Loyalty actions.
 *
 * The capability split matters here and is not cosmetic. Reading a balance is
 * `loyalty.view`; retuning the programme is `loyalty.edit`; MOVING points or
 * wallet rand is `loyalty.adjust`, because those are money. The person who sets
 * the earn rate once a year is rarely the person who should be able to put ten
 * thousand points on their own account.
 */

export type ActionResult = { ok: true; message: string } | { ok: false; error: string }

export async function saveSettingsAction(raw: LoyaltySettings): Promise<ActionResult> {
  const ctx = await actorForModule('loyalty', 'loyalty.edit')
  if ('ok' in ctx) return ctx

  const cleaned = cleanSettings(raw)
  if ('error' in cleaned) return { ok: false, error: cleaned.error }

  const saved = await saveLoyaltySettings(ctx.siteId, ctx.actor, cleaned)
  if (!saved.ok) return saved

  revalidatePath('/loyalty')
  return {
    ok: true,
    message: cleaned.enabled ? 'The programme is running.' : 'The programme is switched off.',
  }
}

export async function saveTiersAction(tiers: Partial<LoyaltyTier>[]): Promise<ActionResult> {
  const ctx = await actorForModule('loyalty', 'loyalty.edit')
  if ('ok' in ctx) return ctx

  const saved = await saveTiers(ctx.siteId, ctx.actor, tiers)
  if (!saved.ok) return saved

  revalidatePath('/loyalty/tiers')
  return { ok: true, message: 'Tiers saved.' }
}

export async function saveCardAction(
  id: number | null,
  input: CardInput,
): Promise<ActionResult> {
  const ctx = await actorForModule('loyalty', 'loyalty.edit')
  if ('ok' in ctx) return ctx

  const saved = id
    ? await updateCard(ctx.siteId, ctx.actor, id, input)
    : await createCard(ctx.siteId, ctx.actor, input)
  if (!saved.ok) return saved

  revalidatePath('/loyalty/cards')
  return { ok: true, message: id ? 'Card saved.' : 'Card added.' }
}

export async function setCardActiveAction(id: number, isActive: boolean): Promise<ActionResult> {
  const ctx = await actorForModule('loyalty', 'loyalty.edit')
  if ('ok' in ctx) return ctx

  await setCardActive(ctx.siteId, ctx.actor, id, isActive)
  revalidatePath('/loyalty/cards')
  return { ok: true, message: isActive ? 'Card is running.' : 'Card stopped.' }
}

export async function deleteCardAction(id: number): Promise<ActionResult> {
  const ctx = await actorForModule('loyalty', 'loyalty.edit')
  if ('ok' in ctx) return ctx

  const done = await deleteCard(ctx.siteId, ctx.actor, id)
  if (!done.ok) return done

  revalidatePath('/loyalty/cards')
  return { ok: true, message: 'Card deleted.' }
}

/* ── Moving money ────────────────────────────────────────────────────────── */

export async function adjustPointsAction(
  customerId: number,
  points: number,
  reason: string,
): Promise<ActionResult> {
  const ctx = await actorForModule('loyalty', 'loyalty.adjust')
  if ('ok' in ctx) return ctx

  const done = await adjustPoints(ctx.siteId, ctx.actor, customerId, points, reason)
  if (!done.ok) return done

  revalidatePath(`/customers/${customerId}`)
  revalidatePath('/loyalty')
  return {
    ok: true,
    message: `${points > 0 ? 'Added' : 'Removed'} ${Math.abs(points)} points. Balance is now ${done.balance}.`,
  }
}

export async function adjustWalletAction(
  customerId: number,
  amount: number,
  reason: string,
): Promise<ActionResult> {
  const ctx = await actorForModule('loyalty', 'loyalty.adjust')
  if ('ok' in ctx) return ctx

  const done = await adjustWallet(ctx.siteId, ctx.actor, customerId, amount, reason)
  if (!done.ok) return done

  revalidatePath(`/customers/${customerId}`)
  return { ok: true, message: `Wallet is now R${done.balance.toFixed(2)}.` }
}

export async function topUpWalletAction(
  customerId: number,
  amount: number,
  tenderTypeId: number,
  terminalId: number | null,
): Promise<ActionResult> {
  const ctx = await actorForModule('loyalty', 'loyalty.adjust')
  if ('ok' in ctx) return ctx

  const done = await topUpWallet(ctx.siteId, ctx.actor, {
    customerId,
    amount,
    tenderTypeId,
    terminalId,
  })
  if (!done.ok) return done

  revalidatePath(`/customers/${customerId}`)
  return { ok: true, message: `Loaded R${amount.toFixed(2)}. Balance is R${done.balance.toFixed(2)}.` }
}

export async function issueVoucherAction(
  customerId: number,
  rewardValue: number,
  description: string,
  validDays: number,
): Promise<ActionResult> {
  const ctx = await actorForModule('loyalty', 'loyalty.adjust')
  if ('ok' in ctx) return ctx

  const done = await issueVoucher(ctx.siteId, ctx.actor, {
    customerId,
    rewardType: 'value',
    rewardValue,
    description,
    validDays,
    issuedBy: 'manual',
  })
  if (!done.ok) return done

  revalidatePath(`/customers/${customerId}`)
  return { ok: true, message: `Voucher ${done.code} issued.` }
}

export async function voidVoucherAction(id: number, customerId: number): Promise<ActionResult> {
  const ctx = await actorForModule('loyalty', 'loyalty.adjust')
  if ('ok' in ctx) return ctx

  const done = await voidVoucher(ctx.siteId, ctx.actor, id)
  if (!done.ok) return done

  revalidatePath(`/customers/${customerId}`)
  return { ok: true, message: 'Voucher cancelled.' }
}

/* ── Housekeeping ────────────────────────────────────────────────────────── */

/**
 * Runs the expiry sweep by hand.
 *
 * Manual rather than scheduled for now: expiring points is irreversible from a
 * customer's point of view, and a store should be the one deciding the moment
 * it happens rather than discovering a cron job did it overnight.
 */
export async function runExpiryAction(): Promise<ActionResult> {
  const ctx = await actorForModule('loyalty', 'loyalty.adjust')
  if ('ok' in ctx) return ctx

  const points = await expirePoints(ctx.siteId, ctx.actor)
  const vouchers = await expireVouchers(ctx.siteId)

  revalidatePath('/loyalty')

  if (points.customers === 0 && vouchers === 0) {
    return { ok: true, message: 'Nothing had lapsed — no points or vouchers expired.' }
  }
  return {
    ok: true,
    message: `${points.points} points expired across ${points.customers} account${points.customers === 1 ? '' : 's'}, and ${vouchers} voucher${vouchers === 1 ? '' : 's'}.`,
  }
}

/* ── The till ────────────────────────────────────────────────────────────── */

export type TillStanding = {
  points: number
  pointsValue: number
  maxRedeemable: number
  walletBalance: number
  tierName: string
  vouchers: { code: string; description: string; rewardLabel: string; value: number }[]
}

/**
 * What a customer is holding, for the tender pad.
 *
 * Guarded on `sales.till` rather than `loyalty.view`: the cashier ringing up
 * the sale needs this to offer the reward, and requiring a back-office
 * capability would hide it from exactly the person who has to use it.
 *
 * Returns null when the programme is off, so the till simply shows nothing
 * rather than an empty loyalty panel.
 */
export async function tillStandingAction(customerId: number): Promise<TillStanding | null> {
  const ctx = await actorForModule('loyalty', 'sales.till')
  if ('ok' in ctx) return null

  const settings = await getLoyaltySettings(ctx.siteId)
  if (!settings.enabled) return null

  const [member, vouchers, walletBalance] = await Promise.all([
    getMember(ctx.siteId, customerId, settings),
    listVouchers(ctx.siteId, { customerId, spendableOnly: true }),
    getWalletBalance(ctx.siteId, customerId),
  ])
  if (!member) return null

  return {
    points: member.points,
    pointsValue: member.pointsValue,
    // Capped only by the balance and the minimum here — the basket total caps
    // it again in the pad, where the amount owed is known.
    maxRedeemable: maxRedeemableRand(member.points, Number.MAX_SAFE_INTEGER, settings),
    walletBalance,
    tierName: member.tier?.name ?? '',
    vouchers: vouchers.map((v) => ({
      code: v.code,
      description: v.description,
      rewardLabel:
        v.rewardType === 'free_item'
          ? (v.rewardProductName ?? 'Free product')
          : `R${v.rewardValue.toFixed(2)}`,
      // A free-item voucher discounts nothing: the product is rung up at zero.
      value: v.rewardType === 'value' ? v.rewardValue : 0,
    })),
  }
}

export async function recalcMemberAction(customerId: number): Promise<ActionResult> {
  const ctx = await actorForModule('loyalty', 'loyalty.adjust')
  if ('ok' in ctx) return ctx

  await recalcMember(ctx.siteId, customerId)
  revalidatePath(`/customers/${customerId}`)
  return { ok: true, message: 'Balance rebuilt from the ledger.' }
}
