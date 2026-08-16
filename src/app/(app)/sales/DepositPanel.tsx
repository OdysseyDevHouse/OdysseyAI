'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Button,
  Card,
  CardHeader,
  CardBody,
  Field,
  Input,
  CurrencyInput,
  Select,
  Badge,
  Modal,
  MeterBar,
  Icons,
  useToast,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import { takeRefusal, refundRefusal, stillToPay, percentHeld } from '@/lib/depositRules'
import type { Deposit } from '@/lib/site/deposits'
import {
  takeDocumentDepositAction,
  refundDocumentDepositAction,
  depositOptionsAction,
} from './depositActions'

type TenderOption = {
  id: number
  name: string
  requiresReference: boolean
  referenceLabel: string | null
}

/**
 * Money held against a quote or an invoice.
 *
 * ── ONE PANEL, BOTH SCREENS ───────────────────────────────────────────────
 *
 * Quotes and invoices are the same `sales_documents` row with a different
 * `doc_type`, and a deposit behaves identically on either — so this is one
 * component rendered by both pages rather than two that would drift. The only
 * thing that differs is the sentence under the heading, which is why `docType`
 * is a prop and nothing else is.
 *
 * ── IT ONLY APPEARS WHEN IT HAS SOMETHING TO SAY ──────────────────────────
 *
 * On a document with no deposits and no total there is nothing to hold money
 * against, and a card offering to take one is noise above the grid somebody
 * came here to fill in. So an empty panel on an empty document renders nothing
 * at all — the button appears once the document is worth something.
 */
