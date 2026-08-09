'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { Card, DateRangeField, Field, Select, Icons, Button } from '@/components/ui'
import { withParams } from '@/lib/searchParams'
import type { StatementPeriod } from '@/lib/statementCycles'

const CUSTOM = 'custom'

/**
 * The period a statement covers, as a list of real periods.
 *
 * A statement is not a date range someone typed — it is "August 2026", or "the
 * week of the 4th". Typing two dates to reach last month, and twelve to flip
 * through six, was the whole friction here. The periods come from the account's
 * own cycle, so a weekly customer gets weeks and a monthly one gets months.
 *
 * The free-form range stays reachable behind "Custom dates", because "the exact
 * fortnight my auditor asked for" is a real request that no cycle produces.
 * Choosing a period clears from/to and vice versa: the page resolves explicit
 * dates ahead of the dropdown, so leaving both set would pin the range and make
 * the dropdown look broken.
 *
 * Writes to the query string rather than holding state, which keeps the
 * preview, the PDF link and the emailed copy reading the same period.
 */
export default function CyclePeriodPicker({
  basePath,
  periods,
  selectedKey,
  from,
  to,
  cycleNote,
  hint,
}: {
  basePath: string
  periods: StatementPeriod[]
  /** Null when a custom range is in force. */
  selectedKey: string | null
  from: string
  to: string
  /** 'Weekly cycle · Tuesday to Monday' — why these dates, in words. */
  cycleNote: string
  hint: string
}) {
  const router = useRouter()
  const params = useSearchParams()

  const go = (changes: Record<string, string | null>) =>
    router.push(`${basePath}${withParams(params, changes)}`)

  return (
    <Card className="flex flex-wrap items-end justify-between gap-4 px-4 py-3.5">
      <div className="flex flex-wrap items-end gap-4">
        <Field label="Period" hint={hint} className="min-w-[15rem]">
          <Select
            aria-label="Statement period"
            value={selectedKey ?? CUSTOM}
            onChange={(e) =>
              e.target.value === CUSTOM
                ? // Seed the date inputs from what is on screen, so they open on
                  // something sensible rather than empty.
                  go({ period: null, from, to })
                : go({ period: e.target.value, from: null, to: null })
            }
          >
            {periods.map((p) => (
              <option key={p.key} value={p.key}>
                {p.isCurrent ? `${p.label} (current)` : p.label}
              </option>
            ))}
            <option value={CUSTOM}>Custom dates…</option>
          </Select>
        </Field>

        {/* Raw dates only once "Custom dates" is chosen — two controls claiming
            to set the same thing is how the wrong one gets read. */}
        {selectedKey === null && (
          <DateRangeField
            value={{ from, to }}
            onChange={(next) => go({ period: null, from: next.from, to: next.to })}
            label="Dates"
          />
        )}
      </div>

      <div className="flex items-end gap-4">
        <p className="pb-2 text-xs text-muted">{cycleNote}</p>
        <Button variant="ghost" onClick={() => go({ period: null, from: null, to: null })}>
          <Icons.Refresh size={15} />
          Reset
        </Button>
      </div>
    </Card>
  )
}
