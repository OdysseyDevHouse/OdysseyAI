'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  Button,
  Callout,
  Field,
  Icons,
  Input,
  Modal,
  NumPad,
  NumPadDisplay,
  StatStrip,
  StatTile,
  TenderTile,
  numPadValue,
  tenderIcon,
} from '@/components/ui'
import { formatMoney, round } from '@/lib/decimals'
import { roundToCash } from '@/lib/documentMath'
// From the PURE module, not site/tenderTypes — that one is server-only, and a
// client component importing it drags the database driver into the browser
// bundle. Same reasoning as documentMath.
import { checkTenders } from '@/lib/tenderMath'
/* The SAME planner the server runs at finalise. A second implementation here is how the
   slip a customer is handed comes to disagree with the books about a tip. */
import { planTips } from '@/lib/tipMath'
import { loyaltyCeiling, prefillAmount } from '@/lib/tenderOffers'
import { headroomRefusal } from '@/lib/creditRules'
import type { TenderType } from '@/lib/site/tenderTypes'
import type { TillCustomer } from '@/lib/site/tillCustomers'
import type { TillStanding } from '@/app/(app)/loyalty/actions'

/**
 * Taking payment, at a till.
 *
 * The ARITHMETIC is not reimplemented here. `checkTenders`, `roundToCash` and
 * `tenderOffers` are the same pure modules the desk till and the posting engine
 * use, so what this pad says is owed and what the server posts cannot disagree.
 * Only the presentation is different: 72px keys, a numeric pad instead of a
 * typed field, and a change figure large enough to read from the far side of a
 * counter.
 *
 * ── ONE SCREEN, NOT TWO STEPS ─────────────────────────────────────────────
 *
 * This pad used to hide the keypad until a tender was chosen: tap Card, get a
 * numpad, commit, come back. That is one extra screen per payment and two per
 * split, and it puts the keypad — the thing a cashier's hand is already on —
 * behind a decision they have usually already made.
 *
 * Now the amount is keyed FIRST and the tender key COMMITS it. Type 50, tap
 * Cash: R50 cash is taken. Tap Exact then Card: the whole outstanding balance
 * goes on card. A split is just "50, Cash, 50, Card" with nothing in between.
 * The four figures, the payments taken, the keypad and every tender key are on
 * screen the whole time, so the cashier never loses sight of what is still owed
 * while entering the next amount.
 *
 * The one exception is a tender needing a reference or a gift-card number —
 * those still ask, because the amount alone is not enough to take the payment.
 *
 * TWO RULES this screen exists to get right, both inherited and both worth
 * repeating where somebody might change them:
 *
 *   1. A tender records what was HANDED OVER, not what was owed. R100 on an
 *      R87.50 sale is a R100 tender with R12.50 change. Storing the net leaves
 *      the drawer short at every cash-up with nothing to explain it.
 *
 *   2. Cash rounding applies to what the DRAWER takes, never to the invoice. The
 *      invoice keeps its exact total so the VAT declared stays exact.
 */

type Taken = { tenderTypeId: number; amount: number; reference?: string | null }

/**
 * Whole-rand tip amounts to offer, off an excess.
 *
 * The common answers to "is any of this a tip" are "the small change" and "all of it", so
 * both are one tap. Rounded DOWN to whole rand because nobody declares a R7.43 tip, and
 * the excess itself is always offered last so "keep the change" needs no arithmetic.
 */
function tipSuggestions(excess: number): number[] {
  const whole = Math.floor(excess)
  if (whole <= 0) return []
  const candidates = [5, 10, 20, 50].filter((n) => n < whole)
  /* De-duplicated: on a R10 excess the 5 and the 10 are the whole list, and offering
     "R10" twice reads as a bug. */
  return [...new Set([...candidates, round(excess, 2)])].slice(-4)
}

