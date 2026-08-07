'use client'

import { useRouter } from 'next/navigation'
import { DateRangeField } from '@/components/ui'

/**
 * DateRangeField is a controlled client control; this thin wrapper lets the
 * server-rendered expenses list keep its filters in the URL — a chosen range is
 * pushed straight into the query string, where the page reads it back as
 * searchParams. `keep` carries the other filters through, for the same reason
 * SearchBar's keep exists: a filter change must not wipe its neighbours.
 */
export function DateRangeFilter({
  from,
  to,
  path,
  keep,
}: {
  from: string
  to: string
  path: string
  keep?: Record<string, string | undefined>
}) {
  const router = useRouter()

  return (
    <DateRangeField
      value={{ from, to }}
      onChange={(next) => {
        const params = new URLSearchParams()
        if (keep) {
          for (const [key, value] of Object.entries(keep)) {
            if (value) params.set(key, value)
          }
        }
        if (next.from) params.set('from', next.from)
        if (next.to) params.set('to', next.to)
        const query = params.toString()
        router.push(query ? `${path}?${query}` : path)
      }}
    />
  )
}
