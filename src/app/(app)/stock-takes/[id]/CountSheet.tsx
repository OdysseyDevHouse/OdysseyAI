'use client'

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Badge,
  Button,
  Icons,
  Input,
  SegmentedControl,
  TableToolbar,
  ToolbarSearch,
  EmptyState,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_TH,
  TABLE_TD,
  TABLE_TD_INPUT,
  TABLE_NUMERIC,
  useToast,
} from '@/components/ui'
import { formatQty } from '@/lib/decimals'
import type { StockTakeLine } from '@/lib/site/stockTakes'
import { saveCountsAction } from '../actions'
import { LineImportDialog } from '@/components/import/LineImportDialog'
import type { LineDraft as ImportedLine } from '@/lib/import/documentLines'

/**
 * The counting grid.
 *
 * This is not a form. It is a data-entry instrument someone uses standing up,
 * on a tablet, in a stockroom, for two hours — and every decision here follows
 * from that:
 *
 *   · SCAN TO JUMP is the primary interaction. A counter holds a scanner, not a
 *     mouse. A scan focuses the matching row and selects its quantity so the
 *     next keystrokes replace it.
 *   · ENTER COMMITS AND ADVANCES to the next uncounted line, so a shelf can be
 *     counted without ever leaving the keyboard.
 *   · UNCOUNTED IS NOT ZERO. An empty field and a typed 0 are different claims
 *     about the world, and the grid must never let them look alike.
 *   · AUTOSAVE PER LINE, debounced. A two-hour count that loses an hour to a
 *     closed tab is a module nobody uses twice.
 *   · PROGRESS IS ALWAYS ON SCREEN, because "how much is left" is the question
 *     a counter asks every few minutes.
 *
 * DataTable cannot express a table whose cells hold live inputs, so the table
 * is built by hand — wearing the shared skin (TABLE_TH, TABLE_TD, …) so it can
 * never drift from every other table in the app.
 */

type Filter = 'all' | 'uncounted' | 'variances'

/** What the screen holds per line while someone is typing into it. */
type Draft = {
  /** The raw string, so a half-typed "1." survives a re-render. */
  text: string
  saved: boolean
}

const SAVE_DELAY = 700

/**
 * What a variant's description says that its heading and axes do not.
 *
 * A child is nearly always described as "<parent> <axis>" — "Cotton Shirt
 * Large" under a "Cotton Shirt" heading on a row already labelled "Large". Shown
 * whole, every row in the group repeats two things the eye has just read, and
 * the size — the only word that matters on a shelf — is the least prominent
 * thing in the cell.
 *
 * So the parent's words and the axis values are removed and whatever REMAINS is
 * shown. Usually nothing, which is the point. A child genuinely described in its
 * own terms ("Cotton Shirt Large — factory second") keeps that remainder, so
 * nothing a person deliberately typed is ever hidden.
 */
function residualDescription(line: StockTakeLine): string {
  const words = new Set(
    [line.parentDescription ?? '', line.axis1, line.axis2]
      .join(' ')
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean),
  )
  return line.description
    .split(/\s+/)
    .filter((word) => !words.has(word.toLowerCase()))
    .join(' ')
    .trim()
}

