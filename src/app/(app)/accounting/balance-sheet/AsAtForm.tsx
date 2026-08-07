'use client'

import { useRouter } from 'next/navigation'
import { Field, Input } from '@/components/ui'

/**
 * The as-at date.
 *
 * A balance sheet describes a MOMENT, not a period, so it takes one date
 * rather than a range — the distinction that separates it from the profit and
 * loss beside it.
 */
export function AsAtForm({
  asAt,
  path = '/accounting/balance-sheet',
}: {
  asAt: string
  /** The trial balance shares this control — it must come back to its own page. */
  path?: string
}) {
  const router = useRouter()

  return (
    /* Width comes from the wrapper, not the control — the kit skin stays untouched. */
    <div className="w-44">
      <Field label="As at">
        <Input
          type="date"
          value={asAt}
          onChange={(e) => {
            if (/^\d{4}-\d{2}-\d{2}$/.test(e.target.value)) {
              router.push(`${path}?asAt=${e.target.value}`)
            }
          }}
        />
      </Field>
    </div>
  )
}
