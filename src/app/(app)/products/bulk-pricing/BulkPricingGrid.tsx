'use client'

import { useMemo, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  BulkActionBar,
  Button,
  Checkbox,
  CurrencyInput,
  NumberInput,
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

type Props = {
  rows: BulkPricingRow[]
  structureId: number
  structureName: string
  costBasis: CostBasis
  /** Cost, markup and GP columns are hidden without products.cost. */
  showCost: boolean
  /** The site's price_ending_direction, as the rule dialog's starting choice. */
  defaultEndingDirection: EndingDirection
}

export default function BulkPricingGrid({
  rows,
  structureId,
  structureName,
  costBasis,
  showCost,
  defaultEndingDirection,
}: Props) {
  const router = useRouter()
  const toast = useToast()
  const [saving, startSave] = useTransition()

  /* Edits only. A row the user has not touched is absent, which is what makes
     "13 changes" honest and keeps the save down to what actually moved. */
  const [edits, setEdits] = useState<Record<number, number>>({})

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
        // Same un-dirtying rule as a typed edit: a rule that works out to the
        // price already on the row is not a change.
        if (was !== null && was !== undefined && Math.abs(was - p.priceIncl) < 0.00005) {
          delete next[p.productId]
        } else {
          next[p.productId] = p.priceIncl
        }
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

  const belowCostCount = useMemo(
    () =>
      rows.filter((r) => {
        const edited = edits[r.id]
        if (edited === undefined || r.costExcl <= 0) return false
        return removeVat(edited, r.sellingVatPercent) < r.costExcl
      }).length,
    [rows, edits],
  )

  /* Typing a value back to what it was un-dirties the row rather than saving a
     no-op — borrowed from BudgetGrid, and it is why the footer count can be
     trusted after someone changes their mind. */
  function setPrice(id: number, next: number) {
    setEdits((prev) => {
      const was = original.get(id)
      const copy = { ...prev }
      if (was !== null && was !== undefined && Math.abs(was - next) < 0.00005) delete copy[id]
      else copy[id] = next
      return copy
    })
  }

  function priceFor(row: BulkPricingRow): number | null {
    const edited = edits[row.id]
    return edited !== undefined ? edited : row.sellingIncl
  }

  function save() {
    const payload = Object.entries(edits).map(([id, priceIncl]) => ({
      productId: Number(id),
      priceIncl,
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
        toast.success(`${result.updated} ${result.updated === 1 ? 'price' : 'prices'} saved.`)
      }
      setEdits({})
      router.refresh()
    })
  }

  const costLabel = costBasis === 'last' ? 'Last cost' : 'Average cost'

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
            <col className="w-[130px]" />
            <col />
            {showCost && <col className="w-[110px]" />}
            {showCost && <col className="w-[104px]" />}
            {showCost && <col className="w-[104px]" />}
            <col className="w-[124px]" />
            <col className="w-[150px]" />
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
              {showCost && <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>{costLabel}</th>}
              {showCost && <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Markup %</th>}
              {showCost && <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>GP %</th>}
              <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Excl. VAT</th>
              <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>{structureName} incl.</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <PriceRow
                key={row.id}
                row={row}
                price={priceFor(row)}
                dirty={edits[row.id] !== undefined}
                showCost={showCost}
                busy={saving}
                selected={selected.has(row.id)}
                onSelect={() => toggleRow(row.id)}
                onChange={(next) => setPrice(row.id, next)}
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
            : `${dirtyCount} ${dirtyCount === 1 ? 'price' : 'prices'} changed, not yet saved.`}
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
 * One product's line.
 *
 * Every editable cell reads from the same inclusive price and writes back to
 * it. `basis` is the cost this site prices from, already resolved server-side,
 * so markup and GP mean here exactly what they mean on the product screen.
 */
function PriceRow({
  row,
  price,
  dirty,
  showCost,
  busy,
  selected,
  onSelect,
  onChange,
}: {
  row: BulkPricingRow
  price: number | null
  dirty: boolean
  showCost: boolean
  busy: boolean
  selected: boolean
  onSelect: () => void
  onChange: (next: number) => void
}) {
  const vat = row.sellingVatPercent
  const basis = row.costExcl
  const incl = price ?? 0
  const excl = removeVat(incl, vat)
  const priced = price !== null

  /* ── WHY THESE CELLS ARE KEYED ────────────────────────────────────────
     NumberInput and CurrencyInput hold what you typed until they lose focus,
     so formatting does not fight the caret. That is right for a lone field and
     wrong for four that compute each other: typing a GP recomputes the price,
     but the markup box beside it keeps showing its own stale text.

     Keying each box on the current price remounts the ones you are NOT in
     whenever the row's price moves, so they re-read it. `editingField` keeps
     the box under the cursor mounted — remounting that one would drop the
     caret mid-keystroke. */
  const [editingField, setEditingField] = useState<string | null>(null)

  /**
   * A cell's key changes when the row's price moves — EXCEPT for the cell the
   * caret is in, whose key must never change while it holds focus.
   *
   * The subtlety that cost an afternoon: the focused cell cannot simply use a
   * different key SHAPE from its siblings, because taking focus would then
   * change its own key, React would unmount the element that just gained the
   * caret, and focus would fall to the body. That is what broke arrow-key
   * movement between rows.
   *
   * So the focused cell keeps the key it already had — the price as it was when
   * focus arrived, held in a ref — while its siblings key off the live price
   * and remount to re-read it. Nothing the focused cell does changes its own
   * key; everything it does changes theirs.
   */
  const focusedKeyPrice = useRef(incl)

  /* Captured in the focus event itself, not in a render that follows it: by the
     time a re-render could read `incl`, the key would already have changed once
     and taken the element with it. */
  function focusCell(field: string) {
    focusedKeyPrice.current = incl
    setEditingField(field)
  }

  const cellKey = (field: string) =>
    `${field}:${(editingField === field ? focusedKeyPrice.current : incl).toFixed(4)}`

  // Below cost is worth seeing while typing, not only at save time.
  const belowCost = priced && basis > 0 && excl < basis

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
        {belowCost && (
          <span className="ml-2 text-xs text-danger">below cost</span>
        )}
      </td>

      {showCost && (
        /* Read-only by design. average_cost is a consequence of purchases and
           stock movements — see updateProduct, which refuses to write it — so
           an editable box here would either lie or falsify stock valuation. */
        <td className={`${TABLE_TD_INPUT} px-4 ${TABLE_NUMERIC} text-sm text-muted`}>
          {formatMoney(basis)}
        </td>
      )}

      {showCost && (
        <td className={TABLE_TD_INPUT}>
          <NumberInput
            key={cellKey('markup')}
            precision={2}
            value={priced ? markupPercent(basis, excl) : ''}
            disabled={busy || basis <= 0}
            onFocus={() => focusCell('markup')}
            onBlur={() => setEditingField(null)}
            onChange={(e) => {
              const next = Number(String(e.target.value).replace(',', '.'))
              if (!Number.isFinite(next)) return
              onChange(addVat(sellExclFromMarkup(basis, next), vat))
            }}
          />
        </td>
      )}

      {showCost && (
        <td className={TABLE_TD_INPUT}>
          <NumberInput
            key={cellKey('gp')}
            precision={2}
            max="99.99"
            value={priced ? gpPercent(basis, excl) : ''}
            disabled={busy || basis <= 0}
            onFocus={() => focusCell('gp')}
            onBlur={() => setEditingField(null)}
            onChange={(e) => {
              const next = Number(String(e.target.value).replace(',', '.'))
              if (!Number.isFinite(next)) return
              // A GP of 100% or more needs an infinite price; ignore rather
              // than write Infinity into the row.
              const sell = sellExclFromGp(basis, next)
              if (sell !== null) onChange(addVat(sell, vat))
            }}
          />
        </td>
      )}

      <td className={TABLE_TD_INPUT}>
        <CurrencyInput
          key={cellKey('excl')}
          value={priced ? excl : ''}
          disabled={busy}
          onFocus={() => focusCell('excl')}
          onBlur={() => setEditingField(null)}
          onChange={(e) => {
            const next = Number(String(e.target.value).replace(',', '.'))
            if (Number.isFinite(next)) onChange(addVat(next, vat))
          }}
        />
      </td>

      <td className={TABLE_TD_INPUT}>
        <span className="flex items-center justify-end gap-2">
          {/* What it was, and how far it has moved — a column of plain numbers
              makes a 40% rise look like a 2% one. */}
          <Delta from={row.sellingIncl} to={price} dirty={dirty} />
          <span className="w-[92px] shrink-0">
            <CurrencyInput
              key={cellKey('incl')}
              value={priced ? incl : ''}
              disabled={busy}
              onFocus={() => focusCell('incl')}
              onBlur={() => setEditingField(null)}
              onChange={(e) => {
                const next = Number(String(e.target.value).replace(',', '.'))
                if (Number.isFinite(next)) onChange(next)
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
    <span className="flex items-baseline gap-1.5 text-xs">
      <span className="numeric text-muted line-through">{formatMoney(from)}</span>
      <span className={`numeric ${moved > 0 ? 'text-success' : 'text-danger'}`}>
        {moved > 0 ? '+' : ''}
        {moved.toFixed(0)}%
      </span>
    </span>
  )
}
