'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Button, Card, CardHeader, CardBody, Field, Icons, Input, useToast } from '@/components/ui'
import type { ProductBarcode } from '@/lib/site/productBarcodes'
import { addBarcodeAction, removeBarcodeAction } from './barcodeActions'

/**
 * The extra barcodes a product answers to — the 6-pack code, the old supplier
 * code. Self-saving (each add/remove is its own round trip), like every other
 * panel in the generalExtras slot: it lives outside the product's <form>.
 *
 * The MAIN barcode stays on the General tab's own field; this list is the
 * aliases, strictly unique across the shop, which is what makes an alias scan
 * deterministic.
 */
export default function BarcodesPanel({
  productId,
  initial,
}: {
  productId: number
  initial: ProductBarcode[]
}) {
  const toast = useToast()
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [rows, setRows] = useState(initial)
  const [barcode, setBarcode] = useState('')
  const [note, setNote] = useState('')

  function add() {
    const code = barcode.trim()
    if (!code) return
    startTransition(async () => {
      const result = await addBarcodeAction(productId, code, note.trim() || undefined)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      setRows((r) =>
        [...r, { id: result.id, productId, barcode: code, note: note.trim() || null }].sort((a, b) =>
          a.barcode.localeCompare(b.barcode),
        ),
      )
      setBarcode('')
      setNote('')
      toast.success(`${code} added.`)
      router.refresh()
    })
  }

  function remove(row: ProductBarcode) {
    startTransition(async () => {
      const result = await removeBarcodeAction(productId, row.id)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      setRows((r) => r.filter((x) => x.id !== row.id))
      toast.success(`${row.barcode} removed.`)
      router.refresh()
    })
  }

  return (
    <Card>
      <CardHeader
        title="Extra barcodes"
        description="Other codes this product scans as — a 6-pack code, an old supplier code. The main barcode stays on the General tab."
      />
      <CardBody>
        {rows.length === 0 ? (
          <p className="text-sm text-muted">Only the main barcode is on file.</p>
        ) : (
          <ul className="mb-3 flex flex-col gap-1.5">
            {rows.map((row) => (
              <li
                key={row.id}
                className="flex items-center justify-between gap-3 rounded-control border border-border px-3 py-1.5"
              >
                <span className="min-w-0">
                  <span className="numeric text-sm text-ink">{row.barcode}</span>
                  {row.note && <span className="ml-2 text-xs text-muted">{row.note}</span>}
                </span>
                <Button
                  variant="danger-ghost"
                  size="sm"
                  iconOnly
                  aria-label={`Remove ${row.barcode}`}
                  disabled={pending}
                  onClick={() => remove(row)}
                >
                  <Icons.Trash size={14} />
                </Button>
              </li>
            ))}
          </ul>
        )}

        <div className="flex flex-wrap items-end gap-2">
          <Field label="Barcode" className="w-56">
            <Input
              value={barcode}
              onChange={(e) => setBarcode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  add()
                }
              }}
              placeholder="Scan or type it"
            />
          </Field>
          <Field label="Note (optional)" className="w-44">
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. 6-pack"
              maxLength={60}
            />
          </Field>
          <Button variant="secondary" disabled={pending || !barcode.trim()} onClick={add}>
            <Icons.Plus size={15} />
            Add
          </Button>
        </div>
      </CardBody>
    </Card>
  )
}
