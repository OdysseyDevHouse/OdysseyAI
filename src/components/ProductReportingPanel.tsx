'use client'

import { useState, useTransition } from 'react'
import {
  Badge,
  Button,
  Callout,
  Card,
  EmptyState,
  Modal,
  Skeleton,
} from '@/components/ui'
import ReportGrid from '@/app/(app)/reports/ReportGrid'
import {
  runProductReportAction,
  type ProductReportResult,
} from '@/app/(app)/products/actions'

export type ProductReportChoice = {
  id: string
  name: string
  description: string
}

/**
 * The Reporting tab: this product's own history, without leaving it.
 *
 * Every report opens in a DIALOG rather than navigating. That is not decoration
 * — the product screen is a form holding unsaved edits, and sending someone to
 * /reports to look at a figure would throw away whatever they had typed. They
 * read it, close it, and carry on editing.
 *
 * The reports themselves are ordinary builder specs run by the ordinary engine
 * (see lib/reportBuilder/productReports.ts). Nothing here knows any SQL.
 */
export default function ProductReportingPanel({
  productId,
  reports,
  priceHistory,
}: {
  productId: number
  /** The reports this user may run. Already filtered by capability server-side. */
  reports: ProductReportChoice[]
  /** The existing price-history card, moved onto this tab. */
  priceHistory?: React.ReactNode
}) {
  const [open, setOpen] = useState<ProductReportChoice | null>(null)
  const [result, setResult] = useState<ProductReportResult | null>(null)
  const [loading, startRun] = useTransition()

  function run(report: ProductReportChoice) {
    setOpen(report)
    setResult(null)
    startRun(async () => {
      setResult(await runProductReportAction(productId, report.id))
    })
  }

  return (
    <div className="flex flex-col gap-4">
      {priceHistory}

      <Card>
        <div className="flex flex-col gap-4 p-6">
          <p className="text-sm text-muted">
            This product&apos;s own history. Each one opens here — nothing you have typed
            on the other tabs is lost.
          </p>

          {reports.length === 0 ? (
            <EmptyState
              title="No reports available"
              hint="These reports read sales, stock and purchasing data. Ask an administrator for access to see them."
            />
          ) : (
            /* A grid of tiles rather than a list: ten reports read as a menu to
               choose from, and a ten-row list of buttons reads as a form. */
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {reports.map((report) => (
                /* data-kit-ok: a tile whose whole surface is the target, with a
                   name and an explanation stacked — a kit Button is a single
                   line of label and would hide the description that makes these
                   ten distinguishable. */
                <button
                  key={report.id}
                  data-kit-ok
                  type="button"
                  onClick={() => run(report)}
                  className="flex flex-col gap-0.5 rounded-card border border-border bg-surface p-3 text-left transition hover:border-brand hover:bg-brand-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
                >
                  <span className="text-sm font-medium text-ink">{report.name}</span>
                  <span className="text-xs text-muted">{report.description}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </Card>

      <Modal
        open={open !== null}
        onClose={() => setOpen(null)}
        title={open?.name ?? 'Report'}
        description={open?.description}
        size="xl"
        footer={
          <Button type="button" variant="ghost" onClick={() => setOpen(null)}>
            Close
          </Button>
        }
      >
        {loading || result === null ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-9" />
            <Skeleton className="h-9" />
            <Skeleton className="h-9" />
            <Skeleton className="h-9" />
          </div>
        ) : !result.ok ? (
          <Callout tone="danger" title="This report could not be run">
            {result.error}
          </Callout>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
              <Badge>
                {result.range.from} → {result.range.to}
              </Badge>
              {result.truncated && (
                <Badge tone="warning">Showing the first {result.rows.length} rows only</Badge>
              )}
            </div>

            {/* The grid scrolls inside the dialog rather than fighting it: a
                Modal body caps at 60vh, so a long report inside an unbounded
                table would push its own footer off the screen. */}
            <div className="max-h-[52vh] overflow-auto">
              <ReportGrid
                columns={result.columns}
                rows={result.rows}
                totals={result.totals}
                emptyHint="Nothing in this period. Try a different one from the Reports screen."
              />
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
