'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  Button,
  Callout,
  CurrencyInput,
  Field,
  Icons,
  Input,
  Modal,
} from '@/components/ui'
import { formatMoney, round } from '@/lib/decimals'
import { roundToCash } from '@/lib/documentMath'
// From the PURE module, not site/tenderTypes — that one is server-only, and a
// Client Component importing it drags the database driver into the browser
// bundle. Same reasoning as documentMath.
import { checkTenders } from '@/lib/tenderMath'
import { quickAmounts, loyaltyCeiling } from '@/lib/tenderOffers'
import { headroomRefusal } from '@/lib/creditRules'
import type { TenderType } from '@/lib/site/tenderTypes'
import type { TillCustomer } from '@/lib/site/tillCustomers'

/**
 * Taking payment.
 *
 * The buttons are whatever tender types the store configured — four for a
 * spaza, ten for a franchise with card, Yoco and a loyalty wallet. Nothing here
 * knows what "cash" is; it reads the behaviour flags and acts on them.
 *
 * TWO RULES this screen exists to get right:
 *
 *   1. A tender records what was HANDED OVER, not what was owed. R100 on an
 *      R87.50 sale is a R100 tender with R12.50 change. Storing the net leaves
 *      the drawer short at every cash-up with nothing to explain it.
 *
 *   2. Cash rounding applies to what the drawer takes, never to the invoice.
 *      The invoice keeps its exact total so the VAT declared stays exact.
 */

type Taken = { tenderTypeId: number; amount: number; reference?: string | null }

/**
 * What this customer is holding, as the till sees it.
 *
 * Fetched when the customer is attached, so the cashier can say "you have R124
 * in points" before the customer asks. Every figure is re-checked by the
 * posting engine under a lock at finalise — this is what to OFFER, never what
 * to trust.
 */
export type LoyaltyStanding = {
  points: number
  pointsValue: number
  /** The most of a sale points may settle, already capped by the minimum. */
  maxRedeemable: number
  walletBalance: number
  tierName: string
  vouchers: { code: string; description: string; rewardLabel: string; value: number }[]
}

