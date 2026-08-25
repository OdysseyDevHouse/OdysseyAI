'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  Modal,
  Button,
  Field,
  Input,
  CurrencyInput,
  Callout,
  Icons,
  MeterBar,
  SummaryList,
  SummaryRow,
  SummaryTotal,
  useToast,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import { takeRefusal, stillToPay, percentHeld } from '@/lib/depositRules'
import type { TenderType } from '@/lib/site/tenderTypes'
import { takeDepositAction } from './depositActions'

/**
 * Taking money up front against the basket on screen.
 *
 * ── WHAT THIS IS FOR ──────────────────────────────────────────────────────
 *
 * A customer orders something that is not going home today — a kitchen, a
 * special order, a repair — and puts money down to secure it. The basket stays
 * open, the money is in the drawer, and the sale posts when the goods arrive.
 *
 * ── IT IS NOT AN ACCOUNT PAYMENT ──────────────────────────────────────────
 *
 * `AccountPaymentModal` puts money against a customer's ACCOUNT and needs a
 * debtor to exist. This holds money against the DOCUMENT, so a walk-in can pay
 * a deposit with no account anywhere in the system. The two read the same at the
 * counter and are different events underneath.
 *
 * ── WHY THE REFUSAL IS COMPUTED HERE TOO ──────────────────────────────────
 *
 * `takeRefusal` is the same pure function the server runs. Running it on the
 * button as well means the cashier is told what is wrong while they can still
 * fix it, rather than after a round trip with a customer watching. The server
 * check is the real one; this is just courtesy.
 */