export function TenderPad({
  open,
  onClose,
  tenders,
  totalIncl,
  cashRounding,
  customer,
  loyalty = null,
  pending,
  serviceCharge: serviceChargeProp = 0,
  canRemoveServiceCharge = false,
  credit = null,
  depositHeld = 0,
  onGiftCardLookup,
  onFinalise,
}: {
  open: boolean
  onClose: () => void
  tenders: TenderType[]
  totalIncl: number
  cashRounding: number
  /** Null for a walk-in. Non-null is what unlocks an account tender. */
  customer: TillCustomer | null
  /**
   * What this member is holding, or null.
   *
   * `TillStanding` from the loyalty actions — NOT a shape declared here. The desk till's
   * pad redeclared it as its own `LoyaltyStanding`, and a third copy would be a third
   * thing to keep in step with what the server actually returns.
   *
   * Null when the programme is off, when the sale is a walk-in, or when the read failed.
   * All three mean the same thing to this pad: show no loyalty. Loyalty must never be
   * able to block a sale.
   */
  loyalty?: TillStanding | null
  pending: boolean
  /**
   * The forced service charge on this bill, already worked out by the shell.
   *
   * Zero for a counter sale, for a shop with no tiers, and for any bill under the lowest
   * band. Passed in rather than computed here because the tiers live in the database and
   * `tips_tables_only` needs to know whether a table is attached — neither of which this
   * component has any business knowing about.
   */
  serviceCharge?: number
  /**
   * Whether this operator may REMOVE a forced service charge.
   *
   * `sales.discount_override`. A waiter cannot take one off — that is the policy — but
   * somebody must be able to, or a customer who refuses it leaves a bill nobody in the
   * building can correct. Every removal is recorded with the name of whoever did it.
   */
  canRemoveServiceCharge?: boolean
  /**
   * Credit already covering part of this sale — an exchange's held return.
   * DISPLAY-ONLY here: the pad collects the real-money balance, and the server
   * adds the EXCHANGE tender itself when it posts the pair. Like a voucher, it
   * reduces what is owed rather than being a payment the cashier keys.
   */
  credit?: { amount: number; label: string } | null
  /**
   * A deposit already taken against this document on an earlier day.
   *
   * Its own prop rather than folded into `credit`, because a bill can carry
   * both an exchange credit and a deposit and `credit` holds exactly one —
   * overloading it would silently drop whichever arrived second.
   *
   * Behaves like `credit` otherwise: DISPLAY-ONLY, reducing what the pad asks
   * for. `finaliseDocument` adds the held amount as a DEPOSIT tender when it
   * posts, so a pad that asked for the full total would post the sale over-paid
   * by exactly the deposit — and DEPOSIT gives no change and takes no tip, so
   * `planTips` refuses it outright and the sale cannot be finalised at all.
   */
  depositHeld?: number
  /**
   * Looks a gift card up for the redemption step (147). Wired by the shell to
   * a server action — the pad itself stays database-free. Absent means the
   * store has no gift cards and the tender key never asks.
   */
  onGiftCardLookup?: (
    code: string,
  ) => Promise<
    | { ok: true; code: string; display: string; balance: number; expiresOn: string | null }
    | { ok: false; error: string }
  >
  onFinalise: (
    taken: Taken[],
    voucherCodes: string[],
    /** Declared tips per tender type, and whether the service charge was waived. */
    tipInfo: { declared: Record<number, number>; serviceChargeWaived: boolean },
  ) => void
}) {
  const hasCustomer = customer !== null
  const [taken, setTaken] = useState<Taken[]>([])
  /**
   * The tender waiting on something the amount alone cannot supply — a deposit
   * reference, a card number.
   *
   * NOT "the tender being entered": on this pad the amount is keyed first and
   * the tender key commits it, so most payments never set this at all. It is
   * the prompt state, and only a tender that needs a reference reaches it.
   */
  const [asking, setAsking] = useState<TenderType | null>(null)
  /** The pad's live value — a decimal STRING, never a number. See NumPad. */
  const [entry, setEntry] = useState('')
  const [reference, setReference] = useState('')
  /** Voucher codes tapped onto this sale. Spent server-side, inside the transaction. */
  const [vouchers, setVouchers] = useState<string[]>([])
  /**
   * Tips a cashier has DECLARED, per tender type.
   *
   * Stored per tender type because that is all a tip row records, but the pad now
   * offers ONE box for the sale and attaches it to whichever tender is carrying the
   * excess — a cashier at a counter is answering "how much of this is a tip", not
   * "how much of the cash, and how much of the card".
   */
  const [declared, setDeclared] = useState<Record<number, number>>({})
  /**
   * Whether a manager has waived the forced service charge on this bill.
   *
   * Local until finalise, like everything else on this pad, and the shell records the
   * removal server-side with the manager's name against it.
   */
  const [serviceWaived, setServiceWaived] = useState(false)
  /** A gift-card tender waiting for its card number (147). */
  const [giftPrompt, setGiftPrompt] = useState<TenderType | null>(null)
  const [giftEntry, setGiftEntry] = useState('')
  const [giftError, setGiftError] = useState('')
  const [giftBusy, setGiftBusy] = useState(false)
  /** The checked card behind the tender being asked about — its balance caps the amount. */
  const [giftInfo, setGiftInfo] = useState<{ balance: number; display: string } | null>(null)
  /** Whether the tip box is open for typing, rather than showing its suggestions. */
  const [tipping, setTipping] = useState(false)

  /* The charge as it stands. A waiver zeroes it; nothing else can. */
  const serviceCharge = serviceWaived ? 0 : round(Math.max(0, serviceChargeProp), 2)

  // Reset between sales, so the next customer never inherits the last one's
  // half-entered payment.
  useEffect(() => {
    if (!open) return
    setTaken([])
    setAsking(null)
    setEntry('')
    setReference('')
    setVouchers([])
    /* Especially this. A declared tip carried into the next customer's sale would keep
       money they never offered — the worst thing on this screen to leave behind. */
    setDeclared({})
    setServiceWaived(false)
    setGiftPrompt(null)
    setGiftEntry('')
    setGiftError('')
    setGiftInfo(null)
    setTipping(false)
  }, [open])

  const amount = numPadValue(entry)

  /* Cash rounding applies when any tender taken — or the one being asked about —
     rounds to a denomination. Read from the tender rows rather than assumed, so
     a store that rounds card payments too gets what it configured. */
  const roundsToCash =
    taken.some((t) => tenders.find((x) => x.id === t.tenderTypeId)?.roundsToCashDenomination) ||
    (asking?.roundsToCashDenomination ?? false)

  /*
   * Rand of this basket already covered by a voucher.
   *
   * A VOUCHER IS NOT A TENDER — it reduces what is owed. Treating it as a payment would
   * ask the till to cover its value in cash as well, and every voucher sale would refuse
   * with "still to pay". This is the same order `finaliseDocument` uses: credit first,
   * then rounding, then the tender check.
   *
   * Priced from the standing the server sent, and re-priced server-side at finalise from
   * the stored row — so a client claiming a R500 voucher gets the R25 the database says
   * it is worth.
   */
  const voucherCredit = useMemo(
    () =>
      round(
        vouchers.reduce(
          (sum, code) => sum + (loyalty?.vouchers.find((v) => v.code === code)?.value ?? 0),
          0,
        ),
        2,
      ),
    [vouchers, loyalty],
  )

  /*
   * ROUND FIRST, THEN SUBTRACT THE VOUCHER — in that order, because that is the order
   * `finaliseDocument` uses.
   *
   * The two orders disagree. On a R100.02 sale with 5c rounding and a R25 voucher,
   * rounding first gives 100.00 − 25 = R75.00, while subtracting first gives
   * round(75.02) = R75.00 — the same here, but 5c apart the moment the voucher value
   * lands on an odd cent. A pad that says R75.05 while the server insists on R75.00
   * refuses a correctly-tendered sale in front of the customer.
   *
   * (The desk till's pad subtracts first. That is a latent 5c bug there, and copying it
   * here would have made it two — the whole reason this pad shares its arithmetic with
   * the engine rather than restating it.)
   */
  const { rounded: roundedTotal, adjustment } =
    roundsToCash && cashRounding > 0
      ? roundToCash(totalIncl, cashRounding)
      : { rounded: totalIncl, adjustment: 0 }

  /* Capped at the total exactly as `tenderAtFinalise` caps it on the server: the
     excess of an over-held deposit is refunded as its own event and never becomes
     a tender, so it must not come off what is owed here either. */
  const depositCredit = round(Math.min(Math.max(depositHeld, 0), Math.max(totalIncl, 0)), 2)

  /* The exchange credit comes off like a voucher: after rounding, before the
     tender check — the same order the server nets the pair of documents. The
     deposit comes off beside it, for the same reason and in the same place. */
  /*
   * ── A PAYOUT KEEPS ITS SIGN THROUGH THE CLAMP ─────────────────────────────
   *
   * A basket of empties owes the CUSTOMER money, and `Math.max(0, …)` would
   * flatten that to nothing owed — the pad would open showing 0.00, refuse
   * whatever was keyed into it, and never settle. The clamp is there to stop a
   * voucher or deposit over-crediting a sale into negative territory, which is a
   * different thing from a slip that is negative to begin with.
   *
   * So the total decides. Negative and it is a bottle return: the figure passes
   * through as the amount to hand over, and `payingOut` below turns the pad into
   * one that counts money out. Positive and every existing sale behaves exactly
   * as it did, clamp included.
   */
  const payingOut = totalIncl < 0
  const payable = payingOut
    ? round(roundedTotal - voucherCredit - (credit?.amount ?? 0) - depositCredit, 2)
    : round(
        Math.max(0, roundedTotal - voucherCredit - (credit?.amount ?? 0) - depositCredit),
        2,
      )

  /*
   * The RAW excess, computed here rather than taken from `check.change`.
   *
   * `checkTenders` and `planTips` would otherwise depend on each other: the check needs to
   * know how much of an over-tender is a tip before it decides whether the rest is an
   * error, and the plan needs the excess. Deriving the excess directly breaks the loop —
   * it is just what was handed over minus what was owed, and neither function is needed to
   * work that out.
   *
   * MEASURED bug this fixes: a R2 000 card payment on a R1 888.04 bill showed
   * "Over-tendered by 111.96, but only 0.00 can give change" at the same time as showing
   * the tip, because the check ran first, errored, and left `change` at zero — so the plan
   * had nothing to claim.
   */
  /* Never an excess on a payout: nobody over-pays a bottle return, and the
     amount is required to match exactly. Without this the whole sum handed over
     reads as excess and the pad starts offering to tip it. */
  const rawExcess = payingOut
    ? 0
    : round(
        Math.max(0, taken.reduce((sum, t) => sum + t.amount, 0) - payable),
        2,
      )

  /*
   * ── TIPS ──────────────────────────────────────────────────────────────────
   *
   * A tip and change are two claims on ONE excess, so the pad has to decide between them
   * before it can show either. `planTips` is the same function the server runs at finalise
   * — the plan here and the rows written there come from one implementation, so the slip a
   * customer is handed cannot disagree with the books.
   *
   * The declared amount is per TENDER TYPE, because that is all a tip row records: a
   * basket with two cash payments has one cash tip, not two.
   */
  const plan = useMemo(
    () =>
      planTips({
        totalExcess: rawExcess,
        tenders: taken.flatMap((t) => {
          const type = tenders.find((x) => x.id === t.tenderTypeId)
          return type
            ? [
                {
                  tenderTypeId: type.id,
                  amount: t.amount,
                  allowsChange: type.allowsChange,
                  tipOnOverTender: type.tipOnOverTender,
                  tenderName: type.name,
                },
              ]
            : []
        }),
        declared,
        serviceCharge:
          serviceCharge > 0.005 && taken[0]
            ? { tenderTypeId: taken[0].tenderTypeId, amount: serviceCharge }
            : null,
      }),
    [rawExcess, taken, tenders, declared, serviceCharge],
  )

  /* What the plan claims of the excess, for the check above. Zero on a refusal, so a
     refused plan cannot silently suppress a real change error. */
  const plannedTipsFromExcess = plan.ok
    ? round(plan.tips.filter((t) => t.source !== 'service').reduce((s2, t) => s2 + t.amount, 0), 2)
    : 0

  const check = useMemo(() => {
    // flatMap rather than map+filter: it drops unmatched entries without needing
    // a type predicate to convince TypeScript they are gone.
    const lines = taken.flatMap((t) => {
      const type = tenders.find((x) => x.id === t.tenderTypeId)
      return type ? [{ tender: type, amount: t.amount, reference: t.reference ?? null }] : []
    })
    /* The tip total is passed in, so an excess a tender legitimately keeps is not also
       reported as an unpayable change demand. */
    /* On a payout the check is asked about the MAGNITUDE, for the same reason
       `owed` is: the cashier counts out a positive amount against a positive
       figure. Handing it the negative payable would report the whole sum as an
       over-tender and demand change on money leaving the drawer. The server
       validates a payout on its own terms — see `payoutIsAllReturnables` in
       salesPosting — so this is the pad agreeing with it, not a second opinion. */
    return checkTenders(
      lines,
      payingOut ? Math.abs(payable) : payable,
      hasCustomer,
      plannedTipsFromExcess,
    )
  }, [taken, tenders, payable, payingOut, hasCustomer, plannedTipsFromExcess])

  /** Everything handed over so far, across every split. R50 card + R30 card = R80. */
  const tendered = round(
    taken.reduce((sum, t) => sum + t.amount, 0),
    2,
  )

  /*
   * What is still to hand over.
   *
   * On a payout the cashier keys the amount going OUT as a positive — "30" means
   * thirty rand across the counter, which is how they think and what the server
   * expects (`finaliseDocument` signs it negative when it writes the row). So
   * the pad counts down the MAGNITUDE: what the slip owes, less what has been
   * counted out so far. Everything else on this screen — the keypad, the split
   * rows, the settle test below — then works unchanged, because they all only
   * ever ask "is `owed` down to zero yet".
   */
  const owed = payingOut
    ? round(Math.abs(payable) - tendered, 2)
    : round(payable - tendered, 2)

  const tipTotal = plan.ok ? round(plan.tips.reduce((s, t) => s + t.amount, 0), 2) : 0
  /* What the drawer actually hands back, AFTER tips. Showing `check.change` here would
     promise a customer money the till has just kept as a gratuity. */
  const changeBack = plan.ok ? plan.changeRemaining : check.change

  /*
   * ── WHERE A DECLARED TIP ATTACHES ─────────────────────────────────────────
   *
   * One box on the screen, but a tip ROW is per tender type, so the pad has to
   * choose one. It picks the last change-giving tender taken — the one the
   * excess is physically sitting in — and falls back to the last tender of any
   * kind so the box still works on a card-only sale whose excess the card is
   * keeping anyway.
   *
   * Last rather than first: on "R100 card, R100 cash" against a R150 bill, the
   * cash is what the drawer is holding and what the cashier is counting out.
   */
  const tipTender = useMemo(() => {
    const types = taken.flatMap((t) => {
      const type = tenders.find((x) => x.id === t.tenderTypeId)
      return type ? [type] : []
    })
    return [...types].reverse().find((t) => t.allowsChange) ?? types[types.length - 1] ?? null
  }, [taken, tenders])

  /** The single declared figure on this sale, wherever it ended up attached. */
  const declaredTip = round(
    Object.values(declared).reduce((sum, value) => sum + Math.max(0, value), 0),
    2,
  )

  /**
   * Move the whole declared tip onto one tender.
   *
   * Written as a fresh record rather than a spread: the box is one figure for
   * the sale, and leaving a stale entry against a tender the cashier has since
   * removed would tip money out of a payment that is no longer on the basket.
   */
  function declare(value: number) {
    if (!tipTender) return
    const next = round(Math.max(0, value), 2)
    setDeclared(next > 0.005 ? { [tipTender.id]: next } : {})
  }

  /*
   * ── AUTOMATIC TIP ON AN OVER-TENDER ───────────────────────────────────────
   *
   * When a tender that CANNOT give change is paid over — a card with
   * `tip_on_over_tender` set — the excess is a tip by definition, and `planTips`
   * already claims it. The tip box shows that figure rather than asking, because
   * there is nothing to ask: R400 on a R344 bill paid by card is a R56 tip and
   * cannot be anything else.
   *
   * Cash is deliberately NOT auto-filled. R400 cash on a R344 bill is R56 change
   * until a person says otherwise, and pre-filling it would keep money the
   * customer is owed. That is the one place this screen must stay slow.
   */
  const autoTip = plan.ok
    ? round(
        plan.tips.filter((t) => t.source === 'over_tender').reduce((s, t) => s + t.amount, 0),
        2,
      )
    : 0

  const settled =
    taken.length > 0 && check.outstanding === 0 && check.errors.length === 0 && plan.ok

  /**
   * Take a payment on this tender for the amount currently keyed.
   *
   * The commit step, and the heart of the one-screen flow: a tender key is not
   * "choose a method", it is "take this much, on this". An empty pad means the
   * whole outstanding balance, so tapping Cash with nothing typed is the
   * single-tender sale in one touch.
   */
  function pick(tender: TenderType) {
    /* What this key would take: what was keyed, or the balance when nothing was.
       Capped for a loyalty tender at what the customer actually holds, so the pad
       never offers an amount the server is about to refuse. */
    const wanted = amount > 0 ? amount : prefillAmount(tender, owed, loyalty)
    const ceiling = loyaltyCeiling(tender, loyalty)
    const value = round(ceiling === null ? wanted : Math.min(wanted, ceiling), 2)

    // A gift card asks for the CARD first (147): the balance decides what the
    // key may take, so the amount alone cannot commit it.
    if (tender.integrationKey === 'gift_card' && onGiftCardLookup) {
      setGiftPrompt(tender)
      setGiftEntry('')
      setGiftError('')
      return
    }

    /* A reference is the other thing an amount cannot supply. The key opens a
       prompt instead of taking the money, and `confirmAsking` finishes it. */
    if (tender.requiresReference) {
      setAsking(tender)
      setReference('')
      setEntry(String(value))
      return
    }

    if (value <= 0) return
    setTaken((current) => [...current, { tenderTypeId: tender.id, amount: value, reference: null }])
    /* Cleared, so the next amount is typed against a blank pad rather than
       appended to the one just taken — the commonest way to key R5050 on a
       split. */
    setEntry('')
  }

  /** Check the scanned card and take the payment, capped at its balance. */
  async function checkGiftCard() {
    if (!giftPrompt || !onGiftCardLookup || !giftEntry.trim()) return
    setGiftBusy(true)
    const result = await onGiftCardLookup(giftEntry)
    setGiftBusy(false)
    if (!result.ok) {
      setGiftError(result.error)
      return
    }
    // Refuse the same card twice on one sale — the server would refuse it too,
    // but at finalise, with the customer's bags packed.
    if (taken.some((t) => t.reference === result.display)) {
      setGiftError(`Card ${result.display} is already on this sale.`)
      return
    }
    setAsking(giftPrompt)
    setGiftPrompt(null)
    setGiftInfo({ balance: result.balance, display: result.display })
    // The reference IS the card — the posting engine finds it there.
    setReference(result.display)
    setEntry(String(round(Math.min(result.balance, Math.max(owed, 0)), 2)))
  }

  /** Finish a payment that had to ask for a reference or a card number. */
  function confirmAsking() {
    if (!asking || amount <= 0) return
    if (asking.requiresReference && !reference.trim()) return
    if (giftInfo && amount > giftInfo.balance + 0.005) return
    setTaken((current) => [
      ...current,
      { tenderTypeId: asking.id, amount, reference: reference.trim() || null },
    ])
    setAsking(null)
    setEntry('')
    setReference('')
    setGiftInfo(null)
  }

  /** Abandon a prompt and go back to the pad. */
  function cancelAsking() {
    setAsking(null)
    setEntry('')
    setReference('')
    setGiftPrompt(null)
    setGiftError('')
    setGiftInfo(null)
  }

  /* A prompt is open — a reference or a card number is being entered — and the
     keypad below belongs to it rather than to the tender keys. */
  const prompting = asking !== null || giftPrompt !== null

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Take payment"
      size="xl"
      /*
       * The body owns its height and does its own scrolling, because the KEYPAD
       * MUST NOT SCROLL.
       *
       * Measured on a 905px screen: the figures, the chips, the tip row, the
       * amount row and the pad come to 580px against the 543px a 60vh body
       * gives, and a shop on a 768px till has 461px. Under the default cap the
       * overflow lands on whatever is last — which here is the keypad and the
       * tender keys, the two things a cashier's hands are actually on. Scrolling
       * to reach the 7 key is not a compromise a till can make.
       *
       * So the figures scroll and the keys stay pinned — which is exactly what
       * `bodyPins` gives: a body that grows to fit, caps, and lets its children
       * do the scrolling.
       *
       * NOT `bodyFills`. Measured, both ways: at 1366x768 with `bodyTall` the
       * body took 630px and pushed "Complete sale" to 800px, off the screen
       * entirely — the same bug this layout exists to fix, moved from the keypad
       * to the key that posts the sale. And at any tall viewport a fixed 70vh
       * leaves a lake of empty panel between the figures and the keys, because
       * the body is holding height its content does not want.
       */
      bodyPins
      /* A stray tap on the backdrop must not abandon a part-entered payment with
         cash already on the counter. */
      closeOnBackdrop={false}
      /*
       * The footer holds exactly ONE primary action, and which one depends on
       * where the cashier is.
       *
       * It lives here rather than in the body because Modal's body is capped at
       * 60vh and scrolls: with the figures, the pad and a button stacked inside
       * it, the button ended up under a scrollbar on a 1000px screen. The footer
       * does not scroll, so the key that advances the sale is always on screen —
       * which on a till is not a nicety.
       */
      footer={
        <>
          {/* Bordered rather than bare: in the mockup it sits beside a filled
              key, and a ghost button next to that reads as disabled. The
              glyph tracks what the key does — leaving, or stepping back. */}
          <Button
            variant="secondary"
            size="touch"
            onClick={prompting ? cancelAsking : onClose}
            disabled={pending}
          >
            {prompting ? (
              <>
                <Icons.ArrowLeft size={18} />
                Back
              </>
            ) : (
              <>
                <Icons.Close size={18} />
                Cancel
              </>
            )}
          </Button>
          {giftPrompt ? (
            <Button
              variant="primary"
              size="touch-lg"
              className="flex-1 justify-center"
              disabled={giftBusy || !giftEntry.trim()}
              onClick={checkGiftCard}
            >
              {giftBusy ? 'Checking…' : 'Check the card'}
            </Button>
          ) : asking ? (
            <Button
              variant="primary"
              size="touch-lg"
              className="flex-1 justify-center"
              disabled={
                pending ||
                amount <= 0 ||
                (asking.requiresReference && !reference.trim()) ||
                (giftInfo !== null && amount > giftInfo.balance + 0.005)
              }
              onClick={confirmAsking}
            >
              {giftInfo !== null && amount > giftInfo.balance + 0.005
                ? `Only ${formatMoney(giftInfo.balance)} on the card`
                : asking.requiresReference && !reference.trim()
                  ? `Enter the ${(asking.referenceLabel || 'reference').toLowerCase()}`
                  : `Take ${formatMoney(amount)} on ${asking.name.toLowerCase()}`}
            </Button>
          ) : (
            <Button
              variant="success"
              size="touch-lg"
              className="flex-1 justify-center"
              disabled={!settled || pending}
              onClick={() =>
                onFinalise(taken, vouchers, {
                  declared,
                  serviceChargeWaived: serviceWaived,
                })
              }
            >
              {/* The glyph tracks the SENTENCE, not the button. A tick beside
                  "R150.00 still to pay" claims the sale is done at the exact
                  moment it is not, and that is the one thing a cashier reads
                  this key for. */}
              {check.outstanding > 0 && !pending ? (
                <Icons.HandCoins size={20} />
              ) : (
                <Icons.Check size={20} />
              )}
              {pending
                ? 'Posting…'
                : check.outstanding > 0
                  ? `${formatMoney(check.outstanding)} still to pay`
                  : 'Complete sale'}
            </Button>
          )}
        </>
      }
    >
      {/*
        TWO PARTS, and only the first one scrolls.

        Everything that DESCRIBES the payment — the figures, the chips, the tip,
        a service charge, an error — is above and may scroll when a sale carries
        enough of it. Everything a cashier TOUCHES is below and never moves.
        min-h-0 is what lets the top actually shrink; without it a flex child
        refuses to go below its content and pushes the keys off the panel.

        But `flex-1 min-h-0` alone shrinks to NOTHING, and on a till it did:
        measured at 1366x768, the pinned keys took 487px of a 553px body and
        left this pane 22px to show 220px of content — the four figures, the
        payment chips and the tip row all crushed into one scrolling sliver
        with its own scrollbar, which is the screenshot this fix comes from.

        This pane KEEPS its scroll and its flex-1 — removing them was measured
        and was worse: with the pane sized to content, a two-payment sale at
        1280x720 pushed the keypad's bottom row to 754px on a 720px screen.
        Trading a scrollbar on the figures for a keypad off the bottom edge is
        not a trade a till can make.

        What it gains is a FLOOR. `flex-1 min-h-0` alone shrinks to nothing,
        and did: measured at 1366x768, the pinned keys took 487px of a 553px
        body and left this pane 22px to show 220px of content — every row
        clipped at once, which is the screenshot this fix comes from. The
        floor keeps the figures and the chips whole and puts any remaining
        squeeze on the tip row, which is the one row here that explains
        itself in a sentence rather than a number.
      */}
      <div className="flex min-h-[8.5rem] flex-1 flex-col gap-3 overflow-y-auto pr-1 short:gap-2">
        {/* ── The four figures ────────────────────────────────────────────
            Tender amount, amount due, remaining, change — the whole state of
            the payment on one line, so a cashier keying a split never has to
            work out what is left in their head.

            "Tender amount" is the sum of what has been TAKEN — R50 card plus
            R30 card reads R80 — not the digits on the pad. The strip is the
            state of the payment; the figure being keyed belongs beside the keys
            that are producing it, and NumPadDisplay puts it there. */}
        <StatStrip columns={4}>
          <StatTile
            density="compact"
            label="Tender amount"
            value={formatMoney(tendered)}
            icon={<Icons.CreditCard size={18} />}
            /* What is still on the pad, uncommitted. A cashier who has keyed 50
               but not yet hit a tender key can see both figures without either
               pretending to be the other. */
            hint={amount > 0.005 ? `${formatMoney(amount)} keyed` : undefined}
          />
          <StatTile
            density="compact"
            /* Named for the direction the money moves. "Amount due" over a
               negative figure asks the cashier to work out who owes whom from a
               minus sign, at the moment they are counting notes out of a
               drawer. The magnitude is what they are handing over. */
            label={payingOut ? 'To pay out' : 'Amount due'}
            value={formatMoney(payingOut ? Math.abs(payable) : payable)}
            icon={<Icons.Receipt size={18} />}
            /* The bill as printed, whenever the pad is asking for something else
               — a voucher, a deposit, cash rounding. Without it the cashier has
               a figure on screen that does not match the slip in their hand. */
            hint={
              round(payable, 2) !== round(totalIncl, 2)
                ? `${formatMoney(totalIncl)} on the bill`
                : undefined
            }
          />
          <StatTile
            density="compact"
            label="Remaining"
            value={formatMoney(Math.max(check.outstanding, 0))}
            icon={<Icons.HandCoins size={18} />}
            /* Coloured only while it is still owed. A zero painted warning on
               every settled sale is a warning nobody reads. */
            tone={check.outstanding > 0.005 ? 'warning' : 'default'}
          />
          <StatTile
            density="compact"
            label="Change"
            value={formatMoney(Math.max(changeBack, 0))}
            icon={<Icons.Money size={18} />}
            tone={changeBack > 0.005 ? 'success' : 'default'}
          />
        </StatStrip>

        {/*
          ── What this member is holding ──────────────────────────────────────
          Above the tender keys, so a cashier can OFFER the reward rather than wait to be
          asked for it — which is the whole commercial point of a loyalty programme and
          the thing a till usually gets wrong by burying it.

          Shown only when there is something to offer. A panel reading "0 points, no
          vouchers" on every member is noise that trains people to stop reading it.
        */}
        {loyalty &&
          (loyalty.points > 0 || loyalty.walletBalance > 0 || loyalty.vouchers.length > 0) && (
            <div className="rounded-card border border-brand/40 bg-brand-soft px-4 py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-base font-semibold text-brand">
                  {loyalty.tierName ? `${loyalty.tierName} member` : 'Loyalty member'}
                </span>
                <span className="text-sm font-medium text-brand">
                  {Math.floor(loyalty.points).toLocaleString('en-ZA')} points
                  {loyalty.pointsValue > 0 && ` · ${formatMoney(loyalty.pointsValue)}`}
                  {loyalty.walletBalance > 0 && ` · ${formatMoney(loyalty.walletBalance)} on card`}
                </span>
              </div>

              {loyalty.vouchers.length > 0 && (
                <div className="mt-2.5 flex flex-wrap gap-2">
                  {loyalty.vouchers.map((voucher) => {
                    const used = vouchers.includes(voucher.code)
                    return (
                      <Button
                        key={voucher.code}
                        variant={used ? 'ghost' : 'secondary'}
                        /* touch, not sm: this is a key a cashier hits with a finger while
                           a customer waits, and the rest of this pad is 56px. */
                        size="touch"
                        disabled={used || pending}
                        title={voucher.description}
                        onClick={() => setVouchers((current) => [...current, voucher.code])}
                      >
                        <Icons.Ticket size={18} />
                        {voucher.rewardLabel}
                        {used && <Icons.Check size={16} />}
                      </Button>
                    )
                  })}
                </div>
              )}
            </div>
          )}

        {/* What has been applied, and how to take it back off. Removable because a
            voucher tapped by mistake would otherwise have to be undone by abandoning the
            whole payment. */}
        {vouchers.length > 0 && (
          <div className="flex flex-col gap-1.5">
            {vouchers.map((code) => {
              const voucher = loyalty?.vouchers.find((v) => v.code === code)
              return (
                <div
                  key={code}
                  className="flex items-center justify-between gap-2 rounded-control border border-success/40 bg-success-soft px-3 py-2"
                >
                  <span className="min-w-0 truncate text-sm font-medium text-success-ink">
                    {voucher?.rewardLabel ?? 'Reward'}
                    <span className="numeric ml-2 text-xs opacity-80">{code}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="numeric text-sm font-bold text-success-ink">
                      −{formatMoney(voucher?.value ?? 0)}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      iconOnly
                      aria-label={`Take ${code} off this sale`}
                      disabled={pending}
                      onClick={() => setVouchers((current) => current.filter((c) => c !== code))}
                    >
                      <Icons.Close size={15} />
                    </Button>
                  </span>
                </div>
              )
            })}
          </div>
        )}

        {/* The sentence behind the "Amount due" tile, when that figure is not
            simply the bill. A cashier about to ask for less than the slip says
            needs the reason on screen before the customer queries it. */}
        {(adjustment !== 0 ||
          depositCredit > 0.005 ||
          (credit && credit.amount > 0.005)) && (
          <p className="text-sm text-muted">
            {formatMoney(totalIncl)} due
            {credit && credit.amount > 0.005 && (
              <>
                {' · '}
                {credit.label} covers {formatMoney(Math.min(credit.amount, roundedTotal))}
              </>
            )}
            {depositCredit > 0.005 && (
              <>
                {' · '}
                {formatMoney(depositCredit)} deposit already paid
              </>
            )}
            {adjustment !== 0 && (
              <>
                {' · '}rounded to {formatMoney(payable)} at the drawer (
                {adjustment > 0 ? '+' : ''}
                {formatMoney(adjustment)}); the invoice stays {formatMoney(totalIncl)}
              </>
            )}
          </p>
        )}

        {/* ── What has been taken so far ──────────────────────────────────
            Chips, directly under the figures: on a split a cashier needs to see
            the first half is in, and needs to be able to take it back off
            without abandoning the whole payment. */}
        {taken.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {taken.map((t, i) => {
              const type = tenders.find((x) => x.id === t.tenderTypeId)
              const Glyph = type ? tenderIcon(type) : Icons.Wallet
              return (
                <span
                  key={i}
                  className="inline-flex items-center gap-2 rounded-control border border-border bg-surface px-3 py-2 text-sm"
                >
                  <span aria-hidden className="text-brand">
                    <Glyph size={18} />
                  </span>
                  <span className="font-medium text-ink">{type?.name ?? 'Payment'}</span>
                  <span className="numeric font-semibold text-ink">{formatMoney(t.amount)}</span>
                  {t.reference && <span className="text-xs text-muted">{t.reference}</span>}
                  <Button
                    variant="bare"
                    size="sm"
                    iconOnly
                    aria-label={`Remove ${type?.name ?? 'payment'}`}
                    disabled={pending}
                    onClick={() => setTaken((c) => c.filter((_, j) => j !== i))}
                  >
                    <Icons.Close size={15} />
                  </Button>
                </span>
              )
            })}
          </div>
        )}

        {/* ── The service charge, and the only way out of it ────────────────
            Shown whenever one applies, waived or not: a charge a customer is going to
            query must be visible on the screen the cashier is reading from. */}
        {serviceChargeProp > 0.005 && (
          <div className="flex items-center justify-between gap-3 rounded-card border border-warning/40 bg-warning-soft px-4 py-3">
            <div>
              <p className="text-sm font-semibold text-warning-ink">
                Service charge {serviceWaived && '— removed'}
              </p>
              <p className="text-xs text-warning-ink/80">
                {serviceWaived
                  ? 'Removed from this bill. The removal is recorded.'
                  : `${formatMoney(serviceChargeProp)} on ${formatMoney(totalIncl)}`}
              </p>
            </div>
            {/*
              A waiter cannot remove it — that is the policy. Somebody holding
              sales.discount_override can, because the alternative is a bill nobody in the
              building can correct in front of a customer who has refused it. The button is
              absent rather than disabled for a waiter: a greyed control they can never use
              is a question they will keep asking.
            */}
            {canRemoveServiceCharge && !serviceWaived && (
              <Button variant="ghost" size="sm" onClick={() => setServiceWaived(true)}>
                Remove
              </Button>
            )}
            {serviceWaived && canRemoveServiceCharge && (
              <Button variant="ghost" size="sm" onClick={() => setServiceWaived(false)}>
                Put back
              </Button>
            )}
          </div>
        )}

        {/* ── The tip ──────────────────────────────────────────────────────
            One box for the sale, always present once a payment is on it, because
            a tip that has to be hunted for is a tip nobody declares. It shows
            what is already claimed automatically, and takes a figure when the
            excess is change the customer means to leave. */}
        {taken.length > 0 && !prompting && (
          <TipBox
            autoTip={autoTip}
            declaredTip={declaredTip}
            /* Cash change is the only excess a person has to rule on: an
               over-tender on a no-change tender is already a tip by its own
               setting, and `autoTip` is showing it. */
            changeAvailable={round(Math.max(check.change - declaredTip, 0), 2)}
            tenderName={tipTender?.name ?? null}
            canDeclare={tipTender !== null}
            open={tipping}
            pending={pending}
            onOpen={() => setTipping(true)}
            onDeclare={(value) => {
              declare(value)
              setTipping(false)
            }}
            onClear={() => {
              declare(0)
              setTipping(false)
            }}
          />
        )}

        {/* A refused over-tender. `planTips` returns the reason, which names the tender
            and says how to fix it — a pad that just refused to complete would leave a
            cashier guessing at a screen with no error on it. */}
        {!plan.ok && <Callout tone="danger">{plan.error}</Callout>}

        {check.errors.length > 0 && <Callout tone="danger">{check.errors.join(' ')}</Callout>}

        {giftPrompt && (
          /* The card step (147): the balance decides what the key may take,
             so the code comes before the amount. */
          <Field
            label="Gift card number"
            hint="Scan or type the card."
            error={giftError || undefined}
          >
            <Input
              autoFocus
              size="touch"
              value={giftEntry}
              placeholder="XXXX-XXXX-XXXX"
              disabled={giftBusy}
              onChange={(e) => {
                setGiftEntry(e.target.value)
                setGiftError('')
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void checkGiftCard()
              }}
            />
          </Field>
        )}

        {/* The one place a till needs letters — a card's last four digits, an
            EFT reference. The keypad below still owns the amount. */}
        {!giftPrompt && asking?.requiresReference && (
          <Field label={asking.referenceLabel || 'Reference'}>
            <Input
              autoFocus
              size="touch"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
        )}

        {!giftPrompt && giftInfo && (
          <p className="text-sm text-muted">
            Card {giftInfo.display} holds{' '}
            <span className="numeric font-semibold text-ink">
              {formatMoney(giftInfo.balance)}
            </span>
            {' — the key takes up to that.'}
          </p>
        )}
      </div>

      {/* ── The keys, pinned ─────────────────────────────────────────────
          Below the scroll, so the pad and the tender tiles are in the same
          place on every sale no matter how much the panel above is carrying. */}
      {!giftPrompt && (
        <div className="mt-3 shrink-0 border-t border-border pt-3">
            {/*
              ── Keypad LEFT, tender keys RIGHT ──────────────────────────────
              Side by side rather than one behind the other, because they are one
              gesture: key an amount, hit a method. Stacked, the keys a cashier
              alternates between would be a scroll apart.
            */}
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
              {/* Exact and the notes sit ABOVE THE PAD, in its column — they
                  fill the same figure the digits do, and stretched across the
                  full width they left a gap under the tender keys the moment a
                  settled sale had no notes left to offer. */}
              <div className="flex flex-col gap-2">
                {/* The same heading treatment the tender keys carry, so the two
                    columns start on the same line rather than one sitting a
                    heading's height above the other. */}
                <p className="text-xs font-semibold uppercase tracking-wide text-muted">
                  Quick amounts
                </p>
                <AmountRow
                  owed={owed}
                  entry={entry}
                  paid={taken.length > 0}
                  disabled={pending}
                  onEntry={setEntry}
                />
                {/* The digits, where they are being typed. The strip above now
                    reports the payment as a whole, so without this box the pad
                    would show a cashier nothing back as they key — and Exact
                    and the notes fill this same figure, so it is the one place
                    that answers "what will the next tender key take?". */}
                {/* `inline`, so the label sits INSIDE the box beside the
                    figure rather than as a caption above it — one control
                    rather than a heading and a box, which is what leaves the
                    notes above and the keys below reading as one column. */}
                <NumPadDisplay
                  layout="inline"
                  label={asking ? `${asking.name} — amount` : 'Amount to tender'}
                  value={entry}
                  placeholder="0.00"
                />
                {/* No Clear key under the pad: it cost a whole 56px row for
                    something the C key in the amount row above already does, and
                    that row is where the cashier's eye is when they mis-key. */}
                <NumPad value={entry} onChange={setEntry} disabled={pending} />
              </div>

              {asking ? (
                /* A prompt is open: the tender is already decided, so the keys
                   would only offer a second answer to a question in progress. */
                <div className="flex items-center justify-center rounded-card border border-dashed border-border bg-surface-2 px-4 py-6 text-center text-sm text-muted">
                  Enter the amount for {asking.name.toLowerCase()}, then confirm below.
                </div>
              ) : (
                <TenderKeys
                  tenders={tenders}
                  customer={customer}
                  owed={owed}
                  amount={amount}
                  loyalty={loyalty}
                  disabled={pending}
                  payingOut={payingOut}
                  onPick={pick}
                />
              )}
          </div>
        </div>
      )}
    </Modal>
  )
}

