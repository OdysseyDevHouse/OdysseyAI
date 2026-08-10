'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Button,
  Card,
  CardHeader,
  CardBody,
  CardFooter,
  Field,
  Input,
  Select,
  Switch,
  Callout,
  SelectableCard,
  Icons,
  useToast,
} from '@/components/ui'
import { createStockTakeAction } from '../actions'
import type { StockTakeScope } from '@/lib/site/stockTakes'

type Option = { id: number; name: string }
type LocationOption = { id: number; code: string; name: string }

/**
 * Choosing what to count.
 *
 * The scope choice comes FIRST and is a set of tiles rather than a dropdown,
 * because it is the decision that determines how long the next two hours take.
 * A dropdown makes "count the whole shop" and "count one shelf" look like the
 * same size of decision.
 */
const SCOPES: { id: StockTakeScope; label: string; hint: string }[] = [
  {
    id: 'full',
    label: 'Everything',
    hint: 'Every stocked product in this location. Only practical on a small catalogue.',
  },
  { id: 'department', label: 'One department', hint: 'A section of the shop at a time.' },
  { id: 'supplier', label: 'One supplier', hint: 'Everything bought from one place.' },
]

export default function NewStockTakeScreen({
  locations,
  departments,
  suppliers,
}: {
  locations: LocationOption[]
  departments: Option[]
  suppliers: Option[]
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, start] = useTransition()

  const [locationId, setLocationId] = useState(locations[0]?.id ?? 0)
  const [scope, setScope] = useState<StockTakeScope>('full')
  const [scopeRefId, setScopeRefId] = useState(0)
  const [reference, setReference] = useState('')
  const [includeZeroStock, setIncludeZeroStock] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const needsRef = scope === 'department' || scope === 'supplier'
  const refOptions = scope === 'department' ? departments : suppliers

  function create() {
    setError(null)
    start(async () => {
      const result = await createStockTakeAction({
        locationId,
        scope,
        scopeRefId: needsRef ? scopeRefId : null,
        reference: reference.trim() || null,
        includeZeroStock,
      })
      if (!result.ok) {
        setError(result.error)
        return
      }
      toast.success(`Sheet created with ${result.lineCount} line${result.lineCount === 1 ? '' : 's'}.`)
      router.push(`/stock-takes/${result.id}`)
    })
  }

  return (
    <>
      <Card>
        <CardHeader
          title="What are you counting?"
          description="One sheet counts one location. Counting a whole business is one sheet per room, so a variance always belongs to a specific pile."
        />
        <CardBody className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-3">
            {SCOPES.map((s) => (
              <SelectableCard
                key={s.id}
                name="scope"
                value={s.id}
                checked={scope === s.id}
                onChange={() => {
                  setScope(s.id)
                  setScopeRefId(0)
                }}
                title={s.label}
                description={s.hint}
              />
            ))}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Location" hint="Where the stock physically is.">
              <Select value={String(locationId)} onChange={(e) => setLocationId(Number(e.target.value))}>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.code} — {l.name}
                  </option>
                ))}
              </Select>
            </Field>

            {needsRef && (
              <Field label={scope === 'department' ? 'Department' : 'Supplier'}>
                <Select value={String(scopeRefId)} onChange={(e) => setScopeRefId(Number(e.target.value))}>
                  <option value="0">Choose one…</option>
                  {refOptions.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}

            <Field label="Reference" hint="Optional — a shelf number, a team name.">
              <Input
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                placeholder="Aisle 4"
                maxLength={60}
              />
            </Field>
          </div>

          {/* Off by default and explained, because switching it on can turn a
              200-line sheet into a 4,000-line one on a big catalogue. */}
          <Switch
            checked={includeZeroStock}
            onChange={setIncludeZeroStock}
            label="Include products the system says are at zero"
            hint="Worth doing when you suspect stock exists that the books have lost track of. It makes the sheet considerably longer."
          />

          {error && <Callout tone="danger" title="Cannot create this sheet">{error}</Callout>}
        </CardBody>
        <CardFooter>
          <Button
            variant="primary"
            onClick={create}
            disabled={pending || !locationId || (needsRef && !scopeRefId)}
          >
            <Icons.ClipboardList size={15} />
            {pending ? 'Building the sheet…' : 'Create sheet'}
          </Button>
        </CardFooter>
      </Card>

      <Callout tone="neutral" icon={<Icons.Info size={18} />}>
        Creating the sheet does not stop the till selling. What the system believes is recorded now,
        and when you post, the difference is measured against the pile at that moment — so anything
        sold while you count is accounted for rather than counted as missing.
      </Callout>
    </>
  )
}
