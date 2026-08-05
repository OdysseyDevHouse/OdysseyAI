'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { DateRangeField, Icons, Button } from '@/components/ui'
import { withParams } from '@/lib/searchParams'

/**
 * The period every report runs over.
 *
 * Writes to the URL rather than holding state, so a report can be linked to,
 * bookmarked and printed — which is what someone does with a month-end figure
 * they want to send to their accountant.
 */
export default function RangePicker({ from, to }: { from: string; to: string }) {
  const router = useRouter()
  const params = useSearchParams()

  return (
    <div className="flex flex-wrap items-end justify-between gap-4 rounded-card border border-border bg-surface px-4 py-3">
      <DateRangeField
        value={{ from, to }}
        onChange={(next) =>
          router.push(`/reports${withParams(params, { from: next.from, to: next.to })}`)
        }
        label="Period"
      />
      <Button variant="ghost" onClick={() => router.push(`/reports${withParams(params, { from: null, to: null })}`)}>
        <Icons.Refresh size={15} />
        This month
      </Button>
    </div>
  )
}
