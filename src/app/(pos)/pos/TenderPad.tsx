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
import { quickAmounts, loyaltyCeiling, prefillAmount } from '@/lib/tenderOffers'
import { headroomRefusal } from '@/lib/creditRules'
import type { TenderType } from '@/lib/site/tenderTypes'
import type { TillCustomer } from '@/lib/site/tillCustomers'

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

export function TenderPad({
  open,
  onClose,
  tenders,
  totalIncl,
  cashRounding,
  customer,
  pending,
  onFinalise,
}: {
  open: boolean
  onClose: () => void
  tenders: TenderType[]
  totalIncl: number
  cashRounding: number
  /** Null for a walk-in. Non-null is what unlocks an account tender. */
  customer: TillCustomer | null
  pending: boolean
  onFinalise: (taken: Taken[]) => void
}) {
  const hasCustomer = customer !== null
  const [taken, setTaken] = useState<Taken[]>([])
  const [active, setActive] = useState<TenderType | null>(null)
  /** The pad's live value — a decimal STRING, never a number. See NumPad. */
  const [entry, setEntry] = useState('')
  const [reference, setReference] = useState('')

  // Reset between sales, so the next customer never inherits the last one's
  // half-entered payment.
  useEffect(() => {
    if (!open) return
    setTaken([])
    setActive(null)
    setEntry('')
    setReference('')
  }, [open])

  const amount = numPadValue(entry)

  /* Cash rounding applies when any tender taken — or the one being entered —
     rounds to a denomination. Read from the tender rows rather than assumed, so
     a store that rounds card payments too gets what it configured. */
  const roundsToCash =
    taken.some((t) => tenders.find((x) => x.id === t.tenderTypeId)?.roundsToCashDenomination) ||
    (active?.roundsToCashDenomination ?? false)

  const { rounded: payable, adjustment } =
    roundsToCash && cashRounding > 0
      ? roundToCash(totalIncl, cashRounding)
      : { rounded: totalIncl, adjustment: 0 }

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
  const settled = taken.length > 0 && check.outstanding === 0 && check.errors.length === 0

  function pick(tender: TenderType) {
    setActive(tender)
    setReference('')
    setEntry(String(prefillAmount(tender, owed, null)))
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
              onClick={() => onFinalise(taken)}
            >
              <Icons.Check size={20} />
              {pending ? 'Posting…' : 'Complete sale'}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {/* ── What is still owed, or what change to hand back ─────────────
            The largest thing on the screen, deliberately. It is the one figure a
            cashier reads out loud, and the one they get wrong if they have to
            hunt for it. */}
        <div
          className={`rounded-card border px-4 py-3 ${
            check.outstanding > 0
              ? 'border-border bg-surface-2'
              : check.change > 0
                ? 'border-success/40 bg-success-soft'
                : 'border-success/40 bg-success-soft'
          }`}
        >
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted">
              {check.outstanding > 0 ? 'Still to pay' : check.change > 0 ? 'Change' : 'Settled'}
            </span>
            <span
              className={`numeric text-4xl font-extrabold ${
                check.outstanding > 0 ? 'text-ink' : 'text-success-ink'
              }`}
            >
              {formatMoney(check.outstanding > 0 ? check.outstanding : check.change)}
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
          </p>
        </div>

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
  disabled,
  onPick,
}: {
  tenders: TenderType[]
  customer: TillCustomer | null
  /** What this key would have to cover, for the credit check. */
  owed: number
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
        const noBalance = loyaltyCeiling(tender, null) === 0
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
