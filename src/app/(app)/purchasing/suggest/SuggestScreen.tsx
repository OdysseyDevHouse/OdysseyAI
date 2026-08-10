'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Field,
  Icons,
  NumberInput,
  PageBody,
  Select,
  useToast,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_NUMERIC,
  TABLE_ROW,
  TABLE_TD,
  TABLE_TD_INPUT,
  TABLE_TH,
} from '@/components/ui'
import { formatMoney, formatQty, round } from '@/lib/decimals'
import type { ReorderBasis, SupplierGroup } from '@/lib/site/reorderSuggestions'
import { suggestOrdersAction, createOrdersFromSuggestionAction } from '../actions'

/**
 * What to order, proposed rather than decided.
 *
 * The screen that turns purchasing from data capture into a tool. It never
 * writes anything by itself: every quantity stays editable, and each line shows
 * the figures behind its own suggestion — on hand, on order, sold in the
 * window. A buyer who cannot see WHY will not trust the number, and a
 * replenishment tool nobody trusts gets used once, produces one bad order, and
 * is never opened again.
 *
 * Grouped by supplier because that is how an order is actually raised: not
 * "these forty products" but one order to each of four suppliers.
 */

const BASIS_LABELS: Record<ReorderBasis, string> = {
  below_minimum: 'Below minimum',
  min_to_max: 'Top up to maximum',
  velocity: 'What is selling',
}

const BASIS_HINTS: Record<ReorderBasis, string> = {
  below_minimum: 'Only what has fallen through its floor, topped up to the ceiling.',
  min_to_max: 'Everything under its ceiling, whether or not it is low.',
  velocity: 'Demand measured from sales, projected across the wait for delivery.',
}

