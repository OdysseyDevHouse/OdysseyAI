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
  SegmentedControl,
  Select,
  useToast,
  type ComboboxOption,
} from '@/components/ui'
import { formatMoney, formatQty } from '@/lib/decimals'
import type { TillProduct } from '@/lib/site/tillSearch'
import type { AdjustmentReason } from '@/lib/site/stockAdjustments'
import {
  postNewAdjustmentAction,
  saveDraftAdjustmentAction,
  searchProductsForAdjustmentAction,
  pilesForAdjustmentAction,
  serialsInLocationAction,
} from '../actions'

type LocationOption = { id: number; code: string; name: string; isMain: boolean }

/**
 * How a quantity is typed.
 *
 *   delta  "three broke"       → -3
 *   count  "there are 7 left"  → 7 - onHand
 *
 * Both produce the same signed delta, which is the only thing that posts. The
 * choice exists because people arrive at an adjustment from both directions,
 * and forcing the subtraction by hand is where the mistakes come from.
 */
type EntryMode = 'delta' | 'count'

type AdjLine = {
  key: string
  productId: number
  productCode: string
  description: string
  /** Signed. Negative writes stock off. The authoritative figure. */
  qtyChange: number
  /**
   * The figure typed into count mode, or null when it has not been counted.
   *
   * Tracked separately from qtyChange because a counted zero against an empty
   * pile is a zero delta, and so is an untouched row. Without this the screen
   * cannot tell "I counted, there are none" from "I have not filled this in",
   * and confirming an empty shelf was refused as a blank line.
   */
  countedQty: number | null
  unitCostExcl: number
  /** What this location holds. Null while in flight. */
  onHand: number | null
  reasonId: number | null
  note: string
  isSerial: boolean
  units: { id: number; serial: string }[]
  chosen: number[]
}

/**
 * Capturing an adjustment.
 *
 * The screen's job is to stop an adjustment being attempted that the server will
 * refuse. Writing off 10 from a room holding 3 is rejected at post — so every
 * line shows what the location actually holds and what it will hold afterwards,
 * and a line that would go negative is marked before anyone clicks.
 *
 * Stock is per LOCATION here, never the site total: the total is what makes
 * someone think there are 60 to write off when 57 are in another building.
 */