export default function TenderPad({
  open,
  onClose,
  tenders,
  totalIncl,
  cashRounding,
  customer,
  loyalty = null,
  pending,
  onFinalise,
}: {
  open: boolean
  onClose: () => void
  tenders: TenderType[]
  totalIncl: number
  cashRounding: number
  /** Null for a walk-in. Non-null unlocks the account tender, subject to credit. */
  customer: TillCustomer | null
  /**
   * Null when the programme is off, or the customer is a walk-in.
   *
   * Optional so the back-office invoicing editor — which posts through the same
   * pad but has no till session to read a balance with — needs no change. Omit
   * it and the loyalty panel and tenders simply do not appear.
   */
  loyalty?: LoyaltyStanding | null
  pending: boolean
  onFinalise: (taken: Taken[], voucherCodes: string[]) => void
}) {
  const hasCustomer = customer !== null
  const [taken, setTaken] = useState<Taken[]>([])
  const [active, setActive] = useState<TenderType | null>(null)
  const [amount, setAmount] = useState(0)
  const [reference, setReference] = useState('')
  const [vouchers, setVouchers] = useState<string[]>([])
  const [voucherCode, setVoucherCode] = useState('')
  const [voucherError, setVoucherError] = useState<string | null>(null)

  // Reset between sales, so the next customer never inherits the last one's
  // half-entered payment.
  useEffect(() => {
    if (open) {
      setTaken([])
      setActive(null)
      setAmount(0)
      setReference('')
      setVouchers([])
      setVoucherCode('')
      setVoucherError(null)
    }
  }, [open])

  /* Rand of the basket already covered by a scanned voucher. A voucher is not a
     tender — it REDUCES what is owed — so it comes off the payable figure the
     tender arithmetic works against, exactly as the posting engine does it. */
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

  function addVoucher() {
    const code = voucherCode.trim().toUpperCase()
    if (!code) return

    const match = loyalty?.vouchers.find((v) => v.code === code)
    if (!match) {
      setVoucherError('No reward with that code on this account.')
      return
    }
    if (vouchers.includes(code)) {
      setVoucherError('That reward is already on this sale.')
      return
    }
    setVouchers((current) => [...current, code])
    setVoucherCode('')
    setVoucherError(null)
  }

  /* What the drawer actually asks for, once cash rounding is applied. The
     invoice total is untouched — only this figure moves. */
  const roundsToCash = taken.some(
    (t) => tenders.find((x) => x.id === t.tenderTypeId)?.roundsToCashDenomination,
  )
  const activeRounds = active?.roundsToCashDenomination ?? false
  const afterVouchers = round(Math.max(0, totalIncl - voucherCredit), 2)
  const { rounded: payable, adjustment } =
    (roundsToCash || activeRounds) && cashRounding > 0
      ? roundToCash(afterVouchers, cashRounding)
      : { rounded: afterVouchers, adjustment: 0 }

  const check = useMemo(() => {
    // flatMap rather than map+filter: it drops the unmatched entries without
    // needing a type predicate to convince TypeScript they are gone.
    const lines = taken.flatMap((t) => {
      const type = tenders.find((x) => x.id === t.tenderTypeId)
      return type ? [{ tender: type, amount: t.amount, reference: t.reference ?? null }] : []
    })
    return checkTenders(lines, payable, hasCustomer)
  }, [taken, tenders, payable, hasCustomer])

  const outstanding = check.outstanding
  const settled = taken.length > 0 && outstanding === 0 && check.errors.length === 0

  function pick(tender: TenderType) {
    setActive(tender)
    setReference('')
    // Pre-fill with what is still owed: the overwhelmingly common case is one
    // tender for the whole sale, and typing the total again is wasted keystrokes.
    const owed = round(payable - taken.reduce((sum, t) => sum + t.amount, 0), 2)

    // A loyalty tender is capped by what the customer actually holds, so the
    // pre-fill offers the smaller of the two rather than an amount the posting
    // engine is going to refuse.
    const ceiling = loyaltyCeiling(tender, loyalty)
    setAmount(Math.max(ceiling === null ? owed : Math.min(owed, ceiling), 0))
  }

  function add() {
    if (!active || amount <= 0) return
    setTaken((current) => [
      ...current,
      { tenderTypeId: active.id, amount, reference: reference.trim() || null },
    ])
    setActive(null)
    setAmount(0)
    setReference('')
  }

  const owedNow = round(payable - taken.reduce((sum, t) => sum + t.amount, 0), 2)

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Take payment"
      description={`${formatMoney(totalIncl)} due`}
      size="md"
      closeOnBackdrop={false}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="success"
            disabled={!settled || pending}
            onClick={() => onFinalise(taken, vouchers)}
          >
            <Icons.Check size={16} />
            {pending ? 'Posting…' : 'Finalise sale'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {/* Running position */}
        <div className="rounded-card bg-surface-2 px-4 py-3">
          <div className="flex items-baseline justify-between">
            <span className="text-sm text-muted">
              {outstanding > 0 ? 'Still to pay' : check.change > 0 ? 'Change due' : 'Settled'}
            </span>
            <span
              className={`numeric text-2xl font-semibold ${
                outstanding > 0 ? 'text-ink' : check.change > 0 ? 'text-success' : 'text-success'
              }`}
            >
              {formatMoney(outstanding > 0 ? outstanding : check.change)}
            </span>
          </div>
          {adjustment !== 0 && (
            <p className="mt-1 text-xs text-muted">
              Rounded to {formatMoney(payable)} at the drawer ({adjustment > 0 ? '+' : ''}
              {formatMoney(adjustment)}). The invoice stays {formatMoney(totalIncl)}.
            </p>
          )}
        </div>

        {/* What this customer is holding. Shown before the tender keys so the
            cashier can offer the reward rather than wait to be asked for it. */}
        {loyalty && (loyalty.points > 0 || loyalty.walletBalance > 0 || loyalty.vouchers.length > 0) && (
          <div className="rounded-card border border-border px-4 py-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-sm font-medium text-ink">
                {loyalty.tierName ? `${loyalty.tierName} member` : 'Loyalty member'}
              </span>
              <span className="text-sm text-muted">
                {Math.floor(loyalty.points).toLocaleString()} points
                {loyalty.pointsValue > 0 && ` · ${formatMoney(loyalty.pointsValue)}`}
                {loyalty.walletBalance > 0 && ` · ${formatMoney(loyalty.walletBalance)} on card`}
              </span>
            </div>

            {loyalty.vouchers.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {loyalty.vouchers.map((voucher) => {
                  const used = vouchers.includes(voucher.code)
                  return (
                    <Button
                      key={voucher.code}
                      variant={used ? 'ghost' : 'secondary'}
                      size="sm"
                      disabled={used || pending}
                      onClick={() => {
                        setVouchers((current) => [...current, voucher.code])
                        setVoucherError(null)
                      }}
                      title={voucher.description}
                    >
                      <Icons.Ticket size={14} />
                      {voucher.rewardLabel}
                      {used && ' ✓'}
                    </Button>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* Rewards applied to this sale */}
        {vouchers.length > 0 && (
          <div className="flex flex-col gap-1.5">
            {vouchers.map((code) => {
              const voucher = loyalty?.vouchers.find((v) => v.code === code)
              return (
                <div
                  key={code}
                  className="flex items-center justify-between rounded-control border border-border px-3 py-2 text-sm"
                >
                  <span className="text-ink">
                    Reward <span className="numeric">{code}</span>
                    {voucher?.description && (
                      <span className="ml-2 text-xs text-muted">{voucher.description}</span>
                    )}
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="numeric text-success">
                      −{formatMoney(voucher?.value ?? 0)}
                    </span>
                    <Button
                      variant="bare"
                      size="sm"
                      iconOnly
                      aria-label="Take this reward off the sale"
                      onClick={() => setVouchers((c) => c.filter((v) => v !== code))}
                    >
                      <Icons.Close size={14} />
                    </Button>
                  </span>
                </div>
              )
            })}
          </div>
        )}

        {/* What has been taken so far */}
        {taken.length > 0 && (
          <div className="flex flex-col gap-1.5">
            {taken.map((t, index) => {
              const type = tenders.find((x) => x.id === t.tenderTypeId)
              return (
                <div
                  key={index}
                  className="flex items-center justify-between rounded-control border border-border px-3 py-2 text-sm"
                >
                  <span className="text-ink">
                    {type?.name}
                    {t.reference && <span className="ml-2 text-xs text-muted">{t.reference}</span>}
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="numeric text-ink-2">{formatMoney(t.amount)}</span>
                    <Button
                      variant="bare"
                      size="sm"
                      iconOnly
                      aria-label="Remove this payment"
                      onClick={() => setTaken((c) => c.filter((_, i) => i !== index))}
                    >
                      <Icons.Close size={14} />
                    </Button>
                  </span>
                </div>
              )
            })}
          </div>
        )}

        {check.errors.length > 0 && <Callout tone="danger">{check.errors[0]}</Callout>}

        {/* Tender buttons, or the amount entry for the one just picked */}
        {active ? (
          <div className="flex flex-col gap-3 rounded-card border border-border p-4">
            <div className="flex items-center justify-between">
              <span className="font-medium text-ink">{active.name}</span>
              <Button variant="bare" size="sm" onClick={() => setActive(null)}>
                Change
              </Button>
            </div>

            <Field
              label="Amount"
              hint={
                loyaltyCeiling(active, loyalty) !== null
                  ? `At most ${formatMoney(loyaltyCeiling(active, loyalty) ?? 0)} available.`
                  : active.allowsChange
                    ? 'What the customer handed over.'
                    : undefined
              }
            >
              <CurrencyInput
                value={amount}
                autoFocus
                onChange={(e) => setAmount(Number(String(e.target.value).replace(',', '.')) || 0)}
              />
            </Field>

            {active.allowsChange && (
              <div className="flex flex-wrap gap-1.5">
                {quickAmounts(owedNow).map((value) => (
                  <Button key={value} variant="ghost" size="sm" onClick={() => setAmount(value)}>
                    {formatMoney(value)}
                  </Button>
                ))}
              </div>
            )}

            {active.requiresReference && (
              <Field label={active.referenceLabel ?? 'Reference'}>
                <Input value={reference} onChange={(e) => setReference(e.target.value)} />
              </Field>
            )}

            {(() => {
              const ceiling = loyaltyCeiling(active, loyalty)
              return ceiling !== null && amount > ceiling ? (
                <Callout tone="danger">
                  Only {formatMoney(ceiling)} is available on this account.
                </Callout>
              ) : null
            })()}

            <Button
              variant="primary"
              onClick={add}
              disabled={amount <= 0 || amount > (loyaltyCeiling(active, loyalty) ?? Infinity)}
            >
              Add {formatMoney(amount)}
            </Button>
          </div>
        ) : (
          /* Taller-than-control tender keys, on purpose: this grid is hit in a
             hurry with a customer waiting, and the second line carries the
             refusal. Layout only — the Button skin is untouched. */
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {tenders.map((tender) => {
              const refusal = tenderRefusal(tender, customer, owedNow, loyalty)
              return (
                <Button
                  key={tender.id}
                  variant="secondary"
                  disabled={
                    refusal !== null || pending || (outstanding === 0 && taken.length > 0)
                  }
                  onClick={() => pick(tender)}
                  className="h-16 flex-col gap-1"
                  title={refusal ?? undefined}
                >
                  <span>{tender.name}</span>
                  {refusal && <span className="text-[11px] text-muted">{shortReason(refusal)}</span>}
                </Button>
              )
            })}
          </div>
        )}
      </div>
    </Modal>
  )
}

/**
 * Why this tender cannot be used for this amount. Null means it can.
 *
 * The account case runs the SAME rules the posting engine will apply at
 * finalise — from lib/creditRules.ts, so the button and the refusal can never
 * disagree. Better to grey it out with a reason than to let the cashier get all
 * the way to Finalise and be told no in front of the customer.
 */
/**
 * The most a loyalty tender may take, or null if it is not one.
 *
 * Points are capped by `maxRedeemable` (already through the redemption rate and
 * the minimum), wallet rand by the balance. The server re-checks both under a
 * lock; this only keeps the till from offering what will be refused.
 */
/* loyaltyCeiling and quickAmounts moved to @/lib/tenderOffers when the touch till
   gained its own pad. Two copies of "how much may this tender take" and "which
   notes would a cashier be handed" is two places for them to drift, and the shared
   module is pure so a test exercises it with no database. */

function tenderRefusal(
  tender: TenderType,
  customer: TillCustomer | null,
  amount: number,
  loyalty: LoyaltyStanding | null,
): string | null {
  if (tender.requiresCustomer && !customer) return 'Needs a customer account.'

  const ceiling = loyaltyCeiling(tender, loyalty)
  if (ceiling !== null && ceiling <= 0) {
    return tender.code === 'LOYALTY_WALLET'
      ? 'Nothing loaded on this card.'
      : 'Not enough points to spend.'
  }

  if (tender.postsToDebtor && customer) {
    return headroomRefusal(
      {
        name: customer.name,
        status: customer.status,
        accountType: customer.accountType,
        creditLimit: customer.creditLimit,
        balance: customer.balance,
      },
      amount,
    )
  }
  return null
}

/** The refusal, short enough for a button face. The full sentence is the title. */
function shortReason(reason: string): string {
  if (reason.includes('on hold')) return 'On hold'
  if (reason.includes('cash-only')) return 'Cash only'
  if (reason.includes('no credit limit')) return 'No credit'
  if (reason.includes('over their')) return 'Over limit'
  if (reason.includes('Needs a customer')) return 'Needs account'
  if (reason.includes('Nothing loaded')) return 'Card empty'
  if (reason.includes('Not enough points')) return 'No points'
  return 'Unavailable'
}

/* quickAmounts is now @/lib/tenderOffers — see the note where loyaltyCeiling used
   to be. */
