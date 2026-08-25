'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  Callout,
  Field,
  Icons,
  Input,
  Modal,
  NumberInput,
  Select,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_ROW,
  TABLE_TD_INPUT,
  TABLE_TH,
  useToast,
} from '@/components/ui'
import {
  adjustmentReasonsAction,
  quickAdjustAction,
} from '@/app/(app)/products/actions'

/* This table cannot be a <DataTable>: its cells hold editable level inputs
   rather than rendered values. It wears DataTable's own skin from styles.ts, so
   a change there restyles this too. */
const TH = `${TABLE_TH} px-1.5`
const TD = TABLE_TD_INPUT

/**
 * Stock on hand and reorder levels — every store, every room.
 *
 * ── WHY ONE PANEL AND NOT TWO ─────────────────────────────────────────────
 *
 * This replaces the old Inventory card, which listed one row per STORE. That
 * card could only ever show a store total, and a total is the figure that
 * makes someone think there are 60 available when 57 are in a back warehouse.
 * Stock lives in rooms; a store is just the outer grouping.
 *
 * ── THE TWO AXES ARE NESTED, NOT MERGED ───────────────────────────────────
 *
 * A STORE is a separate site with its own database, matched by product code.
 * A LOCATION is a room inside one of those sites. Every store has its own
 * locations, and two stores can both call a room MAIN — the ids are unrelated
 * and the codes may collide. So rooms are always shown grouped under their
 * store and never flattened into one list, which would silently imply that
 * one store's MAIN is the other's.
 *
 * ── WHAT IS EDITABLE ──────────────────────────────────────────────────────
 *
 * Only THIS store's levels. Stock on hand is read-only everywhere, for the
 * reason it always has been: it is a consequence of receipts, sales and
 * adjustments, so letting the edit form set it would falsify stock valuation.
 * Another store's levels are read-only because this form saves to this
 * database — writing them would need a fan-out that does not exist, and a box
 * that silently discards what you type is worse than a figure you cannot edit.
 */

export type LocationStockRow = {
  locationId: number
  code: string
  name: string
  isMain: boolean
  isActive: boolean
  stockOnHand: number
  minStock: number
  maxStock: number
}

export type StoreLocationStock = {
  siteId: number
  storeName: string
  siteCode?: string
  /** True for the store being edited — the only one whose levels save here. */
  isCurrent: boolean
  /** False when this store does not carry the product at all. */
  carried: boolean
  rows: LocationStockRow[]
}

