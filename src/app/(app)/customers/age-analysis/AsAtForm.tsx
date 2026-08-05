'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { Button, Field, Icons, Input, Select, Switch } from '@/components/ui'
import { withParams } from '@/lib/searchParams'

/**
 * The controls above the age analysis.
 *
 * A client component so the as-at date can be typed and applied in one go, but
 * it changes nothing itself — every control writes to the URL and lets the
 * server re-query. That keeps a historic age analysis linkable and printable,
 * which is the whole reason anyone asks for one as at a past date.
 */
export default function AsAtForm({
  asAt,
  basis,
  overdueOnly,
}: {
  asAt: string
  basis: 'due' | 'doc'
  overdueOnly: boolean
}) {
  const router = useRouter()
  const params = useSearchParams()

  function apply(changes: Record<string, string | null>) {
    router.push(`/customers/age-analysis${withParams(params, changes)}`)
  }

  return (
    <div className="flex flex-wrap items-end gap-4 rounded-card border border-border bg-surface px-4 py-3">
      <Field label="As at" hint="Rebuilds the book as it stood on that date.">
        <Input
          type="date"
          defaultValue={asAt}
          onChange={(e) => e.target.value && apply({ asAt: e.target.value })}
          className="w-44"
        />
      </Field>

      <Field label="Age by" hint="Due date is how overdue; document date is how old.">
        <Select value={basis} onChange={(e) => apply({ basis: e.target.value })} className="w-48">
          <option value="due">Due date</option>
          <option value="doc">Document date</option>
        </Select>
      </Field>

      <div className="pb-2">
        <Switch
          checked={overdueOnly}
          onChange={(next) => apply({ overdue: next ? '1' : null })}
          label="Overdue only"
          hint="The collections list."
        />
      </div>

      <div className="ml-auto pb-1">
        <Button variant="ghost" onClick={() => router.push('/customers/age-analysis')}>
          <Icons.Refresh size={15} />
          Reset
        </Button>
      </div>
    </div>
  )
}
