'use client'

import { useActionState, useState } from 'react'
import {
  Badge,
  Button,
  DataTable,
  EmptyState,
  Field,
  Input,
  Textarea,
  type Column,
} from '@/components/ui'
import { StatusError, StatusSuccess, Plus, Ban } from '@/components/ui/icons'
/* Labels from the client-safe module; the Serial shape is a type-only import,
   which erases at compile time and so cannot drag the pool into the bundle. */
import { SERIAL_LABELS, type SerialStatus } from '@/lib/serialStatus'
import type { Serial } from '@/lib/site/serials'
import {
  addSerialsAction,
  writeOffSerialAction,
  type SerialActionState,
} from '@/app/(app)/products/serialActions'

/**
 * The individual units of a serial-tracked product.
 *
 * Unlike every other tab on this form, these save on their own. A serial is a
 * unit of stock, not a description of the product: capturing fifty off a
 * delivery note and then losing them because an unrelated field failed
 * validation would be indefensible.
 *
 * That independence is why ProductForm renders this panel OUTSIDE its <form>:
 * the two forms below would otherwise be nested inside it, which is invalid
 * HTML and gets silently dropped by the browser. The fields still reach them by
 * `form={id}`, the same trick the Save button uses in the other direction.
 */

const CAPTURE_FORM = 'serial-capture-form'
const WRITEOFF_FORM = 'serial-writeoff-form'

const TONE: Record<SerialStatus, 'success' | 'neutral' | 'warning' | 'danger'> = {
  in_stock: 'success',
  sold: 'neutral',
  returned: 'warning',
  written_off: 'danger',
  // Neutral, not warning: the unit has left the building and been credited, so
  // it needs no decision from anyone here. `returned` keeps the warning because
  // that one is still on a shelf waiting to be dealt with.
  returned_to_supplier: 'neutral',
}

function formatDate(value: Date | string | null): string {
  if (!value) return '—'
  const d = typeof value === 'string' ? new Date(value) : value
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric' })
}