export default function SuggestScreen({
  locations,
  suppliers,
  defaultLocationId,
}: {
  locations: { id: number; code: string; name: string }[]
  suppliers: { id: number; code: string; name: string }[]
  defaultLocationId: number
}) {
  const [locationId, setLocationId] = useState(String(defaultLocationId))
  const [basis, setBasis] = useState<ReorderBasis>('below_minimum')
  const [supplierId, setSupplierId] = useState('')
  const [windowDays, setWindowDays] = useState(30)
  const [coverDays, setCoverDays] = useState(14)
  const [groups, setGroups] = useState<SupplierGroup[] | null>(null)
  /** Quantities the buyer has overridden, keyed by product. */
  const [edited, setEdited] = useState<Record<number, number>>({})
  const [pending, startTransition] = useTransition()

  const toast = useToast()
  const router = useRouter()

  function run() {
    startTransition(async () => {
      const result = await suggestOrdersAction({
        locationId: Number(locationId),
        basis,
        supplierId: supplierId ? Number(supplierId) : undefined,
        windowDays,
        coverDays,
      })
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      setGroups(result.groups)
      setEdited({})
      if (result.groups.length === 0) {
        toast.info('Nothing needs ordering on that basis.')
      }
    })
  }

  const qtyFor = (productId: number, suggested: number) => edited[productId] ?? suggested

  /** One draft order per supplier, from what is on screen now. */
  function raise(group: SupplierGroup) {
    if (!group.supplierId) return
    const lines = group.lines
      .map((l) => ({ ...l, qty: qtyFor(l.productId, l.suggested) }))
      .filter((l) => l.qty > 0)

    if (lines.length === 0) {
      toast.error('Every quantity on that supplier is zero.')
      return
    }

    startTransition(async () => {
      const result = await createOrdersFromSuggestionAction({
        supplierId: group.supplierId!,
        lines: lines.map((l) => ({
          productId: l.productId,
          productCode: l.code,
          supplierCode: l.supplierCode,
          description: l.description,
          productType: l.productType,
          qtyOrdered: l.qty,
          unitCostExcl: l.unitCostExcl,
        })),
      })
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(`Draft order raised for ${group.supplierName}.`)
      router.push(`/purchasing/${result.id}/edit`)
    })
  }

  return (
    <PageBody>
      <Card>
        <CardHeader
          title="What to order"
          description="A proposal, not an order. Nothing is written until you raise one."
        />
        <CardBody className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="For which location" hint="Levels and stock are read against it.">
            <Select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.code} — {l.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="On what basis" hint={BASIS_HINTS[basis]}>
            <Select value={basis} onChange={(e) => setBasis(e.target.value as ReorderBasis)}>
              {(Object.keys(BASIS_LABELS) as ReorderBasis[]).map((b) => (
                <option key={b} value={b}>
                  {BASIS_LABELS[b]}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Supplier" hint="Leave blank for every supplier.">
            <Select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
              <option value="">— All —</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.code} — {s.name}
                </option>
              ))}
            </Select>
          </Field>

          {basis === 'velocity' ? (
            <div className="grid grid-cols-2 gap-3">
              <Field label="History" hint="Days.">
                <NumberInput
                  value={windowDays}
                  onChange={(e) => setWindowDays(Number(e.target.value) || 30)}
                />
              </Field>
              <Field label="Cover" hint="Days beyond lead time.">
                <NumberInput
                  value={coverDays}
                  onChange={(e) => setCoverDays(Number(e.target.value) || 0)}
                />
              </Field>
            </div>
          ) : (
            <div className="flex items-end">
              <Button variant="primary" onClick={run} disabled={pending} className="w-full">
                <Icons.Search size={16} />
                {pending ? 'Working…' : 'Suggest'}
              </Button>
            </div>
          )}
        </CardBody>

        {basis === 'velocity' && (
          <CardBody className="pt-0">
            <Button variant="primary" onClick={run} disabled={pending}>
              <Icons.Search size={16} />
              {pending ? 'Working…' : 'Suggest'}
            </Button>
          </CardBody>
        )}
      </Card>

      {groups === null ? (
        <EmptyState
          title="Nothing suggested yet"
          hint="Choose a basis above and press Suggest."
          icon={<Icons.Truck size={22} />}
        />
      ) : groups.length === 0 ? (
        <EmptyState
          title="Nothing needs ordering"
          hint="Every product is at or above its target on that basis, counting what is already on order."
          icon={<Icons.StatusSuccess size={22} />}
        />
      ) : (
        groups.map((group) => {
          const total = group.lines.reduce(
            (sum, l) => round(sum + qtyFor(l.productId, l.suggested) * l.unitCostExcl, 2),
            0,
          )
          const short = group.minimumOrder > 0 && total < group.minimumOrder

          return (
            <Card key={group.supplierId ?? 'none'}>
              <CardHeader
                title={group.supplierName ?? 'No supplier linked'}
                description={
                  group.supplierId
                    ? `${group.lines.length} line${group.lines.length === 1 ? '' : 's'} · ${formatMoney(total)} · usually ${group.leadTimeDays} days`
                    : 'These products have no supplier on file, so no order can be raised for them.'
                }
                action={
                  group.supplierId ? (
                    <Button variant="primary" onClick={() => raise(group)} disabled={pending}>
                      <Icons.Truck size={15} />
                      Raise a draft order
                    </Button>
                  ) : undefined
                }
              />

              {short && (
                <CardBody className="pb-0">
                  <p className="text-xs text-warning">
                    {group.supplierName} usually asks for at least{' '}
                    <span className="numeric">{formatMoney(group.minimumOrder)}</span> — this comes
                    to {formatMoney(total)}.
                  </p>
                </CardBody>
              )}

              <div className="overflow-x-auto">
                <table className={TABLE}>
                  <thead>
                    <tr className={TABLE_HEAD_ROW}>
                      <th scope="col" className={TABLE_TH}>
                        Item
                      </th>
                      <th scope="col" className={`${TABLE_TH} w-24 text-right`}>
                        On hand
                      </th>
                      <th scope="col" className={`${TABLE_TH} w-24 text-right`}>
                        On order
                      </th>
                      {basis === 'velocity' ? (
                        <th scope="col" className={`${TABLE_TH} w-24 text-right`}>
                          Sold
                        </th>
                      ) : (
                        <th scope="col" className={`${TABLE_TH} w-24 text-right`}>
                          Min / max
                        </th>
                      )}
                      <th scope="col" className={`${TABLE_TH} w-24 text-right`}>
                        Target
                      </th>
                      <th scope="col" className={`${TABLE_TH} w-28 text-right`}>
                        Order
                      </th>
                      <th scope="col" className={`${TABLE_TH} w-28 text-right`}>
                        Value
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.lines.map((line) => {
                      const qty = qtyFor(line.productId, line.suggested)
                      return (
                        <tr key={line.productId} className={TABLE_ROW}>
                          <td className={TABLE_TD}>
                            <div className="text-ink">{line.description}</div>
                            <div className="text-xs text-muted">
                              {line.code}
                              {line.packSize > 1 && (
                                <span className="ml-2">packs of {formatQty(line.packSize)}</span>
                              )}
                            </div>
                          </td>
                          <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                            {/* Negative stock is the case worth seeing, not hiding. */}
                            <span className={line.stockOnHand < 0 ? 'text-danger' : ''}>
                              {formatQty(line.stockOnHand)}
                            </span>
                          </td>
                          <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                            {line.onOrder > 0 ? (
                              <Badge tone="neutral">{formatQty(line.onOrder)}</Badge>
                            ) : (
                              <span className="text-faint">—</span>
                            )}
                          </td>
                          <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                            {basis === 'velocity' ? (
                              <span title={`${line.dailyDemand} a day`}>
                                {formatQty(line.soldInWindow)}
                              </span>
                            ) : (
                              <span className="text-muted">
                                {formatQty(line.minStock)} / {formatQty(line.maxStock)}
                              </span>
                            )}
                          </td>
                          <td className={`${TABLE_TD} ${TABLE_NUMERIC} text-muted`}>
                            {formatQty(line.target)}
                          </td>
                          <td className={`${TABLE_TD_INPUT} w-28`}>
                            <NumberInput
                              value={qty}
                              precision={3}
                              aria-label={`Quantity to order of ${line.description}`}
                              onChange={(e) =>
                                setEdited((c) => ({
                                  ...c,
                                  [line.productId]: Number(e.target.value) || 0,
                                }))
                              }
                            />
                          </td>
                          <td className={`${TABLE_TD} ${TABLE_NUMERIC} text-ink`}>
                            {formatMoney(round(qty * line.unitCostExcl, 2))}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          )
        })
      )}
    </PageBody>
  )
}
