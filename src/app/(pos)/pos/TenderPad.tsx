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
  numPadValue,
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
import { quickAmounts, loyaltyCeiling, prefillAmount } from '@/lib/tenderOffers'
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
  onFinalise: (
    taken: Taken[],
    voucherCodes: string[],
    /** Declared tips per tender type, and whether the service charge was waived. */
    tipInfo: { declared: Record<number, number>; serviceChargeWaived: boolean },
  ) => void
}) {
  const hasCustomer = customer !== null
  const [taken, setTaken] = useState<Taken[]>([])
  const [active, setActive] = useState<TenderType | null>(null)
  /** The pad's live value — a decimal STRING, never a number. See NumPad. */
  const [entry, setEntry] = useState('')
  const [reference, setReference] = useState('')
  /** Voucher codes tapped onto this sale. Spent server-side, inside the transaction. */
  const [vouchers, setVouchers] = useState<string[]>([])
  /**
   * Tips a cashier has DECLARED, per tender type.
   *
   * Only cash needs this: R100 on a R50 bill might be R50 change or R10 tip and R40
   * change, and nothing can tell which. A no-change tender's over-tender is decided by
   * its own `tipOnOverTender` flag with no prompt at all.
   */
  const [declared, setDeclared] = useState<Record<number, number>>({})
  /**
   * Whether a manager has waived the forced service charge on this bill.
   *
   * Local until finalise, like everything else on this pad, and the shell records the
   * removal server-side with the manager's name against it.
   */
  const [serviceWaived, setServiceWaived] = useState(false)

  /* The charge as it stands. A waiver zeroes it; nothing else can. */
  const serviceCharge = serviceWaived ? 0 : round(Math.max(0, serviceChargeProp), 2)

  // Reset between sales, so the next customer never inherits the last one's
  // half-entered payment.
  useEffect(() => {
    if (!open) return
    setTaken([])
    setActive(null)
    setEntry('')
    setReference('')
    setVouchers([])
    /* Especially this. A declared tip carried into the next customer's sale would keep
       money they never offered — the worst thing on this screen to leave behind. */
    setDeclared({})
    setServiceWaived(false)
  }, [open])

  const amount = numPadValue(entry)

  /* Cash rounding applies when any tender taken — or the one being entered —
     rounds to a denomination. Read from the tender rows rather than assumed, so
     a store that rounds card payments too gets what it configured. */
  const roundsToCash =
    taken.some((t) => tenders.find((x) => x.id === t.tenderTypeId)?.roundsToCashDenomination) ||
    (active?.roundsToCashDenomination ?? false)

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

  const payable = round(Math.max(0, roundedTotal - voucherCredit), 2)

  const check = useMemo(() => {
    // flatMap rather than map+filter: it drops unmatched entries without needing
    // a type predicate to convince TypeScript they are gone.
    const lines = taken.flatMap((t) => {
      const type = tenders.find((x) => x.id === t.tenderTypeId)
      return type ? [{ tender: type, amount: t.amount, reference: t.reference ?? null }] : []
    })
    return checkTenders(lines, payable, hasCustomer)
  }, [taken, tenders, payable, hasCustomer])

  const owed = round(payable - taken.reduce((sum, t) => sum + t.amount, 0), 2)

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
        totalExcess: check.change,
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
    [check.change, taken, tenders, declared, serviceCharge],
  )

  const tipTotal = plan.ok ? round(plan.tips.reduce((s, t) => s + t.amount, 0), 2) : 0
  /* What the drawer actually hands back, AFTER tips. Showing `check.change` here would
     promise a customer money the till has just kept as a gratuity. */
  const changeBack = plan.ok ? plan.changeRemaining : check.change

  /*
   * Which tenders on this sale can take a DECLARED tip.
   *
   * Only ones that give change — a card over-tender is handled automatically by its own
   * flag, so offering a declare box for it as well would be two ways to say one thing.
   */
  const declarable = taken.flatMap((t) => {
    const type = tenders.find((x) => x.id === t.tenderTypeId)
    return type && type.allowsChange ? [type] : []
  })

  const settled =
    taken.length > 0 && check.outstanding === 0 && check.errors.length === 0 && plan.ok

  function pick(tender: TenderType) {
    setActive(tender)
    setReference('')
    setEntry(String(prefillAmount(tender, owed, loyalty)))
  }

  function commit() {
    if (!active || amount <= 0) return
    if (active.requiresReference && !reference.trim()) return
    setTaken((current) => [
      ...current,
      { tenderTypeId: active.id, amount, reference: reference.trim() || null },
    ])
    setActive(null)
    setEntry('')
    setReference('')
  }

  /** Abandon the amount being entered and go back to the tender keys. */
  function onBackToKeys() {
    setActive(null)
    setEntry('')
    setReference('')
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Take payment"
      size="lg"
      /* A stray tap on the backdrop must not abandon a part-entered payment with
         cash already on the counter. */
      closeOnBackdrop={false}
      /*
       * The footer holds exactly ONE primary action, and which one depends on
       * where the cashier is.
       *
       * It lives here rather than in the body because Modal's body is capped at
       * 60vh and scrolls: with the display, the pad and a button stacked inside
       * it, the button ended up under a scrollbar on a 1000px screen. The footer
       * does not scroll, so the key that advances the sale is always on screen —
       * which on a till is not a nicety.
       *
       * One at a time, too. A green "Complete sale" beside "Take R22.00" is two
       * primary keys, and the cashier reaches for the green one, which at that
       * moment does nothing.
       */
      footer={
        <>
          <Button
            variant="ghost"
            size="touch"
            onClick={active ? onBackToKeys : onClose}
            disabled={pending}
          >
            {active ? 'Back' : 'Cancel'}
          </Button>
          {active ? (
            <Button
              variant="primary"
              size="touch-lg"
              className="flex-1 justify-center"
              disabled={pending || amount <= 0 || (active.requiresReference && !reference.trim())}
              onClick={commit}
            >
              {active.requiresReference && !reference.trim()
                ? `Enter the ${(active.referenceLabel || 'reference').toLowerCase()}`
                : round(owed - amount, 2) > 0
                  ? `Take ${formatMoney(amount)} — ${formatMoney(round(owed - amount, 2))} left`
                  : `Take ${formatMoney(amount)}`}
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
              <Icons.Check size={20} />
              {pending ? 'Posting…' : 'Complete sale'}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3">
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

        {/* ── What is still owed, or what change to hand back ─────────────
            The largest thing on the screen, deliberately. It is the one figure a
            cashier reads out loud, and the one they get wrong if they have to
            hunt for it. */}
        <div
          className={`rounded-card border px-4 py-3 ${
            check.outstanding > 0
              ? 'border-border bg-surface-2'
              : changeBack > 0
                ? 'border-success/40 bg-success-soft'
                : 'border-success/40 bg-success-soft'
          }`}
        >
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted">
              {check.outstanding > 0 ? 'Still to pay' : changeBack > 0 ? 'Change' : 'Settled'}
            </span>
            <span
              className={`numeric text-4xl font-extrabold ${
                check.outstanding > 0 ? 'text-ink' : 'text-success-ink'
              }`}
            >
              {formatMoney(check.outstanding > 0 ? check.outstanding : changeBack)}
            </span>
          </div>
          <p className="mt-0.5 text-xs text-muted">
            {formatMoney(totalIncl)} due
            {adjustment !== 0 && (
              <>
                {' · '}rounded to {formatMoney(payable)} at the drawer (
                {adjustment > 0 ? '+' : ''}
                {formatMoney(adjustment)}); the invoice stays {formatMoney(totalIncl)}
              </>
            )}
            {/* Named right under the change figure, because the two come out of one
                excess and a cashier handing back money needs to see both at once. */}
            {tipTotal > 0.005 && (
              <>
                {' · '}
                <span className="text-warning-ink">
                  {formatMoney(tipTotal)} kept as a tip
                </span>
              </>
            )}
          </p>
        </div>

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

        {/* ── Declaring a cash tip ──────────────────────────────────────────
            Only for tenders that give change, and only once there is an excess to split.
            A no-change tender's over-tender is decided by its own flag with no prompt, so
            offering a box for it as well would be two ways to say one thing. */}
        {check.change > 0.005 &&
          declarable.map((type) => (
            <div
              key={type.id}
              className="flex items-center justify-between gap-3 rounded-card border border-border bg-surface-2 px-4 py-3"
            >
              <div>
                <p className="text-sm font-medium text-ink">
                  Is any of the {type.name.toLowerCase()} change a tip?
                </p>
                <p className="text-xs text-muted">
                  {formatMoney(check.change)} over. Tap an amount, or leave it as change.
                </p>
              </div>
              <div className="flex items-center gap-1">
                {/* Whole-rand steps off the excess itself, so the common answers
                    ("keep the R5", "keep it all") are one tap rather than six keys. */}
                {tipSuggestions(check.change).map((suggestion) => {
                  const chosen = round(declared[type.id] ?? 0, 2) === suggestion
                  return (
                    <Button
                      key={suggestion}
                      variant={chosen ? 'primary' : 'secondary'}
                      size="sm"
                      onClick={() =>
                        setDeclared((current) => ({
                          ...current,
                          [type.id]: chosen ? 0 : suggestion,
                        }))
                      }
                    >
                      {formatMoney(suggestion)}
                    </Button>
                  )
                })}
              </div>
            </div>
          ))}

        {/* A refused over-tender. `planTips` returns the reason, which names the tender
            and says how to fix it — a pad that just refused to complete would leave a
            cashier guessing at a screen with no error on it. */}
        {!plan.ok && <Callout tone="danger">{plan.error}</Callout>}

        {check.errors.length > 0 && (
          <Callout tone="danger">{check.errors.join(' ')}</Callout>
        )}

        {/* ── What has been taken so far ──────────────────────────────────
            Only once there is something, and only as a strip: on a split payment
            a cashier needs to see the first half is in, but it is not what they
            are looking at while entering the second. */}
        {taken.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {taken.map((t, i) => {
              const type = tenders.find((x) => x.id === t.tenderTypeId)
              return (
                <span
                  key={i}
                  className="inline-flex items-center gap-2 rounded-control border border-border bg-surface px-3 py-1.5 text-[13px]"
                >
                  <span className="font-medium text-ink">{type?.name ?? 'Payment'}</span>
                  <span className="numeric text-ink-2">{formatMoney(t.amount)}</span>
                  <Button
                    variant="bare"
                    size="sm"
                    iconOnly
                    aria-label={`Remove ${type?.name ?? 'payment'}`}
                    disabled={pending}
                    onClick={() => setTaken((c) => c.filter((_, j) => j !== i))}
                  >
                    <Icons.Close size={14} />
                  </Button>
                </span>
              )
            })}
          </div>
        )}

        {active ? (
          <ActiveTender
            tender={active}
            entry={entry}
            reference={reference}
            owed={owed}
            pending={pending}
            onEntry={setEntry}
            onReference={setReference}
          />
        ) : (
          <TenderKeys
            tenders={tenders}
            customer={customer}
            owed={owed}
            loyalty={loyalty}
            disabled={pending || owed <= 0}
            onPick={pick}
          />
        )}
      </div>
    </Modal>
  )
}

/* ── The tender keys ─────────────────────────────────────────────────────── */

function TenderKeys({
  tenders,
  customer,
  owed,
  loyalty,
  disabled,
  onPick,
}: {
  tenders: TenderType[]
  customer: TillCustomer | null
  /** What this key would have to cover, for the credit check. */
  owed: number
  /** So a loyalty key can grey itself out when the balance is zero. */
  loyalty: TillStanding | null
  disabled: boolean
  onPick: (tender: TenderType) => void
}) {
  const active = tenders.filter((t) => t.isActive)

  return (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
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
         * Still only a courtesy: finaliseDocument re-reads the balance under a
         * lock, because another till can take an order against the same account
         * while this basket sits open.
         */
        const creditRefusal =
          tender.postsToDebtor && customer ? headroomRefusal(customer, owed) : null

        const refusal = needsCustomer
          ? 'Needs a customer'
          : creditRefusal
            ? creditRefusal
            : noBalance
              ? 'Nothing to redeem'
              : null

        return (
          <Button
            key={tender.id}
            variant={refusal ? 'ghost' : 'secondary'}
            size="touch-lg"
            /* whitespace-normal because a credit refusal is a sentence — "Acme
               would be 240.00 over their 5000.00 limit." — and Button's default
               whitespace-nowrap would run it off the key. h-auto for the same
               reason: the key grows to fit its reason rather than clipping it. */
            className="h-auto min-h-touch-lg flex-col gap-0.5 whitespace-normal py-2 text-center"
            disabled={disabled || refusal !== null}
            onClick={() => onPick(tender)}
          >
            <span className="text-base font-semibold">{tender.name}</span>
            {refusal && <span className="text-[11px] font-normal leading-tight">{refusal}</span>}
          </Button>
        )
      })}
    </div>
  )
}

