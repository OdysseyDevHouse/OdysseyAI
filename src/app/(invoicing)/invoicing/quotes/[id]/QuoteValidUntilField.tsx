'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Field, Icons, Input, useToast } from '@/components/ui'
import { setValidUntilAction } from '../actions'
import { HEADER_CELL } from '@/app/(invoicing)/invoicing/[id]/InvoiceEditor'

/**
 * How long the quote stands.
 *
 * A field on its own, rather than part of QuotePanel, because it is captured
 * with the rest of the document header — customer, price type, date — and not
 * with the outcome. The editor renders it in the details card under the
 * customer; the panel below the lines keeps the decisions (accepted, lost,
 * converted), which is a different moment in the same document's life.
 *
 * Saves on change, like it always has: there is no Save button on this card,
 * and a date the user typed and then navigated away from should have stuck.
 */
export function QuoteValidUntilField({
  quoteId,
  validUntil: initial,
  daysRemaining,
  showDaysLeft,
}: {
  quoteId: number
  validUntil: string | null
  /** Days until it expires, or null when it never does. */
  daysRemaining: number | null
  /** Only an open quote counts down — a decided one's validity is history. */
  showDaysLeft: boolean
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, startTransition] = useTransition()
  const [validUntil, setValidUntil] = useState(initial ?? '')

  const expiringSoon = showDaysLeft && daysRemaining !== null && daysRemaining <= 7

  return (
    /* A cell in the editor's header strip, shaped exactly like the price type
       and date beside it — glyph, then the field. HEADER_CELL comes from the
       editor rather than being copied, so this cell cannot drift away from the
       siblings it has to line up with. */
    <div className={HEADER_CELL}>
      <span className="flex size-9 shrink-0 items-center justify-center rounded-control bg-brand-soft text-brand">
        <Icons.CalendarRange size={18} />
      </span>
      <Field
        label="Valid until"
        hint={
          expiringSoon
            ? daysRemaining <= 0
              ? 'Expires today.'
              : `${daysRemaining} day${daysRemaining === 1 ? '' : 's'} left.`
            : 'Blank means it does not expire.'
        }
        className="min-w-0 flex-1"
      >
        <Input
          type="date"
          value={validUntil}
          disabled={pending}
          onChange={(e) => {
            const next = e.target.value
            setValidUntil(next)
            startTransition(async () => {
              const result = await setValidUntilAction(quoteId, next || null)
              if (result.ok) {
                toast.success(result.message)
                router.refresh()
              } else {
                toast.error(result.error)
              }
            })
          }}
        />
      </Field>
    </div>
  )
}
