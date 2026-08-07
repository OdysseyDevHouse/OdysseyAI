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

export default function TenderPad({
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
  /** Null for a walk-in. Non-null unlocks the account tender, subject to credit. */
  customer: TillCustomer | null
  pending: boolean
  onFinalise: (taken: Taken[]) => void
}) {
  const hasCustomer = customer !== null
  const [taken, setTaken] = useState<Taken[]>([])
  const [active, setActive] = useState<TenderType | null>(null)
  const [amount, setAmount] = useState(0)
  const [reference, setReference] = useState('')

  // Reset between sales, so the next customer never inherits the last one's
  // half-entered payment.
  useEffect(() => {
    if (open) {
      setTaken([])
      setActive(null)
      setAmount(0)
      setReference('')
    }
  }, [open])

  /* What the drawer actually asks for, once cash rounding is applied. The
     invoice total is untouched — only this figure moves. */
  const roundsToCash = taken.some(
    (t) => tenders.find((x) => x.id === t.tenderTypeId)?.roundsToCashDenomination,
  )
  const activeRounds = active?.roundsToCashDenomination ?? false
  const { rounded: payable, adjustment } =
    (roundsToCash || activeRounds) && cashRounding > 0
      ? roundToCash(totalIncl, cashRounding)
      : { rounded: totalIncl, adjustment: 0 }

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
    setAmount(Math.max(owed, 0))
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
            onClick={() => onFinalise(taken)}
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

            <Field label="Amount" hint={active.allowsChange ? 'What the customer handed over.' : undefined}>
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

            <Button variant="primary" onClick={add} disabled={amount <= 0}>
              Add {formatMoney(amount)}
            </Button>
          </div>
        ) : (
          /* Taller-than-control tender keys, on purpose: this grid is hit in a
             hurry with a customer waiting, and the second line carries the
             refusal. Layout only — the Button skin is untouched. */
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {tenders.map((tender) => {
              const refusal = tenderRefusal(tender, customer, owedNow)
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
function tenderRefusal(
  tender: TenderType,
  customer: TillCustomer | null,
  amount: number,
): string | null {
  if (tender.requiresCustomer && !customer) return 'Needs a customer account.'

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
  return 'Unavailable'
}

/**
 * The notes a cashier is most likely to be handed.
 *
 * The exact amount first, then the next few round figures above it — which is
 * how someone pays R87.50 with a hundred.
 */
function quickAmounts(owed: number): number[] {
  if (owed <= 0) return []
  const notes = [20, 50, 100, 200, 500]
  const options = new Set<number>([round(owed, 2)])

  for (const note of notes) {
    const rounded = Math.ceil(owed / note) * note
    if (rounded >= owed) options.add(rounded)
  }

  return [...options].sort((a, b) => a - b).slice(0, 5)
}
