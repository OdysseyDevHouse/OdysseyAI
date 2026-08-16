'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Select, useToast } from '@/components/ui'
import type { GroupOption } from '@/lib/reportBuilder/shape'
import { setReportGroupByAction } from '../../listColumnActions'

/**
 * Which column a report is broken into bands by, for the store.
 *
 * ── WHY A SELECT AND NOT A MENU ──────────────────────────────────────────
 *
 * One choice out of a short list, with a current value worth showing on the
 * face of the control. That is what the Period picker beside it already is, and
 * two controls that answer the same shape of question should not look different.
 *
 * ── WHY IT SITS WITH THE FILTERS ─────────────────────────────────────────
 *
 * Grouping says how the rows are shaped, which is the same kind of statement as
 * the period and the store scope — not an action like Export, and not a
 * per-person view preference like a sort. It reads left-to-right as "these
 * dates, these stores, broken up this way".
 *
 * ── WHY IT SAVES IMMEDIATELY, FOR EVERYONE ───────────────────────────────
 *
 * The choice is stored per STORE, so changing it changes what the whole shop
 * sees the next time anyone opens this report — which is the point, and the same
 * call the column picker makes. It is therefore only offered to a role that may
 * set the store up; everyone else gets the store's bands and no control. A user
 * who wants a different cut for themselves has the report builder.
 */
export default function ReportGroupByControl({
  reportId,
  options,
  value,
}: {
  reportId: string
  /** The columns this run can be banded by. Empty hides the control entirely. */
  options: readonly GroupOption[]
  /** The store's stored choice, already validated against `options`. */
  value: string | null
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, startTransition] = useTransition()

  // Nothing sensible to band by — every column is a figure, or a document
  // number. Offering an empty picker would be offering a broken control.
  if (options.length === 0) return null

  function save(next: string) {
    startTransition(async () => {
      const result = await setReportGroupByAction(
        reportId,
        next === '' ? null : next,
        options.map((o) => o.key),
      )
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      // The banding is applied on the server so the export and the scheduled
      // email agree with the screen, so the screen has to come back for it.
      router.refresh()
    })
  }

  return (
    <Select
      aria-label="Group by"
      value={value ?? ''}
      disabled={pending}
      onChange={(e) => save(e.target.value)}
    >
      <option value="">No grouping</option>
      {options.map((o) => (
        <option key={o.key} value={o.key}>
          {o.label}
        </option>
      ))}
    </Select>
  )
}