export default function NewAdjustmentScreen({
  locations,
  reasons,
}: {
  locations: LocationOption[]
  reasons: AdjustmentReason[]
}) {
  const main = locations.find((l) => l.isMain) ?? locations[0]

  const [locationId, setLocationId] = useState<number>(main.id)
  const [reasonId, setReasonId] = useState<number | null>(reasons[0]?.id ?? null)
  const [entryMode, setEntryMode] = useState<EntryMode>('delta')
  const [reference, setReference] = useState('')
  const [note, setNote] = useState('')
  const [lines, setLines] = useState<AdjLine[]>([])
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
      searchProductsForAdjustmentAction(query)
        .then(setOptions)
        .finally(() => setSearching(false))
    }, 180)
    return () => clearTimeout(timer)
  }, [query])

  /**
   * Re-reads every pile when the location changes.
   *
   * Without this, switching location would leave each line showing what a
   * different room held — the figure the user is checking against would
   * silently be about the wrong place.
   */
  useEffect(() => {
    let cancelled = false
    if (lines.length === 0) return

    const productIds = lines.map((l) => l.productId)

    Promise.all([
      pilesForAdjustmentAction(locationId, productIds),
      Promise.all(
        lines.map((line) =>
          line.isSerial ? serialsInLocationAction(line.productId, locationId) : [],
        ),
      ),
    ]).then(([piles, unitLists]) => {
      if (cancelled) return
      const byProduct = new Map(piles.map((p) => [p.productId, p]))

      setLines((current) =>
        current.map((line, i) => {
          const pile = byProduct.get(line.productId)
          const units = unitLists[i] ?? []
          // Anything ticked that is no longer in this room is dropped, and the
          // quantity follows — otherwise switching location would leave a line
          // claiming units that are somewhere else.
          const stillHere = line.chosen.filter((id) => units.some((u) => u.id === id))
          return {
            ...line,
            onHand: pile?.onHand ?? 0,
            unitCostExcl: line.unitCostExcl || (pile?.averageCost ?? 0),
            units,
            chosen: line.isSerial ? stillHere : line.chosen,
            qtyChange: line.isSerial ? -stillHere.length : line.qtyChange,
          }
        }),
      )
    })

    return () => {
      cancelled = true
    }
    // Intentionally keyed on the location and the SET of products, not on
    // `lines` itself — including the whole array would re-fetch on every
    // keystroke in a quantity box.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationId, lines.map((l) => l.productId).join(',')])

  function patch(key: string, changes: Partial<AdjLine>) {
    setLines((current) => current.map((l) => (l.key === key ? { ...l, ...changes } : l)))
  }

  function addProduct(product: TillProduct) {
    if (lines.some((l) => l.productId === product.id)) {
      toast.info(`${product.code} is already on this adjustment.`)
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
        // Zero, not -1: an adjustment has to be typed. Defaulting to a quantity
        // would let somebody post a write-off nobody decided on.
        qtyChange: 0,
        countedQty: null,
        unitCostExcl: product.costExcl,
        onHand: null,
        reasonId: null,
        note: '',
        isSerial: product.productType === 'serial',
        units: [],
        chosen: [],
      },
    ])
    setQuery('')
    setOptions([])
  }

  const location = locations.find((l) => l.id === locationId)
  const docReason = reasons.find((r) => r.id === reasonId) ?? null

  /** What each line is wrong about, or null. One place, so the button and the field agree. */
  function problemWith(line: AdjLine): string | null {
    if (line.isSerial && line.qtyChange > 0) {
      return 'Serial-tracked units cannot be written on here — count them on a stock take.'
    }
    /*
     * A zero line is blank UNLESS it was counted.
     *
     * Counting an empty shelf gives a zero delta and is a real answer — "there
     * are none" — so it is allowed through and simply posts no movement. An
     * untouched row has no countedQty and is still refused, which is what this
     * check was always for.
     */
    if (Math.abs(line.qtyChange) < 0.0005 && line.countedQty === null) {
      return entryMode === 'count'
        ? 'Type what you counted.'
        : 'Say how many were gained or lost.'
    }
    if (line.onHand !== null && line.onHand + line.qtyChange < 0) {
      return `Only ${formatQty(line.onHand)} in ${location?.code}.`
    }
    if (line.isSerial && line.chosen.length !== Math.abs(line.qtyChange)) {
      return 'Tick the units going off the shelf.'
    }
    const effective = line.reasonId ?? reasonId
    if (!effective) return 'Choose a reason.'
    const reason = reasons.find((r) => r.id === effective)
    if (reason && reason.direction === 'out' && line.qtyChange > 0) {
      return `${reason.name} only writes stock off.`
    }
    if (reason && reason.direction === 'in' && line.qtyChange < 0) {
      return `${reason.name} only writes stock on.`
    }
    return null
  }

  const ready = lines.length > 0 && lines.every((l) => problemWith(l) === null)

  function payload() {
    return {
      locationId,
      reasonId,
      reference: reference || null,
      note: note || null,
      lines: lines.map((l) => ({
        productId: l.productId,
        productCode: l.productCode,
        description: l.description,
        qtyBefore: l.onHand ?? 0,
        qtyChange: l.qtyChange,
        countedQty: l.countedQty,
        unitCostExcl: l.unitCostExcl,
        reasonId: l.reasonId,
        note: l.note || null,
        serialIds: l.isSerial ? l.chosen : undefined,
      })),
    }
  }

  function post() {
    startTransition(async () => {
      const result = await postNewAdjustmentAction(payload())
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(`${result.documentNumber} posted — the stock has changed.`)
      router.push(`/adjustments/${result.id}`)
    })
  }

  function saveDraft() {
    startTransition(async () => {
      const result = await saveDraftAdjustmentAction(payload())
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success('Saved as a draft. Nothing has moved yet.')
      router.push(`/adjustments/${result.id}`)
    })
  }

  const comboOptions: ComboboxOption<TillProduct>[] = options.map((p) => ({
    value: String(p.id),
    label: p.description,
    hint: p.code,
    data: p,
  }))

  // Signed, and net. The sign is the information: a bare 12 cannot say whether
  // stock was found or lost.
  const netUnits = lines.reduce((sum, l) => sum + l.qtyChange, 0)
  const netValue = lines.reduce((sum, l) => sum + l.qtyChange * l.unitCostExcl, 0)

  return (
    <PageBody>
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-4 lg:col-span-2">
          <Card>
            <CardHeader
              title="What is being adjusted"
              description="One adjustment adjusts one location, so a variance always belongs to a specific pile."
            />
            <CardBody className="grid gap-4 sm:grid-cols-2">
              <Field label="Location" hint="Where the stock physically is.">
                <Select
                  value={String(locationId)}
                  onChange={(e) => setLocationId(Number(e.target.value))}
                >
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.code} — {l.name}
                      {l.isMain ? ' (main)' : ''}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field
                label="Reason"
                hint="Applies to every line unless a line overrides it."
                error={reasonId ? undefined : 'An adjustment needs a reason.'}
              >
                <Select
                  value={reasonId === null ? '' : String(reasonId)}
                  onChange={(e) =>
                    setReasonId(e.target.value === '' ? null : Number(e.target.value))
                  }
                >
                  <option value="">Choose a reason…</option>
                  {reasons.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label="Reference" hint="Optional — an incident number or bin card.">
                <Input
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                  maxLength={60}
                />
              </Field>

              <Field label="Note" hint="Optional.">
                <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={400} />
              </Field>
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="What changed"
              description="Quantities are checked against what this location actually holds."
              action={
                <SegmentedControl<EntryMode>
                  value={entryMode}
                  onChange={setEntryMode}
                  options={[
                    { value: 'delta', label: 'Gained or lost' },
                    { value: 'count', label: 'New count' },
                  ]}
                />
              }
            />
            <CardBody>
              <Combobox
                options={comboOptions}
                query={query}
                onQueryChange={setQuery}
                onSelect={(option) => option.data && addProduct(option.data)}
                placeholder="Search or scan a product to add a line…"
                loading={searching}
                clearOnSelect
                emptyText={query.trim().length >= 2 ? 'No product matches.' : 'Keep typing…'}
              />
            </CardBody>

            {lines.length === 0 ? (
              <EmptyState
                title="Nothing on this adjustment yet"
                hint="Search for a product above to add the first line."
                icon={<Icons.SlidersHorizontal size={22} />}
              />
            ) : (
              <div className="divide-y divide-border">
                {lines.map((line) => {
                  const problem = problemWith(line)
                  const after = line.onHand === null ? null : line.onHand + line.qtyChange

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

                      <div className="mt-2 grid items-end gap-3 sm:grid-cols-4">
                        {entryMode === 'delta' ? (
                          <Field
                            label="Gained or lost"
                            hint={
                              line.isSerial ? 'Set by the units you tick below.' : 'Negative writes off.'
                            }
                            error={problem ?? undefined}
                          >
                            <NumberInput
                              value={line.qtyChange}
                              precision={3}
                              // A serialised line counts its ticked units.
                              // Typing here would let the two disagree, which
                              // the server refuses anyway.
                              disabled={line.isSerial}
                              // countedQty cleared: a delta typed by hand is not
                              // a count, and leaving a stale one would let a
                              // blank row pass as "counted none".
                              onChange={(e) =>
                                patch(line.key, {
                                  qtyChange: Number(e.target.value) || 0,
                                  countedQty: null,
                                })
                              }
                            />
                          </Field>
                        ) : (
                          <Field
                            label="New count"
                            hint={line.isSerial ? 'Set by the units you tick below.' : 'What is there now.'}
                            error={problem ?? undefined}
                          >
                            <NumberInput
                              value={line.countedQty ?? after ?? 0}
                              precision={3}
                              min="0"
                              disabled={line.isSerial || line.onHand === null}
                              // Both figures move together: the delta is what
                              // posts, countedQty is what says this was counted
                              // — including a count of none on an empty shelf,
                              // which is a zero delta and a real answer.
                              onChange={(e) => {
                                const counted = Number(e.target.value) || 0
                                patch(line.key, {
                                  qtyChange: counted - (line.onHand ?? 0),
                                  countedQty: counted,
                                })
                              }}
                            />
                          </Field>
                        )}

                        <div className="pb-1.5">
                          <div className="text-xs text-muted">In {location?.code}</div>
                          {line.onHand === null ? (
                            <div className="text-sm text-faint">checking…</div>
                          ) : (
                            <div className="numeric text-sm text-ink-2">
                              {formatQty(line.onHand)}
                            </div>
                          )}
                        </div>

                        {/* The figure that stops a doomed adjustment being
                            typed. Danger only when it would go negative —
                            otherwise a plain count with no judgement. */}
                        <div className="pb-1.5">
                          <div className="text-xs text-muted">After</div>
                          {after === null ? (
                            <div className="text-sm text-faint">—</div>
                          ) : after < 0 ? (
                            <Badge tone="danger">{formatQty(after)}</Badge>
                          ) : (
                            <div className="numeric text-sm text-ink-2">{formatQty(after)}</div>
                          )}
                        </div>

                        <Field label="Reason" hint="Optional override.">
                          <Select
                            value={line.reasonId === null ? '' : String(line.reasonId)}
                            onChange={(e) =>
                              patch(line.key, {
                                reasonId: e.target.value === '' ? null : Number(e.target.value),
                              })
                            }
                          >
                            <option value="">
                              {docReason ? `${docReason.name} (document)` : 'Choose a reason…'}
                            </option>
                            {reasons.map((r) => (
                              <option key={r.id} value={r.id}>
                                {r.name}
                              </option>
                            ))}
                          </Select>
                        </Field>
                      </div>

                      {/* Which units are going. A serialised product cannot be
                          written off by quantity alone — the pile would come
                          out right while every unit still read as in stock. */}
                      {line.isSerial && (
                        <div className="mt-3 rounded-card border border-border bg-surface-2 p-3">
                          <div className="mb-2 text-xs text-muted">
                            Tick the units coming off the shelf in {location?.code}
                          </div>
                          {line.units.length === 0 ? (
                            <p className="text-sm text-faint">
                              No units of this product are in {location?.code}.
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
                                        // The quantity IS the tick count, and a
                                        // serial line only ever writes off.
                                        return { ...l, chosen, qtyChange: -chosen.length }
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
            <div className="text-sm text-ink-2">{location?.name}</div>
            <div className="mt-3 flex items-baseline justify-between border-t border-border pt-3">
              <span className="font-medium text-ink">Net units</span>
              <span
                className={`numeric text-xl font-semibold ${netUnits < 0 ? 'text-danger-ink' : 'text-ink'}`}
              >
                {netUnits > 0 ? '+' : ''}
                {formatQty(netUnits)}
              </span>
            </div>
            <div className="mt-2 flex items-baseline justify-between">
              <span className="text-sm text-muted">Value</span>
              <span
                className={`numeric text-sm ${netValue < 0 ? 'text-danger-ink' : 'text-ink-2'}`}
              >
                {formatMoney(netValue)}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted">
              across {lines.length} line{lines.length === 1 ? '' : 's'}
            </p>
          </Card>

          {/* No footnote restating why the button is off: every problem is
              already marked on the line that has it. */}
          <Button variant="primary" disabled={!ready || pending} onClick={post}>
            <Icons.SlidersHorizontal size={16} />
            {pending ? 'Posting…' : 'Post the adjustment'}
          </Button>

          <Button
            variant="secondary"
            disabled={lines.length === 0 || pending}
            onClick={saveDraft}
          >
            <Icons.Save size={16} />
            Save as draft
          </Button>

          <Card className="p-3">
            <p className="text-xs text-muted">
              An adjustment changes what the business owns, and posts the value to stock
              adjustments in the ledger. It does not change what anything cost — only a receipt
              moves cost.
            </p>
          </Card>
        </div>
      </div>
    </PageBody>
  )
}
