'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Button,
  ButtonLink,
  ConfirmModal,
  CurrencyInput,
  Field,
  Icons,
  Input,
  Modal,
  Select,
  useToast,
} from '@/components/ui'
import { formatMoney, round } from '@/lib/decimals'
import { FEE_WAIVER_LABELS, FEE_WAIVER_REASONS, type FeeWaiverReason } from '@/lib/laybyRules'
import type { TenderType } from '@/lib/site/tenderTypes'
import { takePaymentAction, completeLaybyAction, cancelLaybyAction } from '../actions'

/**
 * Taking money on a lay-by, and ending one.
 *
 * The payment box defaults to the FULL outstanding amount, because the most
 * common instalment is the last one — the customer has come in to collect. It
 * is editable for every other case.
 *
 * The cancellation dialog states the fee and the refund BEFORE the button is
 * pressed. Under section 62 the fee is capped, conditional and often zero, and
 * someone cancelling on a customer's behalf should not have to guess which of
 * those applies today.
 */
export default function LaybyActions({
  laybyId,
  status,
  outstanding,
  tenders,
  cancellationFee,
  cancellationRefund,
  noFeeReason,
}: {
  laybyId: number
  status: string
  outstanding: number
  tenders: TenderType[]
  cancellationFee: number
  cancellationRefund: number
  noFeeReason: string | null
}) {
  const [paying, setPaying] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [completing, setCompleting] = useState(false)

  const [amount, setAmount] = useState(outstanding)
  const [tenderId, setTenderId] = useState<number | null>(tenders[0]?.id ?? null)
  const [reference, setReference] = useState('')
  const [reason, setReason] = useState('')
  const [waiver, setWaiver] = useState<FeeWaiverReason | ''>('')
  const [pending, startTransition] = useTransition()

  const toast = useToast()
  const router = useRouter()
  const isOpen = status === 'open'
  const settled = outstanding <= 0.004

  function pay() {
    if (!tenderId) return
    startTransition(async () => {
      const tender = tenders.find((t) => t.id === tenderId)
      const result = await takePaymentAction(laybyId, {
        amount,
        tenderTypeId: tenderId,
        tenderName: tender?.name ?? 'Cash',
        reference: reference || null,
      })
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(result.message)
      setPaying(false)
      setReference('')
      router.refresh()
    })
  }

  function complete() {
    if (!tenderId) return
    startTransition(async () => {
      const result = await completeLaybyAction(laybyId, tenderId)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(result.message)
      setCompleting(false)
      router.push(`/sales/${result.documentId}`)
    })
  }

  function cancel() {
    startTransition(async () => {
      const tender = tenders.find((t) => t.id === tenderId)
      const result = await cancelLaybyAction(laybyId, {
        reason,
        waiverReason: waiver || null,
        tenderTypeId: tenderId,
        tenderName: tender?.name ?? 'Cash',
      })
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(result.message)
      setCancelling(false)
      router.refresh()
    })
  }

  // A closed lay-by keeps its Print button. The agreement is the customer's
  // record of what was agreed and what happened to their money — a completed
  // or cancelled one is exactly when someone asks for a copy.
  if (!isOpen) {
    return (
      <ButtonLink href={`/sales/laybys/${laybyId}/print`} variant="secondary">
        <Icons.Printer size={15} />
        Print
      </ButtonLink>
    )
  }

  return (
    <div className="flex items-center gap-2">
      <ButtonLink href={`/sales/laybys/${laybyId}/print`} variant="secondary">
        <Icons.Printer size={15} />
        Print
      </ButtonLink>

      <Button variant="danger-ghost" onClick={() => setCancelling(true)} disabled={pending}>
        <Icons.Ban size={15} />
        Cancel lay-by
      </Button>

      {settled ? (
        <Button variant="success" onClick={() => setCompleting(true)} disabled={pending}>
          <Icons.Check size={15} />
          Hand the goods over
        </Button>
      ) : (
        <Button
          variant="primary"
          onClick={() => {
            setAmount(outstanding)
            setPaying(true)
          }}
          disabled={pending}
        >
          <Icons.Coins size={15} />
          Take a payment
        </Button>
      )}

      <Modal
        open={paying}
        onClose={() => setPaying(false)}
        title="Take a payment"
        description={`${formatMoney(outstanding)} outstanding.`}
        closeOnBackdrop={false}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPaying(false)} disabled={pending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={pay}
              disabled={pending || amount <= 0 || amount > outstanding + 0.004 || !tenderId}
            >
              {pending ? 'Taking…' : `Take ${formatMoney(amount)}`}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Field
            label="Amount"
            hint="Defaults to the full balance — the last instalment is the common one."
            error={amount > outstanding + 0.004 ? `Only ${formatMoney(outstanding)} is outstanding.` : undefined}
          >
            <CurrencyInput
              value={amount}
              onChange={(e) => setAmount(round(Number(String(e.target.value).replace(',', '.')) || 0, 2))}
            />
          </Field>
          <Field label="Paid by">
            <Select
              value={tenderId ?? ''}
              onChange={(e) => setTenderId(Number(e.target.value) || null)}
            >
              {tenders.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Reference" hint="Optional — a deposit slip or card reference.">
            <Input value={reference} onChange={(e) => setReference(e.target.value)} />
          </Field>
        </div>
      </Modal>

      <ConfirmModal
        open={completing}
        onClose={() => setCompleting(false)}
        onConfirm={complete}
        title="Hand the goods over?"
        confirmLabel="Invoice and release"
        tone="primary"
        busy={pending}
        message="This is the moment it becomes a sale: an invoice is raised, the VAT is declared and the stock finally moves. Only do this once the customer has the goods in their hands."
      />

      <Modal
        open={cancelling}
        onClose={() => setCancelling(false)}
        title="Cancel this lay-by?"
        description="The goods go back on the shelf and the customer gets their money."
        closeOnBackdrop={false}
        footer={
          <>
            <Button variant="ghost" onClick={() => setCancelling(false)} disabled={pending}>
              Keep it open
            </Button>
            <Button variant="danger" onClick={cancel} disabled={pending || !reason.trim()}>
              {pending ? 'Cancelling…' : `Refund ${formatMoney(waiver ? cancellationFee + cancellationRefund : cancellationRefund)}`}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {/* Stated up front. The fee is capped at 1% by law, only applies well
              after the due date, and is often zero — nobody should have to
              guess which case they are in. */}
          <div className="rounded-card border border-border px-4 py-3 text-sm">
            {waiver || cancellationFee <= 0 ? (
              <p className="text-ink">
                The customer gets back{' '}
                <strong>{formatMoney(cancellationFee + cancellationRefund)}</strong> — everything
                they have paid.
              </p>
            ) : (
              <p className="text-ink">
                The customer gets back <strong>{formatMoney(cancellationRefund)}</strong>. The shop
                keeps <strong>{formatMoney(cancellationFee)}</strong> as the disclosed cancellation
                fee.
              </p>
            )}
            {noFeeReason && !waiver && (
              <p className="mt-1 text-xs text-muted">{noFeeReason}</p>
            )}
          </div>

          <Field label="Reason" hint="Required. Kept on the lay-by.">
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Customer no longer wants it"
            />
          </Field>

          <Field
            label="Waive any fee"
            hint="The Consumer Protection Act forbids a fee where the customer died or was hospitalised."
          >
            <Select
              value={waiver}
              onChange={(e) => setWaiver(e.target.value as FeeWaiverReason | '')}
            >
              <option value="">— Charge the fee if one applies —</option>
              {FEE_WAIVER_REASONS.map((r) => (
                <option key={r} value={r}>
                  {FEE_WAIVER_LABELS[r]}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </Modal>
    </div>
  )
}
