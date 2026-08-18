'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
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
 * What was DECIDED about this quote.
 *
 * Sits BESIDE the shared editor rather than inside it: outcome and conversion
 * are what make a quote a quote, and keeping them out of the grid is what lets
 * one editor serve every document without growing conditionals through its
 * middle.
 *
 * Below it, specifically. The lines are the work; accepting, losing and
 * converting are what you decide once you have read them, which is also why
 * the deposit panel sits down there.
 *
 * Validity used to live here too, but "Valid until" is captured, not decided —
 * it belongs with the date and the customer reference in the document header,
 * and QuoteValidUntilField now renders it there. All that remains of it here
 * is the read-only line for a quote nobody can change any more.
 */
export function QuotePanel({ quote, canEdit }: { quote: Quote; canEdit: boolean }) {
  const router = useRouter()
  const toast = useToast()
  const [pending, startTransition] = useTransition()

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
        if (result.invoiceId) router.push(`/invoicing/${result.invoiceId}`)
      }
    })
  }

  const isDecided = quote.outcome !== 'open'

  return (
    <>
      {/* No gutter and no top padding of its own any more: the quote page wraps
          every section below the editor in ONE block that carries `px-6` and
          `gap-5`. A panel bringing its own padding as well is what made the
          seam under the grid three times the gap used everywhere else. */}
      <div className="flex flex-col gap-5">
        <Card>
          {/*
            A titled section like every other card on the screen.

            This was a bare `CardBody` holding a lone badge and two buttons —
            an unlabelled box below the totals that gave no clue what it was
            for, and on an open quote with the validity moved out it had almost
            nothing left in it. The heading says what the decision IS, the
            badge beside it says where the quote has got to, and the buttons
            that change it sit in the header's action slot.
          */}
          <CardHeader
            icon={<Icons.FileText size={18} />}
            title="Outcome"
            description={
              isDecided
                ? 'What was decided, and the invoice it became.'
                : 'Accept it to raise the invoice, or record why it was lost.'
            }
            action={
              <div className="flex items-center gap-2">
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
              </div>
            }
          />
          {/*
            A draft has nothing to decide yet.

            Accept and Mark lost both need a document number — an offer nobody
            has been given cannot be accepted or lost — so on a draft this body
            rendered as a padded empty box under a heading, which reads as a
            section that failed to load. It now says what has to happen first
            and names the button that does it.
          */}
          {!isDecided && canEdit && !quote.documentNumber ? (
            <CardBody>
              <p className="text-sm text-muted">
                Issue the quote before it can be accepted or marked lost — use “Issue quote”
                at the top of the screen.
              </p>
            </CardBody>
          ) : (
          <CardBody className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex flex-wrap items-center gap-3">
              {/* The EDITABLE "Valid until" now sits in the document header,
                  beside the date and the customer reference — it is captured
                  with those, not decided with these. What stays here is the
                  read-only fact for a quote that can no longer be changed,
                  where the validity is history rather than a setting. */}
              {(isDecided || !canEdit) && quote.validUntil && (
                <span className="text-sm text-muted">Valid until {quote.validUntil}</span>
              )}

              {quote.lostReason && (
                <span className="text-sm text-muted">Lost: {quote.lostReason}</span>
              )}
            </div>

            <div className="ml-auto flex items-center gap-2">
              {quote.convertedToId ? (
                <Link
                  href={`/invoicing/${quote.convertedToId}`}
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
          )}
        </Card>

        {/* What conversion found. Deliberately persistent: these change what
            somebody should do next on the invoice that was just created. */}
        {warnings.length > 0 && (
          /* No mt-4 — the column's own gap-5 spaces this from the card above,
             and carrying both stacked two margins into one seam. */
          <Card>
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
                  href={`/invoicing/${quote.convertedToId}`}
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