/* ── What is left, and the notes a customer hands over ───────────────────── */

/**
 * The row above the keypad: what is still owed in one tap, then the notes.
 *
 * ── THE FIRST KEY CHANGES ITS NAME ────────────────────────────────────────
 *
 * On an untouched sale it is `Exact` — the whole bill, so the next tap is the
 * tender and no digits are typed at all. Once ANY payment has been taken it
 * becomes `What's left`, showing the balance rather than the total: on an R80
 * bill with R50 cash already down, the key reads "What's left R30.00" and a
 * split is finished in one tap instead of being worked out at the counter.
 *
 * Same key, same position, same figure underneath — `owed` is already net of
 * everything taken. Only the wording moves, and only because "Exact" is a
 * misleading name for a part-paid sale.
 *
 * ── THE NOTES ARE THE NOTES ───────────────────────────────────────────────
 *
 * A FIXED list of the denominations in a South African till: 10, 20, 50, 100,
 * 200. Not `quickAmounts`, which rounds the owed figure UP to the next note and
 * so offered "R500" — a note that has not existed since 1994 and that no
 * customer can hand over. What a cashier is holding is a note, so the keys are
 * notes.
 *
 * Amounts at or below what is owed stay on the row rather than being hidden:
 * R50 against an R80 balance is a part payment, which is exactly the split this
 * pad exists to make easy.
 */
