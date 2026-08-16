'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { ColumnPicker, useToast, type ColumnOption } from '@/components/ui'
import type { ReportColumn } from '@/lib/reportBuilder/spec'
import { setReportColumnsAction, clearReportColumnsAction } from '../../listColumnActions'

/**
 * Choosing which columns a report shows, and in what order, for the store.
 *
 * ── WHY THE CATALOGUE IS THIS RUN'S COLUMNS ──────────────────────────────
 *
 * The options are whatever the report actually produced, not the field catalog
 * for its source. Those are different lists: a source offers fifty fields, a
 * report selects eight, and offering the other forty-two here would be offering
 * to add columns — which is what the builder is for. This control answers a
 * narrower question: of the columns this report has, which do we want, and in
 * what order.
 *
 * ── WHY NO GROUP HEADINGS ────────────────────────────────────────────────
 *
 * Passing `onReorder` puts the picker in its flat ordered mode. A heading is a
 * claim about where a column sits, and once a column can be dragged anywhere
 * the claim stops being true — see ColumnPicker.
 *
 * ── LOCKED ───────────────────────────────────────────────────────────────
 *
 * Nothing is locked. A report is not a list with an identity column: the first
 * column of a grouped report is its grouping, and a store that wants only the
 * figures is entitled to them. The server refuses an empty set, which is the
 * only floor that matters.
 */
export default function ReportColumnsButton({
  reportId,
  allColumns,
  storeColumns,
  shownKeys,
}: {
  reportId: string
  /** Every column this run produced — the options, in the report's own order. */
  allColumns: readonly ReportColumn[]
  /** The store's stored order, or null when it has never chosen. */
  storeColumns: readonly string[] | null
  /** What is on screen now: the store's set, or all of them. */
  shownKeys: readonly string[]
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, startTransition] = useTransition()

  const options: ColumnOption[] = allColumns.map((c) => ({ id: c.key, label: c.label }))
  const known = allColumns.map((c) => c.key)
  const visible = new Set(shownKeys)

  /*
   * Both a toggle and a drag write the same thing: the visible keys in render
   * order. The picker hands back one or the other, so each is turned into that
   * one shape before saving — the store's row is always "these columns, in this
   * order", never a set plus a separate ordering to reconcile on read.
   */
  function save(orderedVisible: string[]) {
    startTransition(async () => {
      const result = await setReportColumnsAction(reportId, orderedVisible, known)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      router.refresh()
    })
  }

  /** The full order as the picker shows it, stored order first. */
  const order = storeColumns
    ? [...storeColumns, ...known.filter((k) => !storeColumns.includes(k))]
    : known

  return (
    <ColumnPicker
      columns={options}
      visible={visible}
      order={order}
      /* Full height, to sit level with the period Select and the Export menu
         either side of it. The picker defaults to the shorter inline-table size,
         which is right in a list toolbar and wrong in this row. */
      size="md"
      label={pending ? 'Saving…' : 'Columns'}
      onChange={(next) => save(order.filter((key) => next.has(key)))}
      onReorder={(nextOrder) => save(nextOrder.filter((key) => visible.has(key)))}
      onReset={() => {
        startTransition(async () => {
          const result = await clearReportColumnsAction(reportId)
          if (!result.ok) {
            toast.error(result.error)
            return
          }
          toast.success('Columns reset')
          router.refresh()
        })
      }}
    />
  )
}
