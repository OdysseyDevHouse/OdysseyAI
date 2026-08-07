'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  Combobox,
  EmptyState,
  Field,
  Icons,
  Input,
  NumberInput,
  PageBody,
  Select,
  useToast,
  type ComboboxOption,
} from '@/components/ui'
import { formatQty } from '@/lib/decimals'
import type { TillProduct } from '@/lib/site/tillSearch'
import {
  postTransferAction,
  searchProductsForTransferAction,
  locationStockAction,
  serialsInLocationAction,
} from '../actions'

type LocationOption = { id: number; code: string; name: string; isMain: boolean }

type TransferLine = {
  key: string
  productId: number
  productCode: string
  description: string
  qty: number
  unitCostExcl: number
  /** What the FROM location holds. Loaded per line; null while in flight. */
  availableAtSource: number | null
  /**
   * Serial-tracked lines move named units, never a bare quantity — the server
   * refuses anything else. `units` is what the source room holds; `chosen` is
   * what the user has ticked, and the quantity follows its length rather than
   * being typed.
   */
  isSerial: boolean
  units: { id: number; serial: string }[]
  chosen: number[]
}

/**
 * Capturing a transfer.
 *
 * The screen's job is to stop a transfer being attempted that the server will
 * refuse. Moving 10 out of a room holding 3 is rejected at post — so each line
 * shows what the source actually holds, and a line asking for more than that is
 * marked before anyone clicks.
 *
 * Stock on hand is per LOCATION here, never the site total: the total is what
 * makes someone think there are 60 available when 57 of them are in another
 * building.
 */
