'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { Card, DateRangeField, Icons, Button } from '@/components/ui'
import { withParams } from '@/lib/searchParams'

/** The creditors twin of the debtors picker — see that file for the reasoning. */
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
    <Card className="flex flex-wrap items-end justify-between gap-4 px-4 py-3.5">
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
    </Card>
  )
}
