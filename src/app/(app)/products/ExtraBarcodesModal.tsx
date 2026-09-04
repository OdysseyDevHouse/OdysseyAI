'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Button, Field, Icons, Input, Modal, useToast } from '@/components/ui'
import type { ProductBarcode } from '@/lib/site/productBarcodes'
import { addBarcodeAction, removeBarcodeAction } from './barcodeActions'

/**
 * The extra barcodes a product answers to — the 6-pack code, the old supplier
 * code — reached from the chevron beside the Barcode field.
 *
 * ── WHY A DIALOG AND NOT A PANEL ──────────────────────────────────────────
 *
 * This was a card sitting open on the General tab, and it was there on every
 * visit for every product — while the great majority of products have exactly
 * one barcode and nothing to say. A permanently open panel for an occasional
 * exception is a tab that is longer than it needs to be, every time.
 *
 * Behind the chevron it is one click away for the products that need it and
 * invisible for the ones that do not. The count on the menu entry is what
 * makes that safe: a product WITH aliases still says so without being opened.
 *
 * Self-saving, as it was: each add and remove is its own round trip, because
 * this list is not part of the product's <form> and never was. That is also
 * why it is safe to close mid-edit — there is no unsaved state to lose.
 */
export default function ExtraBarcodesModal({
  open,
  onClose,
  productId,
  rows,
  onRowsChange,
}: {
  open: boolean
  onClose: () => void
  productId: number
  /** Held by the caller so the chevron's menu can show the count. */
  rows: ProductBarcode[]
  onRowsChange: (next: ProductBarcode[]) => void
}) {
  const toast = useToast()
  const router = useRouter()
  const [pending, startTransition] = useTransition()
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
      onRowsChange(
        [...rows, { id: result.id, productId, barcode: code, note: note.trim() || null }].sort(
          (a, b) => a.barcode.localeCompare(b.barcode),
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
      onRowsChange(rows.filter((x) => x.id !== row.id))
      toast.success(`${row.barcode} removed.`)
      router.refresh()
    })
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Extra barcodes"
      description="Other codes this product scans as. The main barcode stays on the General tab."
      size="md"
      footer={
        <Button variant="secondary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="space-y-4">
        {rows.length === 0 ? (
          <p className="text-sm text-muted">
            Only the main barcode is on file. Add a code below and this product will scan as that
            one too.
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
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

        {/* The add row, separated by a rule: everything above is what is on
            file, everything below adds to it. */}
        <div className="flex flex-wrap items-end gap-2 border-t border-border pt-4">
          <Field label="Barcode" className="w-52">
            <Input
              value={barcode}
              onChange={(e) => setBarcode(e.target.value)}
              autoComplete="off"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  add()
                }
              }}
              placeholder="Scan or type it"
            />
          </Field>
          <Field label="Note (optional)" className="w-40">
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
      </div>
    </Modal>
  )
}