/* ── Entering an amount against one tender ───────────────────────────────── */

/**
 * The amount side of one tender.
 *
 * Holds no primary button of its own — the footer owns that, because the footer
 * does not scroll and the body does. See the note on Modal's footer above.
 */
function ActiveTender({
  tender,
  entry,
  reference,
  owed,
  pending,
  onEntry,
  onReference,
}: {
  tender: TenderType
  entry: string
  reference: string
  owed: number
  pending: boolean
  onEntry: (value: string) => void
  onReference: (value: string) => void
}) {
  return (
    <div className="flex flex-col gap-3">
      <NumPadDisplay label={`${tender.name} — amount handed over`} value={entry} />

      {/* The one place a till needs letters — a card's last four digits, an EFT
          reference. The numeric pad below owns the amount. */}
      {tender.requiresReference && (
        <Field label={tender.referenceLabel || 'Reference'}>
          <Input
            size="touch"
            value={reference}
            onChange={(e) => onReference(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
      )}

      {/*
       * Pad and notes SIDE BY SIDE, not stacked.
       *
       * Stacked, this ran past the modal's 60vh body and put the 0 key below a
       * scrollbar. Scrolling to reach a digit is not a compromise a till can
       * make — the keys have to be where the thumb expects them, every time.
       */}
      <div className="flex gap-3">
        <div className="min-w-0 flex-1">
          <NumPad value={entry} onChange={onEntry} disabled={pending} />
        </div>

        {/* The exact amount, then the next round note up — so a cashier handed a
            R200 note on an R87.50 sale taps once rather than typing 200, and the
            change is computed rather than worked out in their head with a queue
            waiting.

            FOUR of them, matching the pad's four rows: a fifth made this column
            taller than the pad and reintroduced the scrollbar. quickAmounts trims
            from the largest, which are the least likely to be handed over. */}
        {tender.countsAsDrawerCash && (
          <div className="flex w-[128px] shrink-0 flex-col gap-2">
            {quickAmounts(owed, 4).map((value) => (
              <Button
                key={value}
                variant="ghost"
                size="touch"
                className="numeric"
                disabled={pending}
                onClick={() => onEntry(value.toFixed(2))}
              >
                {formatMoney(value)}
              </Button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