export function DepositPanel({
  documentId,
  docType,
  status,
  totalIncl,
  held,
  entries,
  hasCustomer,
  canEdit,
}: {
  documentId: number
  docType: 'quote' | 'invoice' | 'sales_order' | 'credit_sale'
  status: string
  totalIncl: number
  /** Σ amount — what is currently held. Server-computed, never a stored total. */
  held: number
  entries: Deposit[]
  hasCustomer: boolean
  canEdit: boolean
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, startTransition] = useTransition()

  const [taking, setTaking] = useState(false)
  const [refunding, setRefunding] = useState(false)
  const [amount, setAmount] = useState(0)
  const [tenderTypeId, setTenderTypeId] = useState<number | null>(null)
  const [reference, setReference] = useState('')

  const [options, setOptions] = useState<TenderOption[]>([])
  const [minPct, setMinPct] = useState(0)
  const [allowWalkin, setAllowWalkin] = useState(true)

  /* Loaded once the first dialog opens rather than on mount: most visits to an
     invoice never touch a deposit, and this is three queries the page does not
     otherwise need. */
  useEffect(() => {
    if (!taking && !refunding) return
    if (options.length > 0) return
    depositOptionsAction()
      .then((loaded) => {
        setOptions(loaded.tenders)
        setMinPct(loaded.minPct)
        setAllowWalkin(loaded.allowWalkin)
        setTenderTypeId(loaded.tenders[0]?.id ?? null)
      })
      .catch(() => toast.error('The payment methods could not be read. Try again.'))
    // toast is stable for the life of the provider; listing it would re-run this
    // on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taking, refunding, options.length])

  const position = { totalIncl, heldTotal: held }
  const left = stillToPay(position)
  const tender = options.find((t) => t.id === tenderTypeId) ?? null

  /* Nothing held and nothing to hold it against: the document is empty, and a
     deposit card above an empty grid is in the way. */
  if (held === 0 && totalIncl <= 0) return null

  const refusal =
    amount > 0
      ? taking
        ? takeRefusal({ status, totalIncl, heldTotal: held, amount, minPct, hasCustomer, allowWalkin })
        : refundRefusal({ status, totalIncl, heldTotal: held, amount })
      : null

  function close() {
    setTaking(false)
    setRefunding(false)
    setAmount(0)
    setReference('')
  }

  function submit() {
    if (!tender) return
    const action = taking ? takeDocumentDepositAction : refundDocumentDepositAction
    startTransition(async () => {
      const result = await action({
        documentId,
        amount,
        tenderTypeId: tender.id,
        reference: reference.trim() || null,
      }).catch(() => ({ ok: false as const, error: 'That could not be recorded. Try again.' }))

      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(
        taking
          ? result.stillToPay > 0
            ? `${formatMoney(amount)} held. ${formatMoney(result.stillToPay)} still to pay.`
            : `${formatMoney(amount)} held. Paid in full.`
          : `${formatMoney(amount)} returned.`,
      )
      close()
      router.refresh()
    })
  }

  return (
    <>
      <Card>
        <CardHeader
          title="Deposit"
          description={
            docType === 'quote'
              ? 'Money held to secure this quote. It carries onto the invoice when the quote is accepted.'
              : 'Money already paid. It settles this invoice when it is finalised.'
          }
          action={
            canEdit ? (
              <div className="flex gap-2">
                {held > 0 && (
                  <Button variant="secondary" size="sm" onClick={() => setRefunding(true)}>
                    Refund
                  </Button>
                )}
                {left > 0 && (
                  <Button variant="primary" size="sm" onClick={() => setTaking(true)}>
                    <Icons.HandCoins size={16} />
                    Take a deposit
                  </Button>
                )}
              </div>
            ) : undefined
          }
        />
        <CardBody>
          {/*
           * A GRID, not justify-between.
           *
           * The three figures and the meter under them are one picture: the bar
           * says what proportion of the document total is held, so its rails
           * have to be the same rails the figures stand on. `justify-between`
           * pushed the outer two to the card edges and let the middle float
           * wherever the text width put it, which left the fill pointing at
           * nothing — the bar ended under "Held" by coincidence rather than by
           * meaning.
           *
           * Right-aligning the last column keeps "Still to pay" against the
           * card edge, which is where the eye goes for the answer, while the
           * bar below still measures the full width it is a proportion of.
           */}
          <div className="grid grid-cols-2 gap-x-8 gap-y-4 sm:grid-cols-3">
            <Figure label="Document total" value={totalIncl} />
            <Figure label="Held" value={held} tone={held > 0 ? 'success' : 'default'} />
            {/* The loudest number on the card: what the customer still owes is
                the question anybody opens this panel to answer. */}
            <div className="col-span-2 sm:col-span-1 sm:text-right">
              <p className="text-xs uppercase tracking-wide text-muted">Still to pay</p>
              <p className="numeric text-2xl font-semibold text-ink">{formatMoney(left)}</p>
            </div>
          </div>

          {held > 0 && totalIncl > 0 && (
            <div className="mt-4">
              {/* `total` is what makes this a proportion rather than a full bar:
                  without a denominator the only segment IS the whole bar, so a
                  R500 deposit on a R2 000 quote would draw as paid in full. */}
              <MeterBar
                total={100}
                segments={[{ value: percentHeld(position), tone: 'success', label: 'Held' }]}
              />
              {/* The bar carries no scale of its own, so it is labelled. A green
                  stripe that stops a third of the way along is only meaningful
                  if the reader knows a third OF WHAT. */}
              <p className="mt-1.5 text-xs text-muted">
                {percentHeld(position).toFixed(0)}% of {formatMoney(totalIncl)} held
              </p>
            </div>
          )}

          {/* The history, once there is any. A single deposit needs no table —
              the figures above already say it — but two payments on different
              days is exactly what somebody comes here to check. */}
          {entries.length > 1 && (
            <ul className="mt-4 flex flex-col gap-1.5 border-t border-border pt-3">
              {entries.map((entry) => (
                <li key={entry.id} className="flex items-baseline justify-between gap-4 text-sm">
                  <span className="text-ink-2">
                    {entry.takenOn} · {entry.tenderName || 'Deposit'}
                    {entry.reference ? ` · ${entry.reference}` : ''}
                  </span>
                  <span className="flex items-center gap-2">
                    {entry.kind !== 'deposit' && (
                      <Badge tone={entry.kind === 'refund' ? 'warning' : 'default'}>
                        {entry.kind === 'refund' ? 'Refunded' : 'Applied'}
                      </Badge>
                    )}
                    <span className="numeric text-ink">{formatMoney(entry.amount)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <Modal
        open={taking || refunding}
        onClose={close}
        title={taking ? 'Take a deposit' : 'Refund a deposit'}
        description={
          taking
            ? 'Money held against this document. It is not a payment against an account.'
            : 'Money handed back. It stays the customer’s until the goods are delivered.'
        }
        footer={
          <>
            <Button variant="ghost" onClick={close} disabled={pending}>
              Cancel
            </Button>
            <Button
              variant={taking ? 'primary' : 'danger'}
              disabled={amount <= 0 || !tender || !!refusal || pending}
              onClick={submit}
            >
              {taking
                ? amount > 0
                  ? `Hold ${formatMoney(amount)}`
                  : 'Take deposit'
                : amount > 0
                  ? `Refund ${formatMoney(amount)}`
                  : 'Refund'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Field
            label={taking ? 'Deposit' : 'Refund'}
            hint={
              taking
                ? minPct > 0
                  ? `At least ${minPct}% of ${formatMoney(totalIncl)} is asked for up front.`
                  : `Up to ${formatMoney(left)}.`
                : `Up to ${formatMoney(held)} is held.`
            }
            error={refusal ?? undefined}
          >
            <CurrencyInput
              value={amount}
              onChange={(e) => setAmount(Number(e.target.value.replace(',', '.')) || 0)}
            />
          </Field>

          <Field label={taking ? 'How it arrived' : 'How it is going back'}>
            <Select
              value={tenderTypeId ?? ''}
              onChange={(e) => setTenderTypeId(Number(e.target.value) || null)}
            >
              {options.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </Select>
          </Field>

          {tender?.requiresReference && (
            <Field label={tender.referenceLabel ?? 'Reference'}>
              <Input
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                autoComplete="off"
              />
            </Field>
          )}
        </div>
      </Modal>
    </>
  )
}

/** One figure in the summary row. Muted label, tabular value. */
function Figure({
  label,
  value,
  tone = 'default',
}: {
  label: string
  value: number
  tone?: 'default' | 'success'
}) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-muted">{label}</p>
      <p
        className={`numeric text-lg font-medium ${
          tone === 'success' ? 'text-success-ink' : 'text-ink-2'
        }`}
      >
        {formatMoney(value)}
      </p>
    </div>
  )
}
