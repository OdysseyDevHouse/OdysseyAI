'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  Button,
  Card,
  CardBody,
  Field,
  Input,
  Badge,
  Icons,
  Modal,
  useToast,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
// The pure model rather than a hand-copied union: this file used to declare
// its own QuoteState, which meant adding a state to the real one silently left
// this screen behind.
import type { QuoteOutcome, QuoteState } from '@/lib/quotesModel'
import {
  setValidUntilAction,
  declineQuoteAction,
  reopenQuoteAction,
  convertQuoteAction,
} from '../actions'

type Quote = {
  id: number
  documentNumber: string | null
  state: QuoteState
  validUntil: string | null
  daysRemaining: number | null
  outcome: QuoteOutcome
  lostReason: string | null
  convertedToId: number | null
  convertedToNumber: string | null
  totalIncl: number
}

/**
 * Everything a quote has that an invoice does not.
 *
 * Sits BESIDE the shared editor rather than inside it: validity, outcome and
 * conversion are the three things that make a quote a quote, and keeping them
 * out of the grid is what lets one editor serve every document without growing
 * conditionals through its middle.
 *
 * Below it, specifically. This rendered first for a long time, which put
 * "Valid until" in a card above the quote's own heading and back arrow — the
 * first thing on the screen was a detail about a document that had not been
 * named yet. The lines are the work; validity and outcome are what you decide
 * once you have read them, which is also why the deposit panel sits down there.
 */
export function QuotePanel({ quote, canEdit }: { quote: Quote; canEdit: boolean }) {
  const router = useRouter()
  const toast = useToast()
  const [pending, startTransition] = useTransition()

  const [validUntil, setValidUntil] = useState(quote.validUntil ?? '')
  const [declining, setDeclining] = useState(false)
  const [reason, setReason] = useState('')
  const [warnings, setWarnings] = useState<string[]>([])

  function run(action: () => Promise<{ ok: boolean; message?: string; error?: string }>) {
    startTransition(async () => {
      const result = await action()
      if (result.ok) {
        toast.success(result.message ?? 'Done.')
        router.refresh()
      } else {
        toast.error(result.error ?? 'That did not work.')
      }
    })
  }

  function convert() {
    startTransition(async () => {
      const result = await convertQuoteAction(quote.id)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      // Warnings are shown on the screen rather than in a toast: an expired
      // quote, a moved price or short stock are things to read before
      // finalising the invoice, not things to glance at as they fade.
      if (result.warnings && result.warnings.length > 0) {
        setWarnings(result.warnings)
        toast.success(result.message)
      } else {
        toast.success(result.message)
        if (result.invoiceId) router.push(`/sales/invoicing/${result.invoiceId}`)
      }
    })
  }

  const isDecided = quote.outcome !== 'open'

  return (
    <>
      <div className="px-6 pt-4">
        <Card>
          <CardBody className="flex flex-wrap items-end justify-between gap-4">
            <div className="flex flex-wrap items-center gap-3">
              <Badge
                tone={
                  quote.state === 'accepted'
                    ? 'success'
                    : quote.state === 'expired'
                      ? 'danger'
                      : quote.state === 'declined'
                        ? 'default'
                        : 'warning'
                }
              >
                {quote.state === 'accepted'
                  ? 'Accepted'
                  : quote.state === 'declined'
                    ? 'Lost'
                    : quote.state === 'expired'
                      ? 'Expired'
                      : quote.state === 'draft'
                        ? 'Draft'
                        : 'Awaiting a decision'}
              </Badge>

              {/* Only shown while it can still be changed — a decided quote's
                  validity is history. */}
              {!isDecided && canEdit ? (
                <Field label="Valid until" hint="Blank means it does not expire.">
                  <Input
                    type="date"
                    value={validUntil}
                    disabled={pending}
                    onChange={(e) => {
                      setValidUntil(e.target.value)
                      run(() => setValidUntilAction(quote.id, e.target.value || null))
                    }}
                    className="w-44"
                  />
                </Field>
              ) : quote.validUntil ? (
                <span className="text-sm text-muted">Valid until {quote.validUntil}</span>
              ) : null}

              {quote.state === 'open' &&
                quote.daysRemaining !== null &&
                quote.daysRemaining <= 7 && (
                  <span className="text-sm text-warning-ink">
                    {quote.daysRemaining <= 0
                      ? 'Expires today'
                      : `${quote.daysRemaining} day${quote.daysRemaining === 1 ? '' : 's'} left`}
                  </span>
                )}

              {quote.lostReason && (
                <span className="text-sm text-muted">Lost: {quote.lostReason}</span>
              )}
            </div>

            <div className="flex items-center gap-2">
              {quote.convertedToId ? (
                <Link
                  href={`/sales/invoicing/${quote.convertedToId}`}
                  className="text-sm text-brand hover:underline"
                >
                  Became invoice {quote.convertedToNumber ?? `#${quote.convertedToId}`}
                </Link>
              ) : isDecided ? (
                canEdit && (
                  <Button
                    variant="secondary"
                    disabled={pending}
                    onClick={() => run(() => reopenQuoteAction(quote.id))}
                  >
                    Reopen
                  </Button>
                )
              ) : (
                canEdit &&
                quote.documentNumber && (
                  <>
                    <Button
                      variant="danger-ghost"
                      disabled={pending}
                      onClick={() => {
                        setReason('')
                        setDeclining(true)
                      }}
                    >
                      Mark lost
                    </Button>
                    <Button disabled={pending} onClick={convert}>
                      <Icons.Check size={15} />
                      Accept — {formatMoney(quote.totalIncl)}
                    </Button>
                  </>
                )
              )}
            </div>
          </CardBody>
        </Card>

        {/* What conversion found. Deliberately persistent: these change what
            somebody should do next on the invoice that was just created. */}
        {warnings.length > 0 && (
          <Card className="mt-4">
            <CardBody>
              <p className="text-sm font-medium text-warning-ink">
                Converted — but check these before finalising the invoice
              </p>
              <ul className="mt-2 space-y-1">
                {warnings.map((w, i) => (
                  <li key={i} className="text-sm text-muted">
                    {w}
                  </li>
                ))}
              </ul>
              {quote.convertedToId && (
                <Link
                  href={`/sales/invoicing/${quote.convertedToId}`}
                  className="mt-3 inline-block text-sm text-brand hover:underline"
                >
                  Open the draft invoice
                </Link>
              )}
            </CardBody>
          </Card>
        )}
      </div>

      <Modal
        open={declining}
        onClose={() => setDeclining(false)}
        title="Mark this quote as lost"
        footer={
          <>
            <Button variant="secondary" onClick={() => setDeclining(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={pending || !reason.trim()}
              onClick={() => {
                run(() => declineQuoteAction(quote.id, reason.trim()))
                setDeclining(false)
              }}
            >
              Mark lost
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-muted">
            One lost quote tells you nothing. A hundred with a reason against each tells you
            where the business is losing work — which is why this is asked rather than optional.
          </p>
          <Field label="Why was it lost?">
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              list="quote-lost-reasons"
              placeholder="e.g. Price"
            />
            <datalist id="quote-lost-reasons">
              <option value="Price" />
              <option value="Lead time" />
              <option value="Went to a competitor" />
              <option value="Project cancelled" />
              <option value="No response" />
            </datalist>
          </Field>
        </div>
      </Modal>
    </>
  )
}
