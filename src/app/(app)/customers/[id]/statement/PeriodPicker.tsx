'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { DateRangeField, Icons, Button } from '@/components/ui'
import { withParams } from '@/lib/searchParams'

/**
 * The period a statement covers.
 *
 * The builder has always accepted `from`/`to` — there was simply no control to
 * set them, so getting "June only" meant editing the URL by hand. Writes to the
 * query string rather than holding state, which keeps the preview, the PDF link
 * and the emailed copy reading the same period: they all build from the same
 * params.
 *
 * "Last month" is the one people want at month-end, and it is already a preset
 * on DateRangeField, so no bespoke shortcut is needed here — Reset just drops
 * both keys and lets the builder fall back to its 90-day default.
 */
export default function PeriodPicker({
  basePath,
  from,
  to,
}: {
  basePath: string
  from: string
  to: string
}) {
  const router = useRouter()
  const params = useSearchParams()

  return (
    <div className="flex flex-wrap items-end justify-between gap-4 rounded-card border border-border bg-surface px-4 py-3">
      <DateRangeField
        value={{ from, to }}
        onChange={(next) =>
          router.push(`${basePath}${withParams(params, { from: next.from, to: next.to })}`)
        }
        label="Period"
      />
      <Button
        variant="ghost"
        onClick={() => router.push(`${basePath}${withParams(params, { from: null, to: null })}`)}
      >
        <Icons.Refresh size={15} />
        Reset
      </Button>
    </div>
  )
}
