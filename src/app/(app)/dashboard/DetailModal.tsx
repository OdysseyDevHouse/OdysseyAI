'use client'

import { useEffect, useRef, useState } from 'react'
import { Modal, EmptyState, Icons, type DateRange } from '@/components/ui'
import type { DetailDimension, RankedRow } from '@/lib/site/salesDashboard'
import { RankedTable, TABLE_CONFIG } from './RankedTable'
import { count } from './format'

/**
 * "View more" — the full ranked list for one dimension.
 *
 * The card shows the top ten; this fetches every row that traded in the
 * period, because the reason someone opens it is usually the tail rather than
 * the head: what is barely moving, or which cashier is at the bottom.
 */

const TITLES: Record<DetailDimension, string> = {
  products: 'All products',
  departments: 'All departments',
  cashiers: 'All cashiers',
}

export function DetailModal({
  dimension,
  range,
  onClose,
}: {
  /** The list to show, or null when closed. */
  dimension: DetailDimension | null
  range: DateRange
  onClose: () => void
}) {
  const [rows, setRows] = useState<RankedRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Guards against a slow response for an old range landing after a fast one
  // for the current range and overwriting it.
  const requestId = useRef(0)

  useEffect(() => {
    if (!dimension) return
    const id = ++requestId.current
    setLoading(true)
    setError(null)
    setRows([])

    const query = new URLSearchParams({ from: range.from, to: range.to, dimension })
    fetch(`/api/dashboard/sales/detail?${query}`)
      .then(async (res) => {
        const body = await res.json()
        if (id !== requestId.current) return
        if (!res.ok) setError(body.error ?? 'Failed to load.')
        else setRows((body.rows ?? []) as RankedRow[])
      })
      .catch(() => {
        if (id === requestId.current) setError('Could not reach the server.')
      })
      .finally(() => {
        if (id === requestId.current) setLoading(false)
      })
  }, [dimension, range.from, range.to])

  const config = dimension ? TABLE_CONFIG[dimension] : null

  const description = loading
    ? 'Loading…'
    : error
      ? undefined
      : `${count(rows.length)} ${rows.length === 1 ? 'row' : 'rows'} · ${range.from} to ${range.to}`

  return (
    <Modal
      open={dimension !== null}
      onClose={onClose}
      size="lg"
      title={dimension ? TITLES[dimension] : ''}
      description={description}
    >
      {error ? (
        <EmptyState
          icon={<Icons.StatusError size={22} />}
          title="Couldn't load this list"
          hint={error}
        />
      ) : loading ? (
        <p className="py-10 text-center text-sm text-muted">Loading…</p>
      ) : config ? (
        // Tall lists scroll inside the modal so its header and the page behind
        // it stay put.
        <div className="max-h-[60vh] overflow-auto">
          <RankedTable rows={rows} config={config} />
        </div>
      ) : null}
    </Modal>
  )
}
