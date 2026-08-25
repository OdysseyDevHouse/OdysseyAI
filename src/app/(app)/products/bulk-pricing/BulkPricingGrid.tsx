'use client'

import { useMemo, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  BulkActionBar,
  Button,
  Checkbox,
  CurrencyInput,
  NumberInput,
  Select,
  TABLE_FRAME,
  TABLE_HEAD_ROW,
  TABLE_HEAD_STICKY,
  TABLE_NUMERIC,
  TABLE_SCROLLER,
  TABLE_TD,
  TABLE_TD_INPUT,
  TABLE_TH,
  TABLE_ROW,
  useFitViewport,
  useToast,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import {
  addVat,
  removeVat,
  gpPercent,
  markupPercent,
  sellExclFromGp,
  sellExclFromMarkup,
  type CostBasis,
} from '@/lib/pricing'
import type { EndingDirection } from '@/lib/repricing'
import type { BulkPricingRow } from '@/lib/site/bulkPricing'
import { saveBulkPricesAction } from './actions'
import ApplyRuleModal from './ApplyRuleModal'

/**
 * Editing a page of selling prices, one product per line.
 *
 * ── WHY THIS IS NOT A <DataTable> ─────────────────────────────────────
 * Its cells hold live cross-computing inputs rather than rendered values:
 * typing a markup moves the selling price, which moves the GP. DataTable's
 * `cell: (row) => ReactNode` cannot express that. So the table is hand-built
 * and wears DataTable's own skin from styles.ts — TABLE_TH, TABLE_TD_INPUT,
 * TABLE_ROW — and a restyle there carries here. This is the same arrangement
 * PricingPanel and PurchaseLineGrid use, for the same reason.
 *
 * ── ONE STORED NUMBER PER ROW ─────────────────────────────────────────
 * Only the VAT-inclusive selling price is state. Markup, GP and the exclusive
 * price are views of it, recomputed on every render, and each one converts
 * backwards into an inclusive price on change. Holding four numbers and trying
 * to keep them in step is how they drift apart; PricingPanel settled this and
 * this screen follows it.
 */

/** What a row can have pending. Absent field = untouched, and never sent. */
type RowEdit = {
  priceIncl?: number
  lastCost?: number
  purchaseVatRateId?: number | null
  sellingVatRateId?: number | null
}

type Props = {
  rows: BulkPricingRow[]
  /** The tax rates a person may pick, split by what they apply to. */
  purchaseVatRates: VatRateOption[]
  sellingVatRates: VatRateOption[]
  structureId: number
  structureName: string
  costBasis: CostBasis
  /** Cost, markup and GP columns are hidden without products.cost. */
  showCost: boolean
  /** The site's price_ending_direction, as the rule dialog's starting choice. */
  defaultEndingDirection: EndingDirection
}

export type VatRateOption = { id: number; rate: number; code: string }

/**
 * The percentage a row is working at right now.
 *
 * Takes the pending rate id when one has been chosen, otherwise the product's
 * own — and falls back to the percentage the server sent, which is what a
 * product with no rate at all (or one no longer active) reads as.
 */
function rateOf(
  rates: VatRateOption[],
  pendingId: number | null | undefined,
  storedId: number | null,
  storedPercent: number,
): number {
  const id = pendingId !== undefined ? pendingId : storedId
  if (id === null) return 0
  return rates.find((r) => r.id === id)?.rate ?? storedPercent
}

export default function BulkPricingGrid({
  rows,
  purchaseVatRates,
  sellingVatRates,
  structureId,
  structureName,
  costBasis,
  showCost,
  defaultEndingDirection,
}: Props) {
  const router = useRouter()
  const toast = useToast()
  const [saving, startSave] = useTransition()

  /* Edits only, and only the FIELDS that moved. A row the user has not touched
     is absent, which is what makes "13 changed" honest and keeps the save down
     to what actually moved. */
  const [edits, setEdits] = useState<Record<number, RowEdit>>({})

  const scrollRef = useRef<HTMLDivElement>(null)
  const cap = useFitViewport(scrollRef)

  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set())
  const [ruleOpen, setRuleOpen] = useState(false)

  function toggleRow(id: number) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const allSelected = rows.length > 0 && selected.size === rows.length

  /**
   * Arrow keys and Enter move between price cells, as a spreadsheet does.
   *
   * Up/Down step the same column through the rows; Enter does the same, since
   * that is what a person filling a column presses without thinking. Left and
   * Right are LEFT ALONE when the caret can still move inside the number —
   * hijacking them would make it impossible to fix the middle of "1234.00" —
   * and only cross to the next cell from the very start or end of the text.
   *
   * Tab is untouched: the browser's own order already walks the row correctly.
   */
  function moveBetweenCells(event: React.KeyboardEvent<HTMLTableElement>) {
    const el = event.target
    if (!(el instanceof HTMLInputElement) || el.type === 'checkbox') return

    const key = event.key
    if (key !== 'ArrowUp' && key !== 'ArrowDown' && key !== 'Enter' && key !== 'ArrowLeft' && key !== 'ArrowRight') {
      return
    }

    const cell = el.closest('td')
    const row = el.closest('tr')
    if (!cell || !row) return

    const table = event.currentTarget
    const bodyRows = [...table.querySelectorAll('tbody tr')]
    const rowIndex = bodyRows.indexOf(row)
    const cellIndex = [...row.children].indexOf(cell)

    // Horizontal only from the edge of the text, so editing stays possible.
    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      const caret = el.selectionStart ?? 0
      const end = el.value.length
      const atStart = caret === 0 && el.selectionEnd === 0
      const atEnd = caret === end && el.selectionEnd === end
      if (key === 'ArrowLeft' && !atStart) return
      if (key === 'ArrowRight' && !atEnd) return

      const sibling = [...row.children]
      const step = key === 'ArrowLeft' ? -1 : 1
      for (let i = cellIndex + step; i >= 0 && i < sibling.length; i += step) {
        const next = sibling[i].querySelector<HTMLInputElement>('input:not([type="checkbox"]):not([disabled])')
        if (next) {
          event.preventDefault()
          next.focus()
          next.select()
          return
        }
      }
      return
    }

    const step = key === 'ArrowUp' ? -1 : 1
    const targetRow = bodyRows[rowIndex + step]
    if (!targetRow) return

    const target = targetRow.children[cellIndex]?.querySelector<HTMLInputElement>(
      'input:not([type="checkbox"]):not([disabled])',
    )
    if (!target) return

    event.preventDefault()
    target.focus()
    target.select()
  }

  /* A rule's results land as PENDING edits, not a write — the user reads them
     in the grid and can still change any row or discard the lot. */
  function applyRuleResults(
    priced: { productId: number; priceIncl: number }[],
    ruleSkipped: { code: string; reason: string }[],
  ) {
    setEdits((prev) => {
      const next = { ...prev }
      for (const p of priced) {
        const was = original.get(p.productId)
        const current: RowEdit = { ...(next[p.productId] ?? {}) }
        // Same un-dirtying rule as a typed edit: a rule that works out to the
        // price already on the row is not a change. Any cost or tax edit
        // already pending on that row is left alone.
        if (was !== null && was !== undefined && Math.abs(was - p.priceIncl) < 0.00005) {
          delete current.priceIncl
        } else {
          current.priceIncl = p.priceIncl
        }
        if (Object.keys(current).length === 0) delete next[p.productId]
        else next[p.productId] = current
      }
      return next
    })

    if (ruleSkipped.length > 0) {
      toast.info(
        `${priced.length} priced, ${ruleSkipped.length} left alone — ${ruleSkipped[0].reason.toLowerCase()}${
          ruleSkipped.length > 1 ? ' and others' : ''
        }.`,
      )
    } else {
      toast.success(`${priced.length} ${priced.length === 1 ? 'price' : 'prices'} worked out. Check them, then save.`)
    }
    setSelected(new Set())
  }

  const original = useMemo(() => {
    const map = new Map<number, number | null>()
    for (const r of rows) map.set(r.id, r.sellingIncl)
    return map
  }, [rows])

  const dirtyCount = Object.keys(edits).length

  /* Whether the delta column has anything to show. A cost-only edit does not
     move a PRICE, so it must not widen the column that holds old prices. */
  const anyPriceEdited = Object.values(edits).some((e) => e.priceIncl !== undefined)

  /* Cost is only editable when this site PRICES off last cost. On the average
     basis the margins are measured against average_cost, which is a
     consequence of purchases and deliberately not writable — an editable box
     there would take a number and appear to do nothing. */
  const costEditable = costBasis === 'last'
  const costLabel = costEditable ? 'Cost' : 'Avg cost'

  /* Counted over the row as it now STANDS, not just its price: an edited cost
     can put a price under water without the price itself being touched. */
  const belowCostCount = useMemo(
    () =>
      rows.filter((r) => {
        const e = edits[r.id]
        if (!e) return false
        /* The same basis the row itself shows: the edited last cost on a
           last-cost site, otherwise the stored basis. Comparing an edited last
           cost against an average-cost row would flag products the row is not
           actually pricing from. */
        const cost =
          e.lastCost !== undefined && costEditable
            ? e.lastCost
            : costEditable
              ? r.lastCost
              : r.costExcl
        const incl = e.priceIncl !== undefined ? e.priceIncl : r.sellingIncl
        if (cost <= 0 || incl === null) return false
        const vat = rateOf(sellingVatRates, e.sellingVatRateId, r.sellingVatRateId, r.sellingVatPercent)
        return removeVat(incl, vat) < cost
      }).length,
    [rows, edits, sellingVatRates, costEditable],
  )

  /**
   * One field of one row, changed.
   *
   * A field set back to what it was is REMOVED rather than stored — borrowed
   * from BudgetGrid — and a row whose last changed field goes back drops out
   * of `edits` entirely. That is what keeps the footer count honest after
   * somebody changes their mind, and keeps the save down to what actually
   * moved: an untouched cost is never sent, so this screen cannot overwrite a
   * cost someone else changed while it was open.
   */
  /* `next` may legitimately be null — clearing a tax rate is a real choice, and
     distinct from leaving the field untouched, which is `undefined`. */
  function setField<K extends keyof RowEdit>(
    row: BulkPricingRow,
    field: K,
    next: RowEdit[K],
    was: RowEdit[K],
  ) {
    setEdits((prev) => {
      const current: RowEdit = { ...(prev[row.id] ?? {}) }
      const same =
        typeof next === 'number' && typeof was === 'number'
          ? Math.abs(was - next) < 0.00005
          : was === next

      if (same) delete current[field]
      else current[field] = next

      const copy = { ...prev }
      if (Object.keys(current).length === 0) delete copy[row.id]
      else copy[row.id] = current
      return copy
    })
  }

  /** The value on screen: the pending edit if there is one, else what is stored. */
  function valueFor(row: BulkPricingRow): {
    priceIncl: number | null
    lastCost: number
    purchaseVatRateId: number | null
    sellingVatRateId: number | null
  } {
    const e = edits[row.id] ?? {}
    return {
      priceIncl: e.priceIncl !== undefined ? e.priceIncl : row.sellingIncl,
      lastCost: e.lastCost !== undefined ? e.lastCost : row.lastCost,
      purchaseVatRateId:
        e.purchaseVatRateId !== undefined ? e.purchaseVatRateId : row.purchaseVatRateId,
      sellingVatRateId:
        e.sellingVatRateId !== undefined ? e.sellingVatRateId : row.sellingVatRateId,
    }
  }

  function save() {
    const payload = Object.entries(edits).map(([id, e]) => ({
      productId: Number(id),
      ...e,
    }))
    if (payload.length === 0) return

    startSave(async () => {
      const result = await saveBulkPricesAction(structureId, payload)
      if (result.updated === 0) {
        toast.error(
          result.skipped[0]?.reason ?? 'Nothing was saved.',
        )
      } else if (result.skipped.length > 0) {
        toast.info(`${result.updated} saved, ${result.skipped.length} skipped.`)
      } else {
        toast.success(`${result.updated} ${result.updated === 1 ? 'product' : 'products'} saved.`)
      }
      setEdits({})
      router.refresh()
    })
  }


  return (
    <div className="flex min-h-0 flex-col">
      <BulkActionBar count={selected.size} onClear={() => setSelected(new Set())}>
        <Button size="sm" variant="secondary" onClick={() => setRuleOpen(true)}>
          Apply a rule
        </Button>
      </BulkActionBar>

      <ApplyRuleModal
        open={ruleOpen}
        onClose={() => setRuleOpen(false)}
        rows={rows.filter((r) => selected.has(r.id))}
        defaultEndingDirection={defaultEndingDirection}
        onApply={applyRuleResults}
      />

      {/* Capped to the room left below it, MEASURED — the save bar under this
          box is trailing chrome that useFitViewport accounts for. Without the
          cap the box grew to all fifty rows and pushed Save 2 200px past the
          fold, so the button was unreachable until you had scrolled the whole
          page. A fixed max-height would be right on exactly one screen size. */}
      {/* The gutter lives on this static frame, not on the scroll box inside
          it — the same arrangement DataTable uses. On the box it would scroll
          with the content and leave the sticky header floating a gutter down.
          Without it the table ran flush to both edges, and an overlay
          scrollbar (which reserves no width) sat on top of the last column. */}
      <div className={TABLE_FRAME}>
        <div ref={scrollRef} className={TABLE_SCROLLER} style={{ maxHeight: cap }}>
        {/* Keyboard movement is handled ONCE here rather than on every cell:
            the inputs are remounted by their keys as prices recompute, and a
            handler bound per input would be re-created on each of those. The
            event bubbles, so one listener on the table serves every box. */}
        <table
          className="w-full table-fixed border-collapse"
          onKeyDown={moveBetweenCells}
        >
          {/* Fixed columns so every input box is the same width down the page —
              a ragged column of price fields is unreadable at fifty rows. */}
          <colgroup>
            <col className="w-[56px]" />
            <col className="w-[120px]" />
            <col />
            {showCost && <col className="w-[112px]" />}
            {showCost && <col className="w-[84px]" />}
            {showCost && <col className="w-[112px]" />}
            {showCost && <col className="w-[96px]" />}
            {showCost && <col className="w-[92px]" />}
            <col className="w-[112px]" />
            <col className="w-[84px]" />
            {/* The "was → %" delta has its own column so it can never land on
                top of the Sell tax dropdown — but it must not RESERVE the room
                either, or an untouched page carries 100px of dead air between
                the tax and the price.

                So the column exists only once something on this page has
                actually been edited. `w-0` rather than removing the <col>: the
                cells stay in place, so the column count never changes under
                the keyboard navigation, and nothing shifts except this one
                strip widening when the first delta appears. */}
            <col className={anyPriceEdited ? 'w-[124px]' : 'w-0'} />
            <col className="w-[104px]" />
          </colgroup>
          <thead>
            {/* Sticky: fifty rows of bare numbers are unreadable once the
                headings have scrolled away — which column is GP and which is
                markup is the whole question being asked here. */}
            <tr className={`${TABLE_HEAD_ROW} ${TABLE_HEAD_STICKY}`}>
              <th scope="col" className={TABLE_TH}>
                <Checkbox
                  aria-label="Select every product on this page"
                  checked={allSelected}
                  indeterminate={selected.size > 0 && !allSelected}
                  onChange={() =>
                    setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)))
                  }
                />
              </th>
              <th className={TABLE_TH}>Code</th>
              <th className={TABLE_TH}>Description</th>
              {showCost && <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>{costLabel} excl.</th>}
              {showCost && <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Buy tax</th>}
              {showCost && <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>{costLabel} incl.</th>}
              {showCost && <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Markup %</th>}
              {showCost && <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>GP %</th>}
              <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Sell excl.</th>
              <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Sell tax</th>
              {/* The delta column carries no heading: it holds the OLD price of
                  whichever rows have been edited, which the "was" styling says
                  on its own. A word here would label an empty column on every
                  untouched page. */}
              <th
                className={`${TABLE_TH} ${anyPriceEdited ? '' : 'px-0'}`}
                aria-label="Previous price"
              />
              <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>{structureName} incl.</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <PriceRow
                key={row.id}
                row={row}
                value={valueFor(row)}
                edits={edits[row.id]}
                purchaseVatRates={purchaseVatRates}
                sellingVatRates={sellingVatRates}
                costEditable={costEditable}
                anyPriceEdited={anyPriceEdited}
                showCost={showCost}
                busy={saving}
                selected={selected.has(row.id)}
                onSelect={() => toggleRow(row.id)}
                onField={(field, next, was) => setField(row, field, next, was)}
              />
            ))}
          </tbody>
        </table>
        </div>
      </div>

      {/* The save bar sits below the scroll box, not inside it: at fifty rows
          the button would otherwise scroll off exactly when it is needed. */}
      <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border px-4 py-3">
        <span className="text-sm text-muted">
          {dirtyCount === 0
            ? 'No changes yet.'
            : /* "products", not "prices": a row can be dirty because its COST
                 or a tax rate moved with the price left alone, and calling
                 that a changed price would be a lie about what is being
                 saved. */
              `${dirtyCount} ${dirtyCount === 1 ? 'product' : 'products'} changed, not yet saved.`}
          {/* Counted across every CHANGED row, not just the visible ones: a
              price put under cost by a rule is worth saying out loud before it
              is written, not after somebody notices the margin. */}
          {belowCostCount > 0 && (
            <span className="ml-2 text-danger">
              {belowCostCount} below cost.
            </span>
          )}
        </span>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            disabled={dirtyCount === 0 || saving}
            onClick={() => setEdits({})}
          >
            Discard
          </Button>
          <Button variant="primary" disabled={dirtyCount === 0 || saving} onClick={save}>
            {saving ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      </div>
    </div>
  )
}