export default function NewTransferScreen({ locations }: { locations: LocationOption[] }) {
  const main = locations.find((l) => l.isMain) ?? locations[0]
  const other = locations.find((l) => l.id !== main.id) ?? locations[0]

  // Defaults to warehouse → shop rather than the reverse: stock arrives in a
  // back room and moves to where it is sold far more often than the other way.
  const [fromId, setFromId] = useState<number>(other.id)
  const [toId, setToId] = useState<number>(main.id)
  const [reference, setReference] = useState('')
  const [note, setNote] = useState('')
  const [lines, setLines] = useState<TransferLine[]>([])
  const [query, setQuery] = useState('')
  const [options, setOptions] = useState<TillProduct[]>([])
  const [searching, setSearching] = useState(false)
  const [pending, startTransition] = useTransition()

  const toast = useToast()
  const router = useRouter()

  useEffect(() => {
    if (query.trim().length < 2) {
      setOptions([])
      return
    }
    const timer = setTimeout(() => {
      setSearching(true)
      searchProductsForTransferAction(query)
        .then(setOptions)
        .finally(() => setSearching(false))
    }, 180)
    return () => clearTimeout(timer)
  }, [query])

  /**
   * Re-reads every line's source quantity when the FROM location changes.
   *
   * Without this, switching the source would leave each line showing what a
   * different room held — the figure the user is checking against would
   * silently be about the wrong place.
   */
  useEffect(() => {
    let cancelled = false
    if (lines.length === 0) return

    Promise.all(
      lines.map(async (line) => {
        const rows = await locationStockAction(line.productId)
        const available = rows.find((r) => r.locationId === fromId)?.stockOnHand ?? 0
        // Serialised lines need the units themselves, not just the count.
        const units = line.isSerial
          ? await serialsInLocationAction(line.productId, fromId)
          : []
        return { available, units }
      }),
    ).then((results) => {
      if (cancelled) return
      setLines((current) =>
        current.map((line, i) => {
          const result = results[i]
          if (!result) return line
          // Anything ticked that is no longer in this room is dropped, and the
          // quantity follows — otherwise switching the source would leave a
          // line claiming units that are somewhere else.
          const stillHere = line.chosen.filter((id) => result.units.some((u) => u.id === id))
          return {
            ...line,
            availableAtSource: result.available,
            units: result.units,
            chosen: line.isSerial ? stillHere : line.chosen,
            qty: line.isSerial ? stillHere.length : line.qty,
          }
        }),
      )
    })

    return () => {
      cancelled = true
    }
    // Intentionally keyed on the source and the SET of products, not on `lines`
    // itself — including the whole array would re-fetch on every keystroke in a
    // quantity box.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromId, lines.map((l) => l.productId).join(',')])

  function addProduct(product: TillProduct) {
    if (lines.some((l) => l.productId === product.id)) {
      toast.info(`${product.code} is already on this transfer.`)
      setQuery('')
      setOptions([])
      return
    }

    setLines((current) => [
      ...current,
      {
        key: `${product.id}-${Date.now()}`,
        productId: product.id,
        productCode: product.code,
        description: product.description,
        // A serialised line starts at zero: the quantity is the number of
        // units ticked, and defaulting to 1 would claim a unit nobody chose.
        qty: product.productType === 'serial' ? 0 : 1,
        unitCostExcl: product.costExcl,
        availableAtSource: null,
        isSerial: product.productType === 'serial',
        units: [],
        chosen: [],
      },
    ])
    setQuery('')
    setOptions([])
  }

  const overdrawn = lines.filter(
    (l) => l.availableAtSource !== null && l.qty > l.availableAtSource,
  )
  const sameLocation = fromId === toId
  // A serialised line is ready when its ticks and its quantity agree — which
  // they always do here, since the quantity IS the tick count. The check is
  // kept so the button cannot enable on a line with nothing ticked.
  const unpickedSerials = lines.filter((l) => l.isSerial && l.chosen.length === 0)
  const ready =
    lines.length > 0 &&
    !sameLocation &&
    overdrawn.length === 0 &&
    unpickedSerials.length === 0 &&
    lines.every((l) => l.qty > 0)

  function submit() {
    startTransition(async () => {
      const result = await postTransferAction({
        fromLocationId: fromId,
        toLocationId: toId,
        reference: reference || null,
        note: note || null,
        lines: lines.map((l) => ({
          productId: l.productId,
          productCode: l.productCode,
          description: l.description,
          qty: l.qty,
          unitCostExcl: l.unitCostExcl,
          serialIds: l.isSerial ? l.chosen : undefined,
        })),
      })

      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(`${result.documentNumber} posted — the stock has moved.`)
      router.push(`/transfers/${result.id}`)
    })
  }

  const comboOptions: ComboboxOption<TillProduct>[] = options.map((p) => ({
    value: String(p.id),
    label: p.description,
    hint: p.code,
    data: p,
  }))

  const fromLocation = locations.find((l) => l.id === fromId)
  const toLocation = locations.find((l) => l.id === toId)
  const totalUnits = lines.reduce((sum, l) => sum + l.qty, 0)

  return (
    <PageBody>
      <div className="grid gap-4 lg:grid-cols-3">
      <div className="flex flex-col gap-4 lg:col-span-2">
        <Card>
          <CardHeader title="Where it moves" description="Out of one location, into another." />
          <CardBody className="grid gap-4 sm:grid-cols-2">
            <Field label="From">
              <Select value={String(fromId)} onChange={(e) => setFromId(Number(e.target.value))}>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.code} — {l.name}
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              label="To"
              error={
                sameLocation
                  ? 'Stock cannot move to where it already is — choose a different location.'
                  : undefined
              }
            >
              <Select value={String(toId)} onChange={(e) => setToId(Number(e.target.value))}>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.code} — {l.name}
                    {l.isMain ? ' (main)' : ''}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Reference" hint="Optional — a delivery note or vehicle.">
              <Input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={60} />
            </Field>

            <Field label="Note" hint="Optional.">
              <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={400} />
            </Field>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="What moves"
            description="Quantities are checked against what the source location actually holds."
          />
          <CardBody>
            <Combobox
              options={comboOptions}
              query={query}
              onQueryChange={setQuery}
              onSelect={(option) => option.data && addProduct(option.data)}
              placeholder="Search a product to add a line…"
              loading={searching}
              clearOnSelect
              emptyText={query.trim().length >= 2 ? 'No product matches.' : 'Keep typing…'}
            />
          </CardBody>

          {lines.length === 0 ? (
            <EmptyState
              title="Nothing on this transfer yet"
              hint="Search for a product above to add the first line."
              icon={<Icons.ArrowLeftRight size={22} />}
            />
          ) : (
            <div className="divide-y divide-border">
              {lines.map((line) => {
                const short =
                  line.availableAtSource !== null && line.qty > line.availableAtSource

                return (
                  <div key={line.key} className="px-6 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-ink">{line.description}</div>
                        <div className="text-xs text-muted">{line.productCode}</div>
                      </div>
                      <Button
                        variant="bare"
                        size="sm"
                        iconOnly
                        aria-label={`Remove ${line.description}`}
                        onClick={() => setLines((c) => c.filter((l) => l.key !== line.key))}
                      >
                        <Icons.Close size={15} />
                      </Button>
                    </div>

                    <div className="mt-2 grid items-end gap-3 sm:grid-cols-3">
                      <Field
                        label="Quantity"
                        hint={line.isSerial ? 'Set by the units you tick below.' : undefined}
                        error={
                          short
                            ? `Only ${formatQty(line.availableAtSource ?? 0)} in ${fromLocation?.code}.`
                            : undefined
                        }
                      >
                        <NumberInput
                          value={line.qty}
                          precision={3}
                          min="0"
                          // A serialised line counts its ticked units. Typing a
                          // number here would let the two disagree, which the
                          // server refuses anyway.
                          disabled={line.isSerial}
                          onChange={(e) =>
                            setLines((c) =>
                              c.map((l) =>
                                l.key === line.key ? { ...l, qty: Number(e.target.value) || 0 } : l,
                              ),
                            )
                          }
                        />
                      </Field>

                      {/* The figure that stops a doomed transfer being typed.
                          Danger when the line asks for more than exists —
                          otherwise a plain count with no judgement attached. */}
                      <div className="pb-1.5">
                        <div className="text-xs text-muted">In {fromLocation?.code}</div>
                        {line.availableAtSource === null ? (
                          <div className="text-sm text-faint">checking…</div>
                        ) : short ? (
                          <Badge tone="danger">{formatQty(line.availableAtSource)} available</Badge>
                        ) : (
                          <div className="numeric text-sm text-ink-2">
                            {formatQty(line.availableAtSource)}
                          </div>
                        )}
                      </div>

                      <div className="pb-1.5">
                        <div className="text-xs text-muted">After the move</div>
                        <div className="numeric text-sm text-ink-2">
                          {line.availableAtSource === null
                            ? '—'
                            : formatQty(Math.max(line.availableAtSource - line.qty, 0))}
                          {' in '}
                          {fromLocation?.code}
                        </div>
                      </div>
                    </div>

                    {/* Which units are moving. A serialised product cannot be
                        transferred by quantity alone — the pile would come out
                        right while every unit still named the old room. */}
                    {line.isSerial && (
                      <div className="mt-3 rounded-card border border-border bg-surface-2 p-3">
                        <div className="mb-2 text-xs text-muted">
                          Tick the units moving out of {fromLocation?.code}
                        </div>
                        {line.units.length === 0 ? (
                          <p className="text-sm text-faint">
                            No units of this product are in {fromLocation?.code}.
                          </p>
                        ) : (
                          <div className="flex flex-wrap gap-x-4 gap-y-2">
                            {line.units.map((unit) => (
                              <Checkbox
                                key={unit.id}
                                checked={line.chosen.includes(unit.id)}
                                label={unit.serial}
                                onChange={(e) => {
                                  // Native input props are spread by Checkbox,
                                  // so this is an event rather than a boolean.
                                  const ticked = e.target.checked
                                  setLines((c) =>
                                    c.map((l) => {
                                      if (l.key !== line.key) return l
                                      const chosen = ticked
                                        ? [...l.chosen, unit.id]
                                        : l.chosen.filter((id) => id !== unit.id)
                                      // The quantity IS the count of ticks.
                                      return { ...l, chosen, qty: chosen.length }
                                    }),
                                  )
                                }}
                              />
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </Card>
      </div>

      <div className="flex flex-col gap-4">
        <Card className="p-4">
          <div className="flex items-center gap-2 text-sm">
            <span className="text-ink-2">{fromLocation?.code}</span>
            <Icons.ArrowLeftRight size={14} className="text-faint" />
            <span className="text-ink">{toLocation?.code}</span>
          </div>
          <div className="mt-3 flex items-baseline justify-between border-t border-border pt-3">
            <span className="font-medium text-ink">Units moving</span>
            <span className="numeric text-xl font-semibold text-ink">{formatQty(totalUnits)}</span>
          </div>
          <p className="mt-1 text-xs text-muted">
            across {lines.length} line{lines.length === 1 ? '' : 's'}
          </p>
        </Card>

        {/* No footnote restating why the button is off: the location clash and
            an overdrawn line are already marked on their own fields. */}
        <Button variant="primary" disabled={!ready || pending} onClick={submit}>
          <Icons.ArrowLeftRight size={16} />
          {pending ? 'Posting…' : 'Post the transfer'}
        </Button>

        <Card className="p-3">
          <p className="text-xs text-muted">
            A transfer does not change what the business owns, or what anything cost — it changes
            only which location holds it. The till sells from the main location.
          </p>
        </Card>
      </div>
      </div>
    </PageBody>
  )
}
