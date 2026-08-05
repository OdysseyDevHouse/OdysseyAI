'use client'

import { useState, useTransition } from 'react'
import {
  Badge,
  Button,
  Combobox,
  EmptyState,
  Input,
  NumberInput,
  Radio,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_NUMERIC,
  TABLE_TD,
  TABLE_TH,
  type ComboboxOption,
} from '@/components/ui'
import { Trash } from '@/components/ui/icons'
import type { ProductSupplier } from '@/lib/site/productSuppliers'
import {
  searchSuppliersAction,
  type SupplierPick,
} from '@/app/(app)/products/pickerActions'

/**
 * Who this product is bought from, and what they call it.
 *
 * The supplier's own stock code is the point: it is what goes on the purchase
 * order, and it is almost never our code. Capturing it here means the first
 * order can carry the right reference instead of waiting for a delivery to
 * teach the system what it is.
 *
 * `lastCost` is editable for the same reason — a shop loading its supplier list
 * off a price sheet has a real cost and no delivery yet. Receiving overwrites
 * it afterwards, which is correct: that is what was actually paid.
 *
 * Rows submit as parallel arrays, so deleting one from the middle leaves no
 * index gap for the action to trip over.
 */

type Row = {
  key: string
  supplierId: number
  supplierName: string
  supplierAccountCode: string
  supplierCode: string
  lastCost: number
  packSize: number
}

function toRow(link: ProductSupplier): Row {
  return {
    key: `saved-${link.supplierId}`,
    supplierId: link.supplierId,
    supplierName: link.supplierName,
    supplierAccountCode: link.supplierAccountCode,
    supplierCode: link.supplierCode ?? '',
    lastCost: link.lastCost,
    packSize: link.packSize || 1,
  }
}

export default function ProductSuppliersPanel({
  links,
}: {
  /** The product's suppliers as saved. Empty if it has none yet. */
  links: ProductSupplier[]
}) {
  const [rows, setRows] = useState<Row[]>(() => links.map(toRow))
  const [preferred, setPreferred] = useState<number | null>(
    () => links.find((l) => l.isPreferred)?.supplierId ?? null,
  )
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SupplierPick[]>([])
  const [searching, startSearch] = useTransition()

  function search(next: string) {
    setQuery(next)
    startSearch(async () => {
      setResults(await searchSuppliersAction(next))
    })
  }

  function add(pick: SupplierPick) {
    setRows((prev) => {
      if (prev.some((r) => r.supplierId === pick.id)) return prev
      // The first supplier linked becomes the preferred one — with only one,
      // any other answer is wrong, and it saves a click in the common case.
      if (prev.length === 0) setPreferred(pick.id)
      return [
        ...prev,
        {
          key: `new-${pick.id}`,
          supplierId: pick.id,
          supplierName: pick.name,
          supplierAccountCode: pick.code,
          supplierCode: '',
          lastCost: 0,
          packSize: 1,
        },
      ]
    })
    setQuery('')
    setResults([])
  }

  const update = (key: string, patch: Partial<Row>) =>
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)))

  function remove(key: string) {
    setRows((prev) => {
      const row = prev.find((r) => r.key === key)
      // Removing the preferred supplier must clear the flag too, or the save
      // would carry a preference for a supplier that is no longer linked.
      if (row && row.supplierId === preferred) setPreferred(null)
      return prev.filter((r) => r.key !== key)
    })
  }

  const options: ComboboxOption<SupplierPick>[] = results.map((s) => ({
    value: String(s.id),
    label: s.name,
    hint: s.code,
    trailing: s.canOrder ? undefined : <Badge tone="warning">on hold</Badge>,
    disabled: rows.some((r) => r.supplierId === s.id),
    data: s,
  }))

  return (
    <div className="flex flex-col gap-4 p-6">
      <p className="text-sm text-muted">
        Who this product is bought from. The supplier&apos;s own stock code goes on the purchase
        order, so capturing it here means the first order carries the right reference.
      </p>

      {/* Always submitted, empty when nothing is linked — an absent field would
          read as "this tab never rendered" and leave the old rows in place. */}
      <input type="hidden" name="supplierPreferred" value={preferred ?? ''} />

      <div className="max-w-md">
        <Combobox
          options={options}
          query={query}
          onQueryChange={search}
          onSelect={(option) => option.data && add(option.data)}
          loading={searching}
          placeholder="Search a supplier to link…"
          emptyText="No suppliers match"
        />
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title="No suppliers linked"
          hint="Search above to link the suppliers this product is bought from, and record their stock code and price."
        />
      ) : (
        /* Hand-built because the cells hold live inputs, which DataTable cannot
           express — wearing the kit's shared table skin so it still matches. */
        <div className="overflow-x-auto">
          <table className={TABLE}>
            <thead>
              <tr className={TABLE_HEAD_ROW}>
                <th className={TABLE_TH}>Supplier</th>
                <th className={TABLE_TH}>Their stock code</th>
                <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Price (excl. VAT)</th>
                <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Pack size</th>
                <th className={TABLE_TH}>Preferred</th>
                <th className={TABLE_TH}>
                  <span className="sr-only">Remove</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key}>
                  <td className={TABLE_TD}>
                    <span className="block text-sm text-ink">{row.supplierName}</span>
                    <span className="block text-xs text-muted">{row.supplierAccountCode}</span>
                    <input type="hidden" name="supplierId" value={row.supplierId} />
                    <input type="hidden" name="supplierCode" value={row.supplierCode} />
                    <input type="hidden" name="supplierCost" value={row.lastCost} />
                    <input type="hidden" name="supplierPackSize" value={row.packSize} />
                  </td>
                  <td className={TABLE_TD}>
                    <Input
                      aria-label={`Stock code at ${row.supplierName}`}
                      value={row.supplierCode}
                      maxLength={48}
                      placeholder="Their code"
                      onChange={(e) => update(row.key, { supplierCode: e.target.value })}
                      className="w-40"
                    />
                  </td>
                  <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                    <NumberInput
                      aria-label={`Price from ${row.supplierName}`}
                      value={row.lastCost}
                      onChange={(e) => update(row.key, { lastCost: Number(e.target.value) })}
                      className="w-28"
                    />
                  </td>
                  <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                    <NumberInput
                      aria-label={`Pack size from ${row.supplierName}`}
                      value={row.packSize}
                      onChange={(e) => update(row.key, { packSize: Number(e.target.value) })}
                      className="w-24"
                    />
                  </td>
                  <td className={TABLE_TD}>
                    {/* Not submitted directly: the hidden field above carries the
                        choice, so exactly one id arrives however this is clicked. */}
                    <Radio
                      name="supplierPreferredChoice"
                      aria-label={`Prefer ${row.supplierName}`}
                      checked={preferred === row.supplierId}
                      onChange={() => setPreferred(row.supplierId)}
                    />
                  </td>
                  <td className={TABLE_TD}>
                    <Button
                      type="button"
                      variant="danger-ghost"
                      size="sm"
                      iconOnly
                      aria-label={`Remove ${row.supplierName}`}
                      onClick={() => remove(row.key)}
                    >
                      <Trash size={15} />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {rows.length > 0 && (
        <p className="text-xs text-muted">
          The price here is a starting figure. Receiving goods updates it to what was actually paid.
        </p>
      )}
    </div>
  )
}