/**
 * One product's line: cost, tax, margin and selling price, all live.
 *
 * ── THE TWO CHAINS ────────────────────────────────────────────────────
 * Cost excl. → purchase VAT → cost incl. is one chain; markup/GP → sell excl.
 * → selling VAT → sell incl. is the other. They meet at the margin: markup and
 * GP are ratios of the EXCLUSIVE cost against the EXCLUSIVE selling price, so
 * a change on the cost side moves both percentages without touching the
 * selling price — which is exactly what a cost increase does in real life.
 *
 * Each chain still has ONE stored number behind it: last_cost excl. and the
 * selling price incl. Every other box is a view that converts back into one of
 * those on change, so no two figures can drift apart.
 */
function PriceRow({
  row,
  value,
  edits,
  purchaseVatRates,
  sellingVatRates,
  costEditable,
  anyPriceEdited,
  showCost,
  busy,
  selected,
  onSelect,
  onField,
}: {
  row: BulkPricingRow
  value: {
    priceIncl: number | null
    lastCost: number
    purchaseVatRateId: number | null
    sellingVatRateId: number | null
  }
  edits: RowEdit | undefined
  purchaseVatRates: VatRateOption[]
  sellingVatRates: VatRateOption[]
  /** Cost is only a figure a person states when the site prices off last cost. */
  costEditable: boolean
  /** Whether ANY row on this page has an edited price — see the delta col. */
  anyPriceEdited: boolean
  showCost: boolean
  busy: boolean
  selected: boolean
  onSelect: () => void
  onField: <K extends keyof RowEdit>(field: K, next: RowEdit[K], was: RowEdit[K]) => void
}) {
  const purchaseVat = rateOf(
    purchaseVatRates,
    edits?.purchaseVatRateId,
    row.purchaseVatRateId,
    row.purchaseVatPercent,
  )
  const sellingVat = rateOf(
    sellingVatRates,
    edits?.sellingVatRateId,
    row.sellingVatRateId,
    row.sellingVatPercent,
  )

  /* What margins are measured against: the edited last cost when this site
     prices off last cost, otherwise the stored basis — which may be the
     average, and is not a figure anyone may type here. */
  const costExcl = costEditable ? value.lastCost : row.costExcl
  const costIncl = addVat(costExcl, purchaseVat)

  const incl = value.priceIncl ?? 0
  const excl = removeVat(incl, sellingVat)
  const priced = value.priceIncl !== null

  const belowCost = priced && costExcl > 0 && excl < costExcl

  const [editingField, setEditingField] = useState<string | null>(null)

  /**
   * A cell's key changes when the figures move — EXCEPT for the cell the caret
   * is in, whose key must never change while it holds focus.
   *
   * The subtlety that cost an afternoon: the focused cell cannot use a
   * different key SHAPE from its siblings, because taking focus would then
   * change its own key, React would unmount the element that just gained the
   * caret, and focus would fall to the body — which is what broke arrow-key
   * movement between rows.
   *
   * So the focused cell keeps the key it had when focus arrived, held in a ref,
   * while its siblings key off the live figures and remount to re-read them.
   * The stamp covers cost and both tax rates too, because a change to any of
   * them moves the boxes further down the row.
   */
  const stamp = `${incl.toFixed(4)}:${costExcl.toFixed(4)}:${purchaseVat}:${sellingVat}`
  const focusedStamp = useRef(stamp)

  function focusCell(field: string) {
    focusedStamp.current = stamp
    setEditingField(field)
  }

  const cellKey = (field: string) =>
    `${field}:${editingField === field ? focusedStamp.current : stamp}`

  const num = (raw: string) => Number(String(raw).replace(',', '.'))

  return (
    <tr className={TABLE_ROW}>
      {/* TABLE_TD, not TABLE_TD_INPUT: the input padding is deliberately tight
          because a control fills its cell, but this is the FIRST column and
          wants the page gutter — the same px-4 DataTable gives its own
          checkbox column. */}
      <td className={TABLE_TD}>
        <Checkbox
          checked={selected}
          onChange={onSelect}
          aria-label={`Select ${row.description}`}
        />
      </td>
      <td className={`${TABLE_TD_INPUT} px-4 truncate text-sm text-muted`}>{row.code}</td>
      <td className={`${TABLE_TD_INPUT} px-4 truncate text-sm text-ink`}>
        {row.description}
        {belowCost && <span className="ml-2 text-xs text-danger">below cost</span>}
      </td>

      {showCost && (
        <>
          {/* Cost excl. — the stored figure. Read-only on an average-cost site:
              average_cost is a consequence of purchases, so an editable box
              here would either lie or falsify stock valuation. */}
          <td className={TABLE_TD_INPUT}>
            {costEditable ? (
              <CurrencyInput
                key={cellKey('costExcl')}
                value={costExcl}
                disabled={busy}
                onFocus={() => focusCell('costExcl')}
                onBlur={() => setEditingField(null)}
                onChange={(e) => {
                  const next = num(e.target.value)
                  if (Number.isFinite(next) && next >= 0) onField('lastCost', next, row.lastCost)
                }}
              />
            ) : (
              <span className={`${TABLE_NUMERIC} block px-2 text-sm text-muted`}>
                {formatMoney(costExcl)}
              </span>
            )}
          </td>

          <td className={TABLE_TD_INPUT}>
            <Select
              value={value.purchaseVatRateId ?? ''}
              disabled={busy}
              aria-label={`Purchase tax for ${row.description}`}
              onChange={(e) =>
                onField(
                  'purchaseVatRateId',
                  e.target.value === '' ? null : Number(e.target.value),
                  row.purchaseVatRateId,
                )
              }
            >
              <option value="">&mdash;</option>
              {purchaseVatRates.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.rate}%
                </option>
              ))}
            </Select>
          </td>

          {/* Cost incl. edits the SAME stored figure, backwards through tax. */}
          <td className={TABLE_TD_INPUT}>
            {costEditable ? (
              <CurrencyInput
                key={cellKey('costIncl')}
                value={costIncl}
                disabled={busy}
                onFocus={() => focusCell('costIncl')}
                onBlur={() => setEditingField(null)}
                onChange={(e) => {
                  const next = num(e.target.value)
                  if (Number.isFinite(next) && next >= 0) {
                    onField('lastCost', removeVat(next, purchaseVat), row.lastCost)
                  }
                }}
              />
            ) : (
              <span className={`${TABLE_NUMERIC} block px-2 text-sm text-muted`}>
                {formatMoney(costIncl)}
              </span>
            )}
          </td>

          <td className={TABLE_TD_INPUT}>
            <NumberInput
              key={cellKey('markup')}
              precision={2}
              value={priced ? markupPercent(costExcl, excl) : ''}
              disabled={busy || costExcl <= 0}
              onFocus={() => focusCell('markup')}
              onBlur={() => setEditingField(null)}
              onChange={(e) => {
                const next = num(e.target.value)
                if (!Number.isFinite(next)) return
                onField(
                  'priceIncl',
                  addVat(sellExclFromMarkup(costExcl, next), sellingVat),
                  row.sellingIncl ?? undefined,
                )
              }}
            />
          </td>

          <td className={TABLE_TD_INPUT}>
            <NumberInput
              key={cellKey('gp')}
              precision={2}
              max="99.99"
              value={priced ? gpPercent(costExcl, excl) : ''}
              disabled={busy || costExcl <= 0}
              onFocus={() => focusCell('gp')}
              onBlur={() => setEditingField(null)}
              onChange={(e) => {
                const next = num(e.target.value)
                if (!Number.isFinite(next)) return
                // A GP of 100% or more needs an infinite price; ignore rather
                // than write Infinity into the row.
                const sell = sellExclFromGp(costExcl, next)
                if (sell !== null) {
                  onField('priceIncl', addVat(sell, sellingVat), row.sellingIncl ?? undefined)
                }
              }}
            />
          </td>
        </>
      )}

      <td className={TABLE_TD_INPUT}>
        <CurrencyInput
          key={cellKey('excl')}
          value={priced ? excl : ''}
          disabled={busy}
          onFocus={() => focusCell('excl')}
          onBlur={() => setEditingField(null)}
          onChange={(e) => {
            const next = num(e.target.value)
            if (Number.isFinite(next)) {
              onField('priceIncl', addVat(next, sellingVat), row.sellingIncl ?? undefined)
            }
          }}
        />
      </td>

      <td className={TABLE_TD_INPUT}>
        <Select
          value={value.sellingVatRateId ?? ''}
          disabled={busy}
          aria-label={`Selling tax for ${row.description}`}
          onChange={(e) =>
            onField(
              'sellingVatRateId',
              e.target.value === '' ? null : Number(e.target.value),
              row.sellingVatRateId,
            )
          }
        >
          <option value="">&mdash;</option>
          {sellingVatRates.map((v) => (
            <option key={v.id} value={v.id}>
              {v.rate}%
            </option>
          ))}
        </Select>
      </td>

      {/* What it was, and how far it has moved, in its OWN cell — a column of
          plain numbers makes a 40% rise look like a 2% one. Empty until the
          price is edited. */}
      {/* px-0 while the column is collapsed: TABLE_TD_INPUT's own padding
          would otherwise hold 12px open on every row of an untouched page,
          which is the gap this column was narrowed to close. */}
      <td
        className={`${TABLE_TD_INPUT} whitespace-nowrap text-right ${
          anyPriceEdited ? '' : 'px-0'
        }`}
      >
        <Delta
          from={row.sellingIncl}
          to={value.priceIncl}
          dirty={edits?.priceIncl !== undefined}
        />
      </td>

      <td className={TABLE_TD_INPUT}>
        <span className="flex items-center justify-end">
          <span className="w-[88px] shrink-0">
            <CurrencyInput
              key={cellKey('incl')}
              value={priced ? incl : ''}
              disabled={busy}
              onFocus={() => focusCell('incl')}
              onBlur={() => setEditingField(null)}
              onChange={(e) => {
                const next = num(e.target.value)
                if (Number.isFinite(next)) {
                  onField('priceIncl', next, row.sellingIncl ?? undefined)
                }
              }}
            />
          </span>
        </span>
      </td>
    </tr>
  )
}


function Delta({
  from,
  to,
  dirty,
}: {
  from: number | null
  to: number | null
  dirty: boolean
}) {
  if (!dirty || from === null || to === null || from === 0) return null
  const moved = ((to - from) / from) * 100
  if (Math.abs(moved) < 0.05) return null
  return (
    /* flex-nowrap explicitly: the old price and the percentage are one
       statement, and letting them stack doubles the row height on exactly the
       rows the user is watching. */
    <span className="flex flex-nowrap items-baseline justify-end gap-1.5 text-xs">
      <span className="numeric text-muted line-through">{formatMoney(from)}</span>
      <span className={`numeric ${moved > 0 ? 'text-success' : 'text-danger'}`}>
        {moved > 0 ? '+' : ''}
        {moved.toFixed(0)}%
      </span>
    </span>
  )
}
