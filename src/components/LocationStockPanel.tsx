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
/* From lib/placements.ts and NOT from lib/site/stockBins.ts: that module is
   server-only, so importing a value out of it here would break the client
   bundle. The types below are erased at compile time and are safe either way. */
import { MAX_PLACEMENTS_PER_LOCATION, nextFreeSpot, spotValue } from '@/lib/placements'
import type { LocationBinOptions, ShelfOption } from '@/lib/site/stockBins'
import type { PlacementRef } from '@/lib/site/stockLocations' 

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
  /**
   * Every spot in this room it is kept in (254), primary first.
   *
   * A list because a product can have a pick face AND a bulk pallet in the same
   * room. Absent for another store's rows: its shelves live in its own database
   * and the linked-store query deliberately does not join them, so that a store
   * which has not run 254 yet still returns its stock.
   */
  placements?: PlacementRef[]
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
  binOptions = [],
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
  /**
   * The shelves and bins THIS store has, per location (254).
   *
   * Empty on every site that has never set one up, and the whole Bin column then
   * does not render — not a disabled control, not an empty dropdown, nothing.
   * A feature nobody has switched on should be invisible rather than present and
   * inert, which is just a question the user has to answer before reading the
   * row they came for.
   */
  binOptions?: LocationBinOptions
}) {
  /* Before the isNew return on purpose: a hook must run on every render, and
     these are cheap. */
  const [adjusting, setAdjusting] = useState<LocationStockRow | null>(null)

  /* Which room's bins are being edited, and the working set for every room.
   *
   * The set lives HERE rather than in the dialog because it is what gets
   * submitted: the hidden fields are rendered in the table row, so closing the
   * dialog — or never opening it — must not change what the form sends. The
   * dialog is a view onto this, not the owner of it. */
  const [placing, setPlacing] = useState<LocationStockRow | null>(null)
  const [spots, setSpots] = useState<Record<number, Spot[]>>(() => seedSpots(stores))
  const spotsFor = (locationId: number) => spots[locationId] ?? []
  const shelvesFor = (locationId: number) =>
    binOptions.find((o) => o.locationId === locationId)?.shelves ?? []

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

  /*
   * Whether this table has a Bin column at all.
   *
   * Any shelf anywhere in the site turns it on, rather than a shelf in each
   * location: a column that appeared and disappeared between two rows of the
   * same table would be a table with a ragged shape. A location with no shelves
   * yet renders the cell with nothing to choose, which reads as "none here" —
   * the true answer.
   *
   * Another store's shelves live in its own database, so its rows print whatever
   * placement came back with them and cannot be edited, exactly as its levels
   * cannot.
   */
  const showBins = binOptions.length > 0

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
                    {showBins && <col className="w-[210px]" />}
                    <col className="w-[175px]" />
                    <col className="w-[175px]" />
                    <col className="w-[175px]" />
                  </colgroup>
                  <thead>
                    <tr className={TABLE_HEAD_ROW}>
                      <th className={TH}>Location</th>
                      {/* Directly after Location, because it is part of the
                          answer to WHERE — the numbers that follow are all
                          answers to HOW MANY, and splitting the two kinds
                          apart is what makes the row scannable. */}
                      {showBins && <th className={TH}>Bin</th>}
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

                        {showBins && (
                          <td className={TD}>
                            {store.isCurrent ? (
                              <BinCell
                                locationId={row.locationId}
                                spots={spotsFor(row.locationId)}
                                shelves={shelvesFor(row.locationId)}
                                onEdit={() => setPlacing(row)}
                              />
                            ) : (
                              /* Another store's shelves are in its own database
                                 and are not fetched — see LocationStockRow. */
                              <div className="h-control w-full truncate rounded-control border border-border bg-surface-2 px-3 py-2 text-sm text-faint">
                                —
                              </div>
                            )}
                          </td>
                        )}

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

      <PlacementModal
        row={placing}
        shelves={placing ? shelvesFor(placing.locationId) : []}
        spots={placing ? spotsFor(placing.locationId) : []}
        onChange={(next) =>
          placing && setSpots((all) => ({ ...all, [placing.locationId]: next }))
        }
        onClose={() => setPlacing(null)}
      />

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

/* ── Bins ───────────────────────────────────────────────────────────────── */

/**
 * One spot a product is kept in, as the form carries it.
 *
 * Shelf and bin in one value because shelf-or-bin is a single choice to the
 * person making it: "12" is shelf 12, "12:34" is bin 34 on shelf 12. The server
 * parses exactly this — see readLocationPlacements in products/actions.ts.
 */
type Spot = { shelfId: number; binId: number | null; isPrimary: boolean }

function seedSpots(stores: StoreLocationStock[]): Record<number, Spot[]> {
  const out: Record<number, Spot[]> = {}
  for (const store of stores) {
    if (!store.isCurrent) continue
    for (const row of store.rows) {
      out[row.locationId] = (row.placements ?? []).map((p) => ({
        shelfId: p.shelfId,
        binId: p.binId,
        isPrimary: p.isPrimary,
      }))
    }
  }
  return out
}

/** How a spot reads, given the shelves this room has. */
function labelFor(spot: Spot, shelves: ShelfOption[]): string {
  const shelf = shelves.find((s) => s.shelfId === spot.shelfId)
  if (!shelf) return '(removed)'
  if (spot.binId == null) return shelf.code
  const bin = shelf.bins.find((b) => b.binId === spot.binId)
  return bin ? `${shelf.code} · ${bin.code}` : shelf.code
}

/**
 * The Bin cell: where this product is kept in one room, and the way to change it.
 *
 * ── WHY THE FIELDS ARE HERE AND NOT IN THE DIALOG ──────────────────────────
 *
 * The hidden inputs live in the row, so what the product form submits does not
 * depend on a dialog being open — or on it ever having been opened. A control
 * that exists only while a modal is mounted is a control that silently stops
 * submitting the moment somebody closes it.
 *
 * locBinSet_ is the marker saying this form ASKED about this location. Without
 * it, "no spots" and "the column was hidden" look identical on the server, and
 * one of those must clear the room while the other must leave it alone.
 */
function BinCell({
  locationId,
  spots,
  shelves,
  onEdit,
}: {
  locationId: number
  spots: Spot[]
  shelves: ShelfOption[]
  onEdit: () => void
}) {
  // A room with no shelves has nothing to place anything on. No marker field
  // either: there is nothing to clear, and submitting one would only invite the
  // server to delete rows a site with no shelves cannot have.
  if (shelves.length === 0) {
    return (
      <div className="h-control w-full rounded-control border border-border bg-surface-2 px-3 py-2 text-sm text-faint">
        No shelves here
      </div>
    )
  }

  const primary = spots.find((s) => s.isPrimary) ?? spots[0]
  const others = primary ? spots.filter((s) => s !== primary) : []

  return (
    <div className="flex items-center gap-1.5">
      <input type="hidden" name={`locBinSet_${locationId}`} value="1" />
      {spots.map((spot) => (
        <input
          key={spotValue(spot)}
          type="hidden"
          name={`locBin_${locationId}`}
          value={spotValue(spot)}
        />
      ))}
      {primary && (
        <input type="hidden" name={`locBinPrimary_${locationId}`} value={spotValue(primary)} />
      )}

      {/* type="button": this panel sits INSIDE the product form, and a bare
          <button> would submit it. */}
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={onEdit}
        className="h-control w-full justify-start font-normal"
      >
        {primary ? (
          <span className="truncate">{labelFor(primary, shelves)}</span>
        ) : (
          <span className="truncate text-faint">Not placed</span>
        )}
        {/* The overflow COUNT, not the overflow itself. A cell wide enough to
            list four bins has stopped being a table column, and the number is
            what tells somebody there is more to look at. */}
        {others.length > 0 && (
          <Badge tone="neutral" className="ml-auto">
            +{others.length}
          </Badge>
        )}
      </Button>
    </div>
  )
}

/**
 * Every spot a product is kept in, in one room.
 *
 * ── WHY A DIALOG AND NOT MORE CELLS ────────────────────────────────────────
 *
 * A product with three spots needs three pickers, a way to add a fourth, a way
 * to remove one, and a way to say which is the main one. That does not fit a
 * table cell beside four other columns, and making it fit is what turns a
 * scannable row into a form. The cell shows the answer; this is where the answer
 * gets changed.
 *
 * ── ONE CONTROL FOR TWO LEVELS ─────────────────────────────────────────────
 *
 * Each spot is one Select with an optgroup per shelf, not a shelf dropdown
 * chained to a bin dropdown. Two would mean picking a shelf, waiting for the
 * second to repopulate, then picking a bin — three interactions and a dependency
 * for a field most products set once. Each shelf also offers ITSELF, because a
 * shelf with no numbered slots is a complete answer rather than a half-finished
 * one.
 */
function PlacementModal({
  row,
  shelves,
  spots,
  onChange,
  onClose,
}: {
  row: LocationStockRow | null
  shelves: ShelfOption[]
  spots: Spot[]
  onChange: (next: Spot[]) => void
  onClose: () => void
}) {
  function setSpot(index: number, raw: string) {
    const [shelfRaw, binRaw] = raw.split(':')
    onChange(
      dedupe(
        spots.map((s, i) =>
          i === index
            ? { ...s, shelfId: Number(shelfRaw), binId: binRaw === undefined ? null : Number(binRaw) }
            : s,
        ),
      ),
    )
  }

  function remove(index: number) {
    const next = spots.filter((_, i) => i !== index)
    // Removing the main spot promotes the next one rather than leaving the room
    // with spots but nowhere to send anybody — the count sheet sorts by the main
    // one, so it cannot be left unset.
    if (next.length > 0 && !next.some((s) => s.isPrimary)) next[0] = { ...next[0], isPrimary: true }
    onChange(next)
  }

  /*
   * What "Add another spot" proposes.
   *
   * The first spot in the room the product is NOT already in — never simply the
   * first shelf and bin. Proposing one it already occupies looked exactly like a
   * broken button: dedupe collapsed the repeat, the list came back unchanged, and
   * nothing at all happened on screen.
   *
   * A shelf the product is not on yet is preferred over another slot on one it
   * already occupies, because the reason to want a second spot is nearly always a
   * bulk bay somewhere else. Falling back to any free slot keeps the button
   * honest when every shelf is already used.
   */
  const nextSpot = nextFreeSpot(shelves, spots)

  function add() {
    if (!nextSpot) return
    onChange(dedupe([...spots, { ...nextSpot, isPrimary: spots.length === 0 }]))
  }

  function makePrimary(index: number) {
    onChange(spots.map((s, i) => ({ ...s, isPrimary: i === index })))
  }

  return (
    <Modal
      open={row !== null}
      onClose={onClose}
      title={row ? `Where it is kept — ${row.name}` : 'Where it is kept'}
      description="A product can be kept in more than one place in a room. The main spot is where anyone looking for it gets sent, and the one a stock take sheet is sorted by."
      size="sm"
      /* Holds edits that are not written until the product is saved; a stray
         backdrop click must not discard them. */
      closeOnBackdrop={false}
      footer={
        <Button type="button" variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        {spots.length === 0 && (
          <p className="text-sm text-muted">
            Not placed anywhere in this room yet, so anyone looking for it has to search the
            shelves.
          </p>
        )}

        {spots.map((spot, index) => (
          <div key={spotValue(spot)} className="flex items-center gap-2">
            <Select
              value={spotValue(spot)}
              onChange={(e) => setSpot(index, e.target.value)}
              className="flex-1"
              aria-label={`Spot ${index + 1}`}
            >
              {/* A shelf switched off still appears when the product is ON it —
                  the goods are there whatever the register says about the bay —
                  but it cannot be chosen for anything new. */}
              {shelves
                .filter((shelf) => shelf.isActive || shelf.shelfId === spot.shelfId)
                .map((shelf) => (
                  <optgroup key={shelf.shelfId} label={`${shelf.code} — ${shelf.name}`}>
                    <option value={String(shelf.shelfId)}>
                      {shelf.code} — anywhere on this shelf
                    </option>
                    {shelf.bins
                      .filter((bin) => bin.isActive || bin.binId === spot.binId)
                      .map((bin) => (
                        <option key={bin.binId} value={`${shelf.shelfId}:${bin.binId}`}>
                          {shelf.code} · {bin.code}
                          {bin.name ? ` — ${bin.name}` : ''}
                        </option>
                      ))}
                  </optgroup>
                ))}
            </Select>

            {spot.isPrimary ? (
              <Badge tone="success">Main</Badge>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => makePrimary(index)}
                title="Send anyone looking for it here first"
              >
                Make main
              </Button>
            )}

            <Button
              type="button"
              variant="danger-ghost"
              size="sm"
              iconOnly
              aria-label={`Remove ${labelFor(spot, shelves)}`}
              onClick={() => remove(index)}
            >
              <Icons.Trash size={15} />
            </Button>
          </div>
        ))}

        <div>
          {/* Disabled when there is genuinely nothing left to add, rather than
              staying live and doing nothing — which is what the earlier version
              did, and it read as a broken button. The title says which of the
              two reasons applies. */}
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={add}
            disabled={!nextSpot || spots.length >= MAX_PLACEMENTS_PER_LOCATION}
            title={
              spots.length >= MAX_PLACEMENTS_PER_LOCATION
                ? `A product can be kept in at most ${MAX_PLACEMENTS_PER_LOCATION} places in one room.`
                : !nextSpot
                  ? 'This product is already in every shelf and bin this room has.'
                  : undefined
            }
          >
            <Icons.Plus size={15} />
            Add another spot
          </Button>
        </div>

        <p className="text-xs text-muted">
          Bins say where to look; they hold no quantity of their own. Moving a product to another
          bin changes nothing about what you own, so it posts no stock movement.
        </p>
      </div>
    </Modal>
  )
}

/**
 * Drops repeats of the same shelf-and-bin pair, keeping the first.
 *
 * The database refuses a duplicate outright (uq_placement in 254), so without
 * this, choosing a bin that is already in the list would fail the save with a
 * constraint error after the product had otherwise been written. Collapsing it
 * here makes the second choice a no-op, which is what somebody who picked it
 * twice meant.
 */
function dedupe(spots: Spot[]): Spot[] {
  const seen = new Set<string>()
  const out: Spot[] = []
  for (const spot of spots) {
    const key = spotValue(spot)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(spot)
  }
  if (out.length > 0 && !out.some((s) => s.isPrimary)) out[0] = { ...out[0], isPrimary: true }
  return out
}

function ReadOnly({ value }: { value: number }) {
  return (
    <div className="numeric h-control w-full rounded-control border border-border bg-surface-2 px-3 py-2 text-right text-sm text-faint">
      {value.toFixed(3)}
    </div>
  )
}