export default function LocationStockPanel({
  stores,
  isNew,
  productId = null,
  productName = '',
  canAdjust = false,
}: {
  stores: StoreLocationStock[]
  isNew: boolean
  /** The product being edited. Null on the new-product screen, which has no stock. */
  productId?: number | null
  productName?: string
  /**
   * Whether to offer the per-location Adjust button.
   *
   * Resolved by the page, which knows the module and capability — a serial
   * product passes false, because a quantity-only adjustment cannot say WHICH
   * units left the shelf and posting one would break the serial count.
   */
  canAdjust?: boolean
}) {
  /* Before the isNew return on purpose: a hook must run on every render, and
     this one is cheap. */
  const [adjusting, setAdjusting] = useState<LocationStockRow | null>(null)

  // A new product has no stock anywhere yet, and opening stock is captured on
  // the form itself. An empty grid of zeroes would be noise.
  if (isNew) {
    return (
      <div className="flex flex-col gap-3 p-6">
        <p className="text-sm text-muted">
          Opening stock goes into the main location. Once the product is saved, stock received into
          other locations — and other stores — appears here.
        </p>
      </div>
    )
  }

  const grandTotal = stores.reduce(
    (sum, store) => sum + store.rows.reduce((s, row) => s + row.stockOnHand, 0),
    0,
  )
  const multiStore = stores.length > 1

  return (
    <div className="flex flex-col gap-5 p-6">
      {stores.map((store) => {
        const storeTotal = store.rows.reduce((sum, row) => sum + row.stockOnHand, 0)

        return (
          <div key={store.siteId} className="flex flex-col gap-2">
            {/* The store heading only earns its place when there is more than
                one store — otherwise it labels the only thing on screen. */}
            {multiStore && (
              <div className="flex items-baseline gap-2">
                <span className="text-sm font-medium text-ink">{store.storeName}</span>
                {store.siteCode && <span className="text-xs text-muted">{store.siteCode}</span>}
                {store.isCurrent && <Badge tone="neutral">current</Badge>}
                {!store.carried && <Badge tone="warning">not stocked here</Badge>}
                <span className="numeric ml-auto text-sm text-ink-2">
                  {storeTotal.toFixed(3)}
                </span>
              </div>
            )}

            {!store.carried ? (
              <p className="text-sm text-muted">
                This store does not carry the product, so it holds none of it. Switch it on in the
                Stores tab to stock it here.
              </p>
            ) : store.rows.length === 0 ? (
              <p className="text-sm text-muted">
                No stock locations are set up in this store yet.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className={`${TABLE} table-fixed`}>
                  <colgroup>
                    <col />
                    <col className="w-[175px]" />
                    <col className="w-[175px]" />
                    <col className="w-[175px]" />
                  </colgroup>
                  <thead>
                    <tr className={TABLE_HEAD_ROW}>
                      <th className={TH}>Location</th>
                      <th className={TH}>Stock on hand</th>
                      <th className={TH}>Minimum level</th>
                      <th className={TH}>Maximum level</th>
                    </tr>
                  </thead>
                  <tbody>
                    {store.rows.map((row) => (
                      <tr key={row.locationId} className={TABLE_ROW}>
                        <td className={`${TD} text-ink`}>
                          <div className="flex items-center gap-2">
                            <span>
                              {row.code} — {row.name}
                            </span>
                            {row.isMain && <Badge tone="success">Main</Badge>}
                            {!row.isActive && <Badge tone="neutral">Off</Badge>}
                          </div>
                        </td>

                        <td className={TD}>
                          <div className="flex items-center gap-1.5">
                            {/* Same border as an editable control so the row reads
                                as one set of boxes; the tint marks it read-only. */}
                            <div className="numeric h-control min-w-24 flex-1 rounded-control border border-border-strong bg-warning-soft px-3 py-2 text-right text-sm text-ink">
                              {row.stockOnHand.toFixed(3)}
                            </div>
                            {/* type="button": this panel sits INSIDE the product
                                form, and a bare <button> would submit it. */}
                            {store.isCurrent && canAdjust && productId !== null && (
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() => setAdjusting(row)}
                                title={`Adjust stock in ${row.name}`}
                              >
                                Adjust
                              </Button>
                            )}
                          </div>
                        </td>

                        {store.isCurrent ? (
                          <>
                            <td className={TD}>
                              <NumberInput
                                name={`locMinStock_${row.locationId}`}
                                min="0"
                                step="0.001"
                                defaultValue={row.minStock}
                                className="w-full"
                              />
                            </td>
                            <td className={TD}>
                              <NumberInput
                                name={`locMaxStock_${row.locationId}`}
                                min="0"
                                step="0.001"
                                defaultValue={row.maxStock}
                                className="w-full"
                              />
                            </td>
                          </>
                        ) : (
                          <>
                            {/* Another store's levels live in its own database.
                                Shown so they can be compared, read-only because
                                this form cannot write them. */}
                            <td className={TD}>
                              <ReadOnly value={row.minStock} />
                            </td>
                            <td className={TD}>
                              <ReadOnly value={row.maxStock} />
                            </td>
                          </>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )
      })}

      <p className="text-xs text-muted">
        {multiStore ? (
          <>
            Total across every store and location:{' '}
            <span className="numeric text-ink">{grandTotal.toFixed(3)}</span>. Each store keeps its
            own stock and its own locations — only this store&apos;s levels save from here.
          </>
        ) : (
          <>
            Total across all locations:{' '}
            <span className="numeric text-ink">{grandTotal.toFixed(3)}</span>. The till sells from
            the main location only.
          </>
        )}{' '}
        Stock on hand changes through receipts, sales, transfers and adjustments; levels save with
        the product.
      </p>

      <QuickAdjustModal
        row={adjusting}
        productId={productId}
        productName={productName}
        onClose={() => setAdjusting(null)}
      />
    </div>
  )
}

/**
 * Adjust one product at one location, without leaving the product.
 *
 * The whole point is to skip the full adjustment screen when a single shelf is
 * wrong — but it posts through exactly the same path, so the document, its
 * number, the GL mirror and the reversal trail all exist afterwards just as if
 * it had been captured there.
 */
function QuickAdjustModal({
  row,
  productId,
  productName,
  onClose,
}: {
  row: LocationStockRow | null
  productId: number | null
  productName: string
  onClose: () => void
}) {
  const router = useRouter()
  const toast = useToast()

  const [reasons, setReasons] = useState<
    { id: number; name: string; direction: 'in' | 'out' | 'both' }[]
  >([])
  const [loadingReasons, setLoadingReasons] = useState(false)
  const [reasonId, setReasonId] = useState<number | ''>('')
  const [qty, setQty] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, startSave] = useTransition()

  const open = row !== null

  // Fetched when the dialog opens rather than with the page: most visits to a
  // product never adjust anything, and this is a round trip for a list that is
  // only ever read here.
  useEffect(() => {
    if (!open || reasons.length > 0) return
    setLoadingReasons(true)
    void adjustmentReasonsAction()
      .then(setReasons)
      .catch(() => setError('The reasons could not be loaded.'))
      .finally(() => setLoadingReasons(false))
  }, [open, reasons.length])

  // Reopening starts clean. A quantity left over from the last location would
  // be applied to a different shelf.
  useEffect(() => {
    if (!open) {
      setQty('')
      setNote('')
      setReasonId('')
      setError(null)
    }
  }, [open])

  const delta = Number(qty)
  const valid = qty.trim() !== '' && Number.isFinite(delta) && Math.abs(delta) >= 0.0005
  const chosen = reasons.find((r) => r.id === reasonId)

  /*
   * The same direction rule the full screen applies, checked here so the refusal
   * arrives while the number is still on screen rather than after a round trip.
   * The server re-checks: this is a courtesy, not the boundary.
   */
  const directionProblem =
    chosen && valid
      ? chosen.direction === 'out' && delta > 0
        ? `${chosen.name} only writes stock off.`
        : chosen.direction === 'in' && delta < 0
          ? `${chosen.name} only writes stock on.`
          : null
      : null

  const ready = valid && reasonId !== '' && !directionProblem && !saving

  function submit() {
    if (!row || productId === null || reasonId === '') return
    setError(null)
    startSave(async () => {
      const result = await quickAdjustAction({
        productId,
        locationId: row.locationId,
        qtyChange: delta,
        reasonId: Number(reasonId),
        note: note.trim() || undefined,
      })
      if (!result.ok) {
        // Kept in the dialog, not a toast: a locked period or an overdrawn pile
        // is something to correct here, and the numbers are still on screen.
        setError(result.error)
        return
      }
      toast.success(`Stock adjusted — ${result.documentNumber}`)
      onClose()
      // The figure on the row is server-rendered, so it needs a refresh to move.
      router.refresh()
    })
  }

  const after = row && valid ? row.stockOnHand + delta : null

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={row ? `Adjust stock — ${row.name}` : 'Adjust stock'}
      description={productName || undefined}
      size="sm"
      /* Holds a captured figure and a reason; a stray backdrop click must not
         discard them. */
      closeOnBackdrop={false}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="button" variant="primary" disabled={!ready} onClick={submit}>
            {saving ? 'Posting…' : 'Post adjustment'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error && <Callout tone="danger">{error}</Callout>}

        <div className="flex items-baseline justify-between gap-3 rounded-control border border-border bg-surface-2 px-3 py-2 text-sm">
          <span className="text-muted">On hand now</span>
          <span className="numeric text-ink">{row ? row.stockOnHand.toFixed(3) : '—'}</span>
        </div>

        <Field
          label="Gained or lost"
          hint="A positive number writes stock on, a negative one writes it off."
        >
          <NumberInput
            value={qty}
            step="0.001"
            onChange={(e) => setQty(e.target.value)}
            autoFocus
          />
        </Field>

        <Field label="Reason">
          <Select
            value={reasonId}
            onChange={(e) => setReasonId(e.target.value === '' ? '' : Number(e.target.value))}
            disabled={loadingReasons}
          >
            <option value="">{loadingReasons ? 'Loading…' : 'Choose a reason'}</option>
            {reasons.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </Select>
        </Field>

        {directionProblem && <Callout tone="warning">{directionProblem}</Callout>}

        <Field label="Note" hint="Optional — what happened.">
          <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={400} />
        </Field>

        {after !== null && (
          <p className="text-sm text-muted">
            After posting: <span className="numeric text-ink">{after.toFixed(3)}</span>
            {after < 0 && (
              <span className="text-danger"> — that would take the shelf below zero.</span>
            )}
          </p>
        )}
      </div>
    </Modal>
  )
}

function ReadOnly({ value }: { value: number }) {
  return (
    <div className="numeric h-control w-full rounded-control border border-border bg-surface-2 px-3 py-2 text-right text-sm text-faint">
      {value.toFixed(3)}
    </div>
  )
}