export default function CountSheet({
  takeId,
  lines,
  readOnly,
}: {
  takeId: number
  lines: StockTakeLine[]
  readOnly: boolean
}) {
  const toast = useToast()
  const [drafts, setDrafts] = useState<Record<number, Draft>>(() => {
    const initial: Record<number, Draft> = {}
    for (const line of lines) {
      initial[line.id] = {
        text: line.countedQty === null ? '' : String(line.countedQty),
        saved: true,
      }
    }
    return initial
  })
  const [filter, setFilter] = useState<Filter>('all')
  const [search, setSearch] = useState('')
  const [failed, setFailed] = useState(false)

  /** Serial lines hold a list of scanned units rather than a typed quantity. */
  const [serials, setSerials] = useState<Record<number, string[]>>(() => {
    const initial: Record<number, string[]> = {}
    for (const line of lines) initial[line.id] = line.serials ?? []
    return initial
  })

  const timers = useRef<Record<number, ReturnType<typeof setTimeout>>>({})
  const inputs = useRef<Record<number, HTMLInputElement | null>>({})
  const scanRef = useRef<HTMLInputElement>(null)
  const [importOpen, setImportOpen] = useState(false)

  const serialCount = (line: StockTakeLine) => (serials[line.id] ?? []).length

  // Clearing the timers on unmount stops a save firing against a screen that is
  // no longer there — which would otherwise toast into the void after navigation.
  useEffect(() => {
    const pending = timers.current
    return () => {
      for (const t of Object.values(pending)) clearTimeout(t)
    }
  }, [])

  const countedFor = (line: StockTakeLine): number | null => {
    // A serial line's count IS the number of units scanned against it. An empty
    // list means nobody has counted it yet, which is not the same as zero found.
    if (line.productType === 'serial') {
      const scanned = serials[line.id]
      return scanned && scanned.length > 0 ? scanned.length : null
    }
    const text = drafts[line.id]?.text ?? ''
    if (text.trim() === '') return null
    const n = Number(text)
    return Number.isFinite(n) ? n : null
  }

  const varianceFor = (line: StockTakeLine): number | null => {
    const counted = countedFor(line)
    return counted === null ? null : counted - line.snapshotQty
  }

  const countedCount = lines.filter((l) => (drafts[l.id]?.text ?? '').trim() !== '').length
  const unsaved = Object.values(drafts).some((d) => !d.saved)

  const save = useCallback(
    async (lineId: number, text: string) => {
      const trimmed = text.trim()
      const value = trimmed === '' ? null : Number(trimmed)
      if (trimmed !== '' && (!Number.isFinite(value) || (value as number) < 0)) return

      const result = await saveCountsAction(takeId, [{ lineId, countedQty: value }])
      if (result && 'ok' in result && result.ok) {
        setDrafts((d) => ({ ...d, [lineId]: { text, saved: true } }))
        setFailed(false)
      } else {
        // Left unsaved on purpose: the count stays on screen so it can be
        // retyped or retried, rather than vanishing and looking accepted.
        setFailed(true)
      }
    },
    [takeId],
  )

  function change(lineId: number, text: string) {
    setDrafts((d) => ({ ...d, [lineId]: { text, saved: false } }))
    clearTimeout(timers.current[lineId])
    timers.current[lineId] = setTimeout(() => void save(lineId, text), SAVE_DELAY)
  }

  /** Commits now rather than waiting out the debounce. */
  function commit(lineId: number) {
    clearTimeout(timers.current[lineId])
    void save(lineId, drafts[lineId]?.text ?? '')
  }

  /**
   * Counts from a spreadsheet — a shelf walked with a clipboard, or a scanner
   * that exports rather than talks to the till.
   *
   * Matched onto the lines this sheet ALREADY has, because a stock take's lines
   * are seeded when it is created and cannot be added to afterwards. A product
   * in the file that is not on the sheet is therefore reported rather than
   * quietly created: it means the sheet was built for a different scope, and
   * the fix is a new sheet, not a row appearing halfway down this one.
   *
   * Saved in ONE call. The grid autosaves per line as somebody works down a
   * shelf, but two thousand rows arriving at once is one batch — that is
   * exactly what saveCounts takes a list for.
   */
  async function addImportedCounts(imported: ImportedLine[]) {
    const byProduct = new Map(lines.map((l) => [l.productId, l]))

    const entries: { lineId: number; countedQty?: number | null; serials?: string[] }[] = []
    const nextDrafts: Record<number, { text: string; saved: boolean }> = {}
    const nextSerials: Record<number, string[]> = {}
    const missed: string[] = []

    for (const row of imported) {
      const line = byProduct.get(row.productId)
      if (!line) {
        missed.push(row.code)
        continue
      }

      // On a serial line the scanned list IS the count — a typed quantity is
      // ignored at post time, so accepting one here would show a figure the
      // post would then contradict.
      if (line.productType === 'serial') {
        if (row.serials.length === 0) {
          missed.push(`${row.code} (needs serial numbers, not a quantity)`)
          continue
        }
        nextSerials[line.id] = row.serials
        entries.push({ lineId: line.id, serials: row.serials, countedQty: row.serials.length })
        nextDrafts[line.id] = { text: String(row.serials.length), saved: true }
      } else {
        entries.push({ lineId: line.id, countedQty: row.qty })
        nextDrafts[line.id] = { text: String(row.qty), saved: true }
      }
    }

    if (entries.length === 0) {
      toast.error('None of those products are on this sheet.')
      return
    }

    const result = await saveCountsAction(takeId, entries)
    if (!result || !('ok' in result) || !result.ok) {
      setFailed(true)
      toast.error('Those counts could not be saved. Nothing was changed.')
      return
    }

    setDrafts((d) => ({ ...d, ...nextDrafts }))
    if (Object.keys(nextSerials).length > 0) {
      setSerials((s) => ({ ...s, ...nextSerials }))
    }
    setFailed(false)

    if (missed.length > 0) {
      toast.info(
        `${entries.length} counted · ${missed.length} not on this sheet — ${missed.slice(0, 3).join(', ')}` +
        (missed.length > 3 ? '…' : ''),
      )
    } else {
      toast.success(`${entries.length} ${entries.length === 1 ? 'count' : 'counts'} imported`)
    }
  }

  /**
   * Adds or removes one scanned unit on a serial line.
   *
   * Saved immediately rather than debounced: a scan is a deliberate act on one
   * unit, not a figure somebody is still typing, and losing one to a closed tab
   * means re-walking the shelf to work out which.
   */
  async function toggleSerial(line: StockTakeLine, serial: string, remove = false) {
    const current = serials[line.id] ?? []
    const trimmed = serial.trim()
    if (!trimmed) return

    if (!remove && current.some((s) => s.toLowerCase() === trimmed.toLowerCase())) {
      toast.error(`${trimmed} has already been counted on this line.`)
      return
    }

    const next = remove
      ? current.filter((s) => s.toLowerCase() !== trimmed.toLowerCase())
      : [...current, trimmed]

    setSerials((s) => ({ ...s, [line.id]: next }))

    const result = await saveCountsAction(takeId, [
      // countedQty follows the list, so the two can never drift apart. Null when
      // the list empties, which returns the line to uncounted.
      { lineId: line.id, serials: next, countedQty: next.length > 0 ? next.length : null },
    ])
    if (!result || !('ok' in result) || !result.ok) {
      // Put it back: the screen must not show a unit as counted when the server
      // does not have it.
      setSerials((s) => ({ ...s, [line.id]: current }))
      setFailed(true)
    }
  }

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase()
    return lines.filter((line) => {
      if (term) {
        // The parent's name and the axis values are searchable too: on a sheet
        // someone types "shirt" to reach the shirts, and the variants are what
        // is actually on it — matching only their own descriptions would answer
        // "nothing on this sheet" about forty rows of shirts.
        const haystack = [
          line.productCode ?? '',
          line.description,
          line.parentDescription ?? '',
          line.axis1,
          line.axis2,
        ]
          .join(' ')
          .toLowerCase()
        if (!haystack.includes(term)) return false
      }
      if (filter === 'uncounted') return (drafts[line.id]?.text ?? '').trim() === ''
      if (filter === 'variances') {
        const v = varianceFor(line)
        return v !== null && Math.abs(v) > 0.0005
      }
      return true
    })
    // drafts is read inside, so the list re-filters as counts are typed.
  }, [lines, search, filter, drafts])

  /**
   * A scan jumps to the product and selects what is in its box.
   *
   * Selecting rather than clearing matters: the scanner user types the new
   * figure straight over the old one, and a counter who scans the wrong item
   * has not destroyed a count by doing so.
   */
  function onScan(code: string) {
    const term = code.trim().toLowerCase()
    if (!term) return
    const hit =
      lines.find((l) => (l.productCode ?? '').toLowerCase() === term) ??
      lines.find((l) => (l.productCode ?? '').toLowerCase().includes(term)) ??
      lines.find((l) => l.description.toLowerCase().includes(term))

    if (!hit) {
      // Deliberately does NOT guess that an unmatched scan is a serial number.
      // Each serial line carries its own scan box, so a unit is always scanned
      // against a named product — guessing here would attach a unit to whatever
      // serial line happened to be the only one on the sheet.
      toast.error(`Nothing on this sheet matches ${code}. Scan a product code.`)
      return
    }
    // Clearing the filter first, or the row we are jumping to may not be rendered.
    setFilter('all')
    setSearch('')
    requestAnimationFrame(() => {
      const input = inputs.current[hit.id]
      input?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      input?.focus()
      input?.select()
    })
  }

  /** Enter moves to the next line that still needs counting. */
  function advance(fromId: number) {
    const order = visible.map((l) => l.id)
    const at = order.indexOf(fromId)
    const next =
      order.slice(at + 1).find((id) => (drafts[id]?.text ?? '').trim() === '') ??
      order[at + 1]
    if (next !== undefined) {
      inputs.current[next]?.focus()
      inputs.current[next]?.select()
    }
  }

  return (
    <>
      <TableToolbar
        inCard
        actions={
          <>
            <SegmentedControl
              value={filter}
              onChange={(v) => setFilter(v as Filter)}
              options={[
                { value: 'all', label: `All ${lines.length}` },
                { value: 'uncounted', label: `To count ${lines.length - countedCount}` },
                { value: 'variances', label: 'Variances' },
              ]}
            />
            <ToolbarSearch value={search} onChange={setSearch} placeholder="Find a product" />
            {/* For a shelf walked with a clipboard, or a scanner that exports
                a file rather than talking to the till. Counts land on the
                lines this sheet already has — see addImportedCounts. */}
            {!readOnly && (
              <Button variant="ghost" onClick={() => setImportOpen(true)}>
                <Icons.Upload size={16} />
                Import counts
              </Button>
            )}
          </>
        }
      >
        {!readOnly && (
          <div className="flex items-center gap-2">
            <Icons.Barcode size={16} className="text-muted" />
            <Input
              ref={scanRef}
              placeholder="Scan to jump to a line"
              aria-label="Scan a barcode to jump to its line"
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return
                e.preventDefault()
                onScan((e.target as HTMLInputElement).value)
                ;(e.target as HTMLInputElement).value = ''
              }}
              className="w-56"
            />
          </div>
        )}
      </TableToolbar>

      {/* Progress and save state, always visible. The counter checks both
          without having to go looking for them. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border px-4 py-2.5 text-sm">
        <span className="text-ink-2">
          <span className="numeric text-ink">{countedCount}</span>
          <span className="text-muted"> of </span>
          <span className="numeric text-ink">{lines.length}</span>
          <span className="text-muted"> counted</span>
        </span>
        {failed ? (
          <span className="flex items-center gap-1.5 text-danger">
            <Icons.StatusError size={14} />
            A count did not save — check your connection and retype it.
          </span>
        ) : unsaved ? (
          <span className="flex items-center gap-1.5 text-muted">
            <Icons.Spinner size={14} className="animate-spin" />
            Saving…
          </span>
        ) : countedCount > 0 ? (
          <span className="flex items-center gap-1.5 text-success">
            <Icons.Check size={14} />
            All counts saved
          </span>
        ) : null}
      </div>

      {visible.length === 0 ? (
        <EmptyState
          title={search ? `Nothing matches “${search}”` : 'Nothing to show'}
          hint={
            search
              ? 'Clear the search to see the rest of the sheet.'
              : filter === 'uncounted'
                ? 'Every line on this sheet has been counted.'
                : 'No line on this sheet differs from what the system believed.'
          }
          icon={<Icons.Search size={22} />}
          action={
            <Button
              variant="secondary"
              onClick={() => {
                setSearch('')
                setFilter('all')
              }}
            >
              Show everything
            </Button>
          }
        />
      ) : (
        <div className="overflow-x-auto">
          <table className={TABLE}>
            <thead>
              <tr className={TABLE_HEAD_ROW}>
                <th className={TABLE_TH}>Code</th>
                <th className={TABLE_TH}>Description</th>
                <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>System says</th>
                <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Counted</th>
                <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Variance</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((line, index) => {
                const draft = drafts[line.id]
                const counted = countedFor(line)
                const variance = varianceFor(line)
                const isUncounted = (draft?.text ?? '').trim() === ''

                /* A group's variants sit consecutively (buildSheetLines orders
                   them that way), so the heading goes in when the parent
                   changes. Computed off the VISIBLE list rather than all
                   lines, or filtering to "uncounted" would strand a heading
                   above nothing, or drop it from the rows that remain. */
                const previous = index > 0 ? visible[index - 1] : null
                const startsGroup =
                  line.parentId !== null && line.parentId !== previous?.parentId

                return (
                  <Fragment key={line.id}>
                    {startsGroup && (
                      /* One shelf, one heading. Without it five sizes of the
                         same shirt read as five unrelated products, and the
                         counter has no way to see they belong together — which
                         is exactly when a size gets counted twice or skipped. */
                      <tr className="border-b border-border bg-surface-2">
                        <td colSpan={5} className="px-4 py-1.5">
                          <span className="text-sm font-medium text-ink">
                            {line.parentDescription}
                          </span>
                          <span className="ml-2 text-xs text-muted">
                            {visible.filter((l) => l.parentId === line.parentId).length} variants
                          </span>
                        </td>
                      </tr>
                    )}
                    <tr className="border-b border-border last:border-0">
                      <td className={`${TABLE_TD} whitespace-nowrap text-ink-2`}>
                        {line.productCode ?? '—'}
                      </td>
                      <td className={TABLE_TD}>
                        {/* Under a heading the row is one variant OF that shirt,
                            so it shows ONLY what tells it apart — "Large · Blue".
                            The parent's name is in the heading directly above, and
                            repeating it per row ("Large  Blue Cotton Shirt Large")
                            buries the one word the counter is scanning for.

                            Whatever the description adds BEYOND the parent's name
                            still shows, so a child described in its own terms is
                            not silently hidden. */}
                        {line.parentId !== null && (line.axis1 || line.axis2) ? (
                          <>
                            <span className="pl-4 font-medium text-ink">
                              {[line.axis1, line.axis2].filter(Boolean).join(' · ')}
                            </span>
                            {residualDescription(line) && (
                              <span className="ml-2 text-xs text-muted">
                                {residualDescription(line)}
                              </span>
                            )}
                          </>
                        ) : (
                          <span className="text-ink">{line.description}</span>
                        )}
                        {line.lineMode === 'recount' && (
                          <Badge tone="warning" className="ml-2">
                            Recount
                          </Badge>
                        )}

                        {/* A serial line counts individual units, so the units
                            themselves live in the row. Each is removable, because
                            the commonest correction on a shelf is scanning the
                            wrong box. */}
                        {line.productType === 'serial' && (
                          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                            {(serials[line.id] ?? []).map((s) => (
                              <span
                                key={s}
                                className="inline-flex items-center gap-1 rounded-pill bg-surface-2 px-2 py-0.5 text-xs text-ink-2"
                              >
                                {s}
                                {!readOnly && (
                                  <button
                                    type="button"
                                    onClick={() => void toggleSerial(line, s, true)}
                                    aria-label={`Remove ${s}`}
                                    className="text-faint hover:text-danger"
                                  >
                                    <Icons.Close size={12} />
                                  </button>
                                )}
                              </span>
                            ))}
                            {!readOnly && (
                              <Input
                                size="md"
                                placeholder="Scan a unit"
                                aria-label={`Scan a serial number for ${line.description}`}
                                onKeyDown={(e) => {
                                  if (e.key !== 'Enter') return
                                  e.preventDefault()
                                  const el = e.target as HTMLInputElement
                                  void toggleSerial(line, el.value)
                                  el.value = ''
                                }}
                                className="h-control-sm w-40 text-xs"
                              />
                            )}
                          </div>
                        )}
                      </td>
                      <td className={`${TABLE_TD} ${TABLE_NUMERIC} text-muted`}>
                        {formatQty(line.snapshotQty)}
                      </td>
                      <td className={`${TABLE_TD_INPUT} ${TABLE_NUMERIC} w-32`}>
                        {/* A serial line is counted by scanning units, not by
                            typing a number — so its quantity is shown, never
                            entered. The two can then never disagree. */}
                        {line.productType === 'serial' ? (
                          <span className={serialCount(line) === 0 ? 'text-faint' : 'text-ink'}>
                            {serialCount(line) === 0 ? '—' : serialCount(line)}
                          </span>
                        ) : readOnly ? (
                          <span className="text-ink">
                            {line.countedQty === null ? '—' : formatQty(line.countedQty)}
                          </span>
                        ) : (
                          <Input
                            ref={(el) => {
                              inputs.current[line.id] = el
                            }}
                            value={draft?.text ?? ''}
                            onChange={(e) => change(line.id, e.target.value)}
                            onBlur={() => commit(line.id)}
                            onKeyDown={(e) => {
                              if (e.key !== 'Enter') return
                              e.preventDefault()
                              commit(line.id)
                              advance(line.id)
                            }}
                            inputMode="decimal"
                            aria-label={`Counted quantity for ${line.description}`}
                            // An uncounted line reads as a prompt, a counted one as
                            // a value. This is the whole zero-versus-blank contract.
                            placeholder="—"
                            className={`text-right ${isUncounted ? 'text-faint' : 'text-ink'}`}
                          />
                        )}
                      </td>
                      <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                        {counted === null ? (
                          <span className="text-faint">—</span>
                        ) : Math.abs(variance ?? 0) < 0.0005 ? (
                          <span className="text-muted">0</span>
                        ) : (
                          <span className={(variance ?? 0) < 0 ? 'text-danger' : 'text-success'}>
                            {(variance ?? 0) > 0 ? '+' : ''}
                            {formatQty(variance ?? 0)}
                          </span>
                        )}
                      </td>
                    </tr>
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <LineImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onLines={(rows) => void addImportedCounts(rows)}
        noun="counts"
      />
    </>
  )
}