const NOTES = [10, 20, 50, 100, 200]

function AmountRow({
  owed,
  entry,
  paid,
  disabled,
  onEntry,
}: {
  owed: number
  entry: string
  /** Whether any payment has been taken — what renames the first key. */
  paid: boolean
  disabled: boolean
  onEntry: (value: string) => void
}) {
  const exact = round(Math.max(owed, 0), 2)
  /* Highlighted when the pad is holding exactly the outstanding balance — the
     cashier's confirmation that the key landed, without reading the figure. */
  const isExact = exact > 0 && numPadValue(entry) === exact

  return (
    /* Two rows of three normally; ONE row of six on a till. The keys keep
       their 56px height either way — a short screen loses a row, never a
       touch target. That row is 64px, which is most of what a 768px panel is
       short by. */
    <div className="grid grid-cols-3 gap-2 short:grid-cols-6">
      <Button
        variant={isExact ? 'primary' : 'secondary'}
        size="touch"
        /* Two lines inside one 56px key: the name, then the figure it will
           load. flex-col because Button lays its content out in a row, and
           leading-tight so both lines fit without the key growing and
           dragging the notes beside it out of line. */
        className="flex-col justify-center gap-0 leading-tight"
        disabled={disabled || exact <= 0}
        onClick={() => onEntry(exact.toFixed(2))}
      >
        <span className="text-xs font-semibold">{paid ? "What's left" : 'Exact'}</span>
        <span className="numeric text-sm font-bold">{formatMoney(exact)}</span>
      </Button>
      {/* The notes. No Clear key on this row: the pad's backspace clears a
          mis-keyed digit, and a destructive key sitting among the notes is one
          a cashier tapping quickly eventually hits by accident. */}
      {NOTES.map((value) => (
        <Button
          key={value}
          variant="ghost"
          size="touch"
          className="numeric justify-center"
          disabled={disabled}
          onClick={() => onEntry(value.toFixed(2))}
        >
          {value}
        </Button>
      ))}
    </div>
  )
}

