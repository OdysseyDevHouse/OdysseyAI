'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { Button, Card, Field, Icons, Input, Select, Switch } from '@/components/ui'
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
    <Card className="flex flex-wrap items-end gap-4 px-4 py-3.5">
      {/* Width lives on the wrapper, not the control — the control's skin
          stays the kit's own. */}
      <Field label="As at" hint="Rebuilds the book as it stood on that date." className="w-44">
        <Input
          type="date"
          defaultValue={asAt}
          onChange={(e) => e.target.value && apply({ asAt: e.target.value })}
        />
      </Field>

      <Field
        label="Age by"
        hint="Due date is how overdue; document date is how old."
        className="w-48"
      >
        <Select value={basis} onChange={(e) => apply({ basis: e.target.value })}>
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
    </Card>
  )
}