export default function SerialsPanel({
  serials,
  productId,
  stockOnHand,
}: {
  serials: Serial[]
  /** Null on a product that has not been saved yet. */
  productId: number | null
  /** Compared against the in-stock count — the two must agree. */
  stockOnHand: number
}) {
  const empty: SerialActionState = { error: null, message: null }
  const [addState, addAction] = useActionState(addSerialsAction, empty)
  const [offState, offAction] = useActionState(writeOffSerialAction, empty)
  const [writingOff, setWritingOff] = useState<Serial | null>(null)

  if (productId === null) {
    return (
      <div className="p-6">
        <EmptyState
          title="Save the product first"
          hint="Serial numbers attach to individual units of stock, so the product needs to exist before they can be captured. Save it, then come back to this tab."
        />
      </div>
    )
  }

  const inStock = serials.filter((s) => s.status === 'in_stock').length
  const drift = stockOnHand - inStock

  /* Derived from the units themselves rather than taken as a prop: the column
     is worth showing exactly when these units sit in more than one room, and
     that is knowable from the rows already on screen. A site with several
     locations whose units happen to be together still gets one code repeated,
     which is the correct answer to "where is it". */
  const hasLocations = new Set(serials.map((s) => s.locationCode).filter(Boolean)).size > 1

  const columns: Column<Serial>[] = [
    {
      key: 'serial',
      header: 'Serial number',
      cell: (row) => <span className="numeric text-sm text-ink">{row.serial}</span>,
      sortValue: (row) => row.serial,
    },
    {
      key: 'status',
      header: 'Status',
      cell: (row) => <Badge tone={TONE[row.status]}>{SERIAL_LABELS[row.status]}</Badge>,
      sortValue: (row) => row.status,
    },
    /* Where the unit is. Only when there is more than one room — a
       single-location site would get a column repeating the same code on
       every row, which is a column that costs width and says nothing.

       An in-stock unit always has a room; a sold or written-off one has none,
       and the dash is the honest answer rather than a stale shelf. */
    ...(hasLocations
      ? [
          {
            key: 'location',
            header: 'Where',
            cell: (row: Serial) =>
              row.locationCode ? (
                <span className="text-sm text-ink-2">{row.locationCode}</span>
              ) : (
                <span className="text-sm text-faint">—</span>
              ),
            sortValue: (row: Serial) => row.locationCode ?? '',
          },
        ]
      : []),
    {
      key: 'sold',
      header: 'Sold on',
      cell: (row) => (
        <span className="text-sm text-ink-2">
          {row.soldDocNumber ? `${row.soldDocNumber} · ${formatDate(row.soldAt)}` : '—'}
        </span>
      ),
      sortValue: (row) => row.soldAt?.toString() ?? '',
    },
    {
      key: 'customer',
      header: 'Customer',
      cell: (row) => <span className="text-sm text-ink-2">{row.customerName ?? '—'}</span>,
      sortValue: (row) => row.customerName ?? '',
    },
    {
      key: 'warranty',
      header: 'Warranty until',
      cell: (row) => <span className="text-sm text-ink-2">{formatDate(row.warrantyUntil)}</span>,
      sortValue: (row) => row.warrantyUntil ?? '',
    },
  ]

  return (
    <div className="flex flex-col gap-5 p-6">
      <p className="text-sm text-muted">
        Every individual unit of this product. Serials are captured here and marked sold
        automatically when the unit goes out, so the shop can answer “who bought this one” when it
        comes back under warranty.
      </p>

      {/* The second invariant made visible: in-stock serials must equal stock
          on hand. Showing it here means the setup screen answers it rather than
          leaving it for the reconciliation report to find later. */}
      <div className="flex flex-wrap items-center gap-6 rounded-card border border-border p-4">
        <div>
          <span className="block text-xs text-muted">In stock</span>
          <span className="numeric text-lg font-semibold text-ink">{inStock}</span>
        </div>
        <div>
          <span className="block text-xs text-muted">Stock on hand</span>
          <span className="numeric text-lg font-semibold text-ink">
            {stockOnHand.toLocaleString('en-ZA')}
          </span>
        </div>
        {Math.abs(drift) > 0.0005 && (
          <Badge tone="danger">
            {drift > 0
              ? `${drift.toLocaleString('en-ZA')} unit(s) on hand with no serial captured`
              : `${Math.abs(drift).toLocaleString('en-ZA')} serial(s) more than stock on hand`}
          </Badge>
        )}
      </div>

      {addState.error && (
        <p role="alert" className="flex items-center gap-2 rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">
          <StatusError size={15} />
          {addState.error}
        </p>
      )}
      {addState.message && (
        <p className="flex items-center gap-2 rounded-md bg-success-soft px-3 py-2 text-sm text-success-ink">
          <StatusSuccess size={15} />
          {addState.message}
        </p>
      )}

      <div className="flex flex-col gap-4 rounded-card border border-border p-4">
        <span className="text-sm font-medium text-ink">Capture serial numbers</span>

        <Field
          label="Serial numbers"
          hint="One per line, or separated by commas. Duplicates are skipped and named."
        >
          <Textarea
            name="serials"
            form={CAPTURE_FORM}
            rows={4}
            placeholder={'SN-000123\nSN-000124'}
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Cost each (excl. VAT)" hint="Applied to every serial in this batch">
            <Input name="costExcl" form={CAPTURE_FORM} inputMode="decimal" placeholder="0.00" />
          </Field>
          <Field label="Warranty until" hint="Optional — the manufacturer's expiry date">
            <Input name="warrantyUntil" form={CAPTURE_FORM} type="date" />
          </Field>
        </div>

        <div>
          <Button type="submit" form={CAPTURE_FORM} variant="primary">
            <Plus size={15} />
            Add serials
          </Button>
        </div>

        <p className="text-xs text-muted">
          Capturing serials records which units are on the shelf. It does not move stock — receiving
          goods does that, and the two figures are checked against each other above.
        </p>
      </div>

      {serials.length === 0 ? (
        <EmptyState
          title="No serial numbers captured"
          hint="Add the numbers off the delivery note above. A serial product cannot be sold until its units are captured."
        />
      ) : (
        <DataTable
          columns={columns}
          rows={serials}
          getRowKey={(row) => row.id}
          actions={(row) =>
            row.status === 'in_stock' || row.status === 'returned' ? (
              <Button
                type="button"
                variant="danger-ghost"
                size="sm"
                onClick={() => setWritingOff(row)}
              >
                <Ban size={15} />
                Write off
              </Button>
            ) : null
          }
        />
      )}

      {writingOff && (
        <div className="flex flex-col gap-3 rounded-card border border-danger p-4">
          <span className="text-sm font-medium text-ink">
            Write off serial <span className="numeric">{writingOff.serial}</span>
          </span>
          {offState.error && (
            <p role="alert" className="text-sm text-danger">
              {offState.error}
            </p>
          )}
          <Field label="Reason" hint="Lost, stolen or scrapped — kept on the unit's history">
            <Input name="reason" form={WRITEOFF_FORM} maxLength={190} />
          </Field>
          <input type="hidden" name="serialId" form={WRITEOFF_FORM} value={writingOff.id} />
          <div className="flex gap-2">
            <Button type="submit" form={WRITEOFF_FORM} variant="danger">
              Write it off
            </Button>
            <Button type="button" variant="ghost" onClick={() => setWritingOff(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* The real <form> elements the controls above submit into, kept empty
          and separate so each button targets exactly one of them. */}
      <form id={CAPTURE_FORM} action={addAction}>
        <input type="hidden" name="productId" value={productId} />
      </form>
      <form id={WRITEOFF_FORM} action={offAction}>
        <input type="hidden" name="productId" value={productId} />
      </form>
    </div>
  )
}