/* ── Declaring a tip ─────────────────────────────────────────────────────── */

/**
 * The tip on this sale — one box, always in the same place.
 *
 * THREE STATES, and the difference between them is who decided:
 *
 *   AUTOMATIC   A no-change tender was paid over. `tip_on_over_tender` already
 *               settled it and `planTips` has claimed the money; the box reports
 *               the figure rather than asking about it.
 *   DECLARED    Somebody looked at the cash on the counter and said how much of
 *               it to keep. Editable, and clearable, because it is a judgement.
 *   NONE        No excess, or an excess that is still change. Offers the keys to
 *               declare one.
 *
 * Cash is never pre-filled. R400 on a R344 bill is R56 change until a person
 * says otherwise, and a box that guesses keeps money the customer is owed.
 */
function TipBox({
  autoTip,
  declaredTip,
  changeAvailable,
  tenderName,
  canDeclare,
  open,
  pending,
  onOpen,
  onDeclare,
  onClear,
}: {
  autoTip: number
  declaredTip: number
  /** Change still unclaimed — the ceiling on what may be declared. */
  changeAvailable: number
  tenderName: string | null
  canDeclare: boolean
  open: boolean
  pending: boolean
  onOpen: () => void
  onDeclare: (value: number) => void
  onClear: () => void
}) {
  const total = round(autoTip + declaredTip, 2)
  const has = total > 0.005

  return (
    <div
      /* px-3 py-2, not py-3: the row already stands 56px tall on its own keys,
         and the extra padding was pure height on a screen measured to the pixel. */
      className={`rounded-card border px-3 py-2 ${
        has ? 'border-warning/40 bg-warning-soft' : 'border-border bg-surface-2'
      }`}
    >
      {/*
        ONE ROW, not a stacked tile.
        Measured: as a medallion over a label over a figure over a caption this
        cost 94px, and the pad's body then scrolled — which put the keypad under
        a scrollbar, the one thing this screen's layout exists to prevent. The
        figure and its explanation sit on a single baseline instead.
      */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex min-w-0 items-baseline gap-2.5">
          <span className={`text-sm font-semibold ${has ? 'text-warning-ink' : 'text-ink'}`}>
            Tip
          </span>
          <span
            className={`numeric text-xl font-bold ${has ? 'text-warning-ink' : 'text-ink'}`}
          >
            {formatMoney(total)}
          </span>
          {/* Which of the three states this is, in the words a cashier would
              use to explain it to the customer standing there. */}
          <span className="min-w-0 truncate text-xs text-muted">
            {autoTip > 0.005
              ? `over-payment kept as a tip${tenderName ? ` on ${tenderName.toLowerCase()}` : ''}`
              : declaredTip > 0.005
                ? `declared${tenderName ? ` on ${tenderName.toLowerCase()}` : ''}`
                : changeAvailable > 0.005
                  ? `${formatMoney(changeAvailable)} change — any of it a tip?`
                  : 'no tip on this sale'}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* The two answers worth a single tap, off the change actually on the
              counter: keep a round amount, or keep the lot. */}
          {!open &&
            changeAvailable > 0.005 &&
            canDeclare &&
            tipSuggestions(changeAvailable).map((suggestion) => (
              <Button
                key={suggestion}
                variant="secondary"
                size="touch"
                className="numeric"
                disabled={pending}
                onClick={() => onDeclare(round(declaredTip + suggestion, 2))}
              >
                {formatMoney(suggestion)}
              </Button>
            ))}

          {open ? (
            <TipEntry
              max={round(changeAvailable + declaredTip, 2)}
              initial={declaredTip}
              pending={pending}
              onDeclare={onDeclare}
            />
          ) : (
            canDeclare && (
              <Button variant="ghost" size="touch" disabled={pending} onClick={onOpen}>
                <Icons.Pencil size={18} />
                {declaredTip > 0.005 ? 'Change' : 'Other'}
              </Button>
            )
          )}

          {declaredTip > 0.005 && !open && (
            <Button
              variant="ghost"
              size="touch"
              iconOnly
              aria-label="Clear the tip"
              disabled={pending}
              onClick={onClear}
            >
              <Icons.Close size={18} />
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * Typing an exact tip.
 *
 * Its own tiny component so the figure being typed is local: hoisting it into
 * the pad would put every keystroke of a tip through the plan and the tender
 * check, which recompute the whole payment.
 */
function TipEntry({
  max,
  initial,
  pending,
  onDeclare,
}: {
  /** The most this may be — a tip cannot exceed the excess it comes out of. */
  max: number
  initial: number
  pending: boolean
  onDeclare: (value: number) => void
}) {
  const [value, setValue] = useState(initial > 0.005 ? String(initial) : '')
  const typed = numPadValue(value)
  const over = typed > max + 0.005

  return (
    <span className="flex items-center gap-2">
      <Input
        autoFocus
        size="touch"
        inputMode="decimal"
        className="numeric w-28 text-right"
        value={value}
        aria-label="Tip amount"
        disabled={pending}
        onChange={(e) => setValue(e.target.value.replace(/[^0-9.]/g, ''))}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !over) onDeclare(typed)
        }}
      />
      <Button
        variant="primary"
        size="touch"
        disabled={pending || over}
        onClick={() => onDeclare(typed)}
      >
        {/* Named rather than a tick: at this size a bare glyph beside a figure
            reads as "clear", which is the opposite of what it does. */}
        {over ? `Max ${formatMoney(max)}` : 'Set tip'}
      </Button>
    </span>
  )
}

/* ── The tender keys ─────────────────────────────────────────────────────── */

function TenderKeys({
  tenders,
  customer,
  owed,
  amount,
  loyalty,
  disabled,
  payingOut = false,
  onPick,
}: {
  tenders: TenderType[]
  customer: TillCustomer | null
  /** What this key would have to cover, for the credit check. */
  owed: number
  /** What is currently keyed, or 0 — what the key would actually take. */
  amount: number
  /** So a loyalty key can grey itself out when the balance is zero. */
  loyalty: TillStanding | null
  disabled: boolean
  /** Money is going OUT of the drawer — a bottle return. See `payingOut`. */
  payingOut?: boolean
  onPick: (tender: TenderType) => void
}) {
  /*
   * Only methods that can actually pay out are offered on a payout.
   *
   * `allowsRefund` is the same flag the server checks — in `createCreditNote`
   * and now in `finaliseDocument` — so a key that cannot give money back is not
   * shown rather than being offered and then refused after the cashier has
   * pressed it. A shop that has turned it off for cards means it.
   */
  const active = tenders.filter((t) => t.isActive && (!payingOut || t.allowsRefund))

  return (
    <div className="flex flex-col gap-2">
      {/* Named, because the keys below stopped looking like a question once they
          became icon tiles — a grid of pictures needs a sentence saying what
          picking one does. It now also has to say what the key TAKES, which
          changes as the cashier types. */}
      <p className="text-xs font-semibold uppercase tracking-wide text-muted">
        {/* "Take" is wrong when the drawer is paying out — the cashier is
            handing money over, not collecting it. */}
        {amount > 0
          ? `${payingOut ? 'Pay out' : 'Take'} ${formatMoney(amount)} on…`
          : owed > 0
            ? `${payingOut ? 'Pay out' : 'Take'} ${formatMoney(owed)} on…`
            : payingOut
              ? 'Add another refund'
              : 'Add another payment'}
      </p>
      {/* auto-rows-fr, so a key carrying a refusal sentence does not make its
          whole row taller than the one below it — the grid reads as a keypad
          only while the keys are the same size. */}
      <div className="grid auto-rows-fr grid-cols-2 gap-2 sm:grid-cols-3">
        {active.map((tender) => {
          // Refused rather than hidden, with the reason ON the key. A tender that
          // vanishes when there is no customer leaves the cashier wondering whether
          // the store even has an account facility.
          const needsCustomer = tender.requiresCustomer && !customer
          const noBalance = loyaltyCeiling(tender, loyalty) === 0
          /*
           * The credit check, at the point of offer.
           *
           * `headroomRefusal` is the same pure function the posting engine uses, so
           * a key that is offered here will not be refused a moment later by the
           * server — which on a till means refused in front of the customer who has
           * just agreed to pay on account. It covers both a blocked account and one
           * this sale would push over its limit.
           *
           * Measured against what the key would actually TAKE, not the whole
           * outstanding balance: on a split, a R2 000 account payment against a
           * customer with R500 of headroom must refuse, but a R200 one on the same
           * basket must not.
           *
           * Still only a courtesy: finaliseDocument re-reads the balance under a
           * lock, because another till can take an order against the same account
           * while this basket sits open.
           */
          const wanted = amount > 0 ? amount : owed
          const creditRefusal =
            tender.postsToDebtor && customer
              ? headroomRefusal(customer, wanted, customer.spend)
              : null

          const refusal = needsCustomer
            ? 'Needs a customer'
            : creditRefusal
              ? creditRefusal
              : noBalance
                ? 'Nothing to redeem'
                : null

          return (
            <TenderTile
              key={tender.id}
              name={tender.name}
              icon={tenderIcon(tender)}
              refusal={refusal}
              /* Beside the keypad, not under it — at full height two rows of
                 keys pushed the pad's body into a scroll. */
              size="compact"
              /* Only when there is nothing to take: with a balance owed OR an
                 amount keyed, every key is live — including on a settled sale
                 where a cashier is adding an over-tender to leave a tip. */
              disabled={disabled || (owed <= 0 && amount <= 0)}
              onClick={() => onPick(tender)}
            />
          )
        })}
      </div>
    </div>
  )
}