export function DepositModal({
  open,
  documentId,
  status,
  totalIncl,
  heldTotal,
  hasCustomer,
  minPct,
  allowWalkin,
  tenders,
  terminalId,
  online,
  onClose,
  onTaken,
}: {
  open: boolean
  /** The draft this basket has been saved as. Null when nothing is saved yet. */
  documentId: number | null
  status: string
  totalIncl: number
  /** What is already held against this document. */
  heldTotal: number
  hasCustomer: boolean
  minPct: number
  allowWalkin: boolean
  tenders: TenderType[]
  terminalId: number | null
  /**
   * Whether the server can be reached.
   *
   * Deposits need it. A basket parked offline exists only as a uid on this till
   * and never syncs, so money attached to one would have no server record at
   * all — a reconciliation hole rather than a feature. Said plainly instead of
   * failing at the end.
   */
  online: boolean
  onClose: () => void
  onTaken: (held: number, stillToPay: number) => void
}) {
  const toast = useToast()

  const [amount, setAmount] = useState(0)
  const [tenderTypeId, setTenderTypeId] = useState<number | null>(null)
  const [reference, setReference] = useState('')
  const [busy, setBusy] = useState(false)

  const options = useMemo(() => depositTenders(tenders), [tenders])

  /* Everything resets on open. A dialog remembering the last amount is one tap
     away from taking the wrong deposit from the wrong customer. */
  useEffect(() => {
    if (!open) return
    setAmount(0)
    setReference('')
    setTenderTypeId(depositTenders(tenders)[0]?.id ?? null)
  }, [open, tenders])

  const position = { totalIncl, heldTotal }
  const left = stillToPay(position)
  const tender = options.find((t) => t.id === tenderTypeId) ?? null

  /* The same pure rule the server applies, so the button explains itself before
     the round trip rather than after it. */
  const refusal =
    amount > 0
      ? takeRefusal({
          status,
          totalIncl,
          heldTotal,
          amount,
          minPct,
          hasCustomer,
          allowWalkin,
        })
      : null

  const canTake = online && amount > 0 && tender !== null && !refusal && !busy

  function take() {
    if (!tender) return
    setBusy(true)
    takeDepositAction({
      documentId,
      amount,
      tenderTypeId: tender.id,
      reference: reference.trim() || null,
      terminalId,
    })
      .then((result) => {
        if (!result.ok) {
          toast.error(result.error)
          return
        }
        /* What is STILL TO PAY, not what was taken. The cashier knows what they
           keyed; the customer wants to know what is left. */
        toast.success(
          result.stillToPay > 0
            ? `${formatMoney(amount)} held. ${formatMoney(result.stillToPay)} still to pay.`
            : `${formatMoney(amount)} held. Paid in full.`,
        )
        onTaken(result.held, result.stillToPay)
        onClose()
      })
      .catch(() =>
        toast.error('That deposit could not be recorded. Nothing was taken — try again.'),
      )
      .finally(() => setBusy(false))
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Take a deposit"
      description="Money held against this sale. The goods stay here until it is paid up."
      size="lg"
      /* Amount, a tender grid and a reference: the tender keys are touch-sized,
         so this runs past 60vh on a shop with more than a few tenders. */
      bodyGrows
      footer={
        <>
          <Button variant="ghost" size="touch" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="success"
            size="touch-lg"
            className="flex-1 justify-center"
            disabled={!canTake}
            onClick={take}
          >
            <Icons.HandCoins size={20} />
            {amount > 0 ? `Hold ${formatMoney(amount)}` : 'Take deposit'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {/* Offline is a refusal, not a failure. Said first, because everything
            below it is pointless until the connection is back. */}
        {!online && (
          <Callout tone="warning" title="Deposits need a connection">
            A basket saved offline stays on this till and never reaches the
            office, so money held against it would have no record anywhere else.
            Take the deposit once this till is back online.
          </Callout>
        )}

        {/* ── Where the sale stands ──────────────────────────────────────── */}
        <div className="rounded-card border border-border bg-surface-2 px-4 py-3">
          <SummaryList>
            <SummaryRow label="This sale" value={formatMoney(totalIncl)} />
            {heldTotal > 0 && (
              <SummaryRow label="Already held" value={formatMoney(heldTotal)} tone="success" />
            )}
            {/* The one number the panel exists to state — what the customer
                still owes after this deposit. */}
            <SummaryTotal label="Still to pay" value={formatMoney(left)} />
          </SummaryList>

          {heldTotal > 0 && totalIncl > 0 && (
            <div className="mt-3">
              {/* total={100} because percentHeld returns a percentage — without a
                  denominator the single segment fills the bar and every deposit
                  would look like payment in full. */}
              <MeterBar
                total={100}
                segments={[{ value: percentHeld(position), tone: 'success', label: 'Held' }]}
              />
              {/* Labelled, because the bar has no scale of its own: a stripe a
                  third of the way along only means something if the reader knows
                  a third of what. */}
              <p className="mt-1.5 text-xs text-muted">
                {percentHeld(position).toFixed(0)}% of {formatMoney(totalIncl)} held
              </p>
            </div>
          )}
        </div>

        {/* ── How much ───────────────────────────────────────────────────── */}
        <Field
          label="Deposit"
          hint={
            minPct > 0
              ? `This store asks for at least ${minPct}% up front.`
              : 'Any amount up to what is still owed.'
          }
          error={refusal ?? undefined}
        >
          <CurrencyInput
            size="touch"
            value={amount}
            onChange={(e) => setAmount(Number(e.target.value.replace(',', '.')) || 0)}
            disabled={!online}
          />
        </Field>

        {/* The two amounts a cashier actually reaches for. Half is the common
            ask on a special order; the balance is what closes it. */}
        {left > 0 && online && (
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="touch"
              className="flex-1 justify-center"
              onClick={() => setAmount(Math.round((left / 2) * 100) / 100)}
              disabled={busy}
            >
              Half · {formatMoney(Math.round((left / 2) * 100) / 100)}
            </Button>
            <Button
              variant="secondary"
              size="touch"
              className="flex-1 justify-center"
              onClick={() => setAmount(left)}
              disabled={busy}
            >
              All · {formatMoney(left)}
            </Button>
          </div>
        )}

        {/* ── How they are paying ────────────────────────────────────────── */}
        {online && (
          <Field label="How they are paying">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {options.map((option) => (
                <Button
                  key={option.id}
                  variant={option.id === tenderTypeId ? 'primary' : 'secondary'}
                  size="touch"
                  className="justify-center"
                  onClick={() => setTenderTypeId(option.id)}
                  disabled={busy}
                >
                  {option.name}
                </Button>
              ))}
            </div>
          </Field>
        )}

        {tender?.requiresReference && online && (
          <Field label={tender.referenceLabel ?? 'Reference'}>
            <Input
              size="touch"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
        )}

        {/* Said once, at the bottom, where it answers the question a cashier
            gets asked: "what happens to my money if I change my mind". */}
        {online && (
          <p className="text-sm text-muted">
            A deposit stays the customer&apos;s money until the goods are handed
            over, and can be given back in full at any time before then.
          </p>
        )}
      </div>
    </Modal>
  )
}

/**
 * The tenders a deposit may be taken on.
 *
 * An ACCOUNT tender is excluded because it extends credit rather than receiving
 * money — the shop would be holding a deposit nobody paid. DEPOSIT itself is
 * excluded because it is how a held deposit reaches a posted sale, and paying a
 * deposit with a deposit is a loop with no money in it.
 */
function depositTenders(tenders: TenderType[]): TenderType[] {
  return tenders.filter((t) => t.isActive && !t.postsToDebtor && t.code !== 'DEPOSIT')
}
