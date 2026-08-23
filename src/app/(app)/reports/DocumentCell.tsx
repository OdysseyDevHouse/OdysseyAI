'use client'

import { useEffect, useState, useTransition } from 'react'
import dynamic from 'next/dynamic'
import { Button, Icons, Modal, Skeleton, TextLinkButton } from '@/components/ui'
import { SaleRecord } from '@/app/(app)/sales/[id]/SaleRecord'
import type { SaleRecordSnapshot } from '@/lib/site/saleRecord'
import type { DocumentLinkKind } from '@/lib/reportBuilder/catalog'
import { reportSaleRecordAction } from './actions'

/*
 * The cash-up dialog is loaded ONLY when a cash-up cell is actually clicked.
 *
 * It is a till component that pulls in the whole declaration flow — the
 * denomination grid, the numeric pad, the shift actions. Importing it eagerly
 * would put all of that in the bundle of every report anybody opens, including
 * the ninety that have no cash-up column at all.
 *
 * `ssr: false` because it reads its own data on mount and has nothing to render
 * on the server; it is only ever mounted in response to a click.
 */
const DeclarationModal = dynamic(() => import('@/app/(pos)/pos/DeclarationModal'), {
  ssr: false,
})

/**
 * A document number in a report, as something you can open.
 *
 * ── WHY A DIALOG AND NOT A LINK ───────────────────────────────────────────
 *
 * A report is a reading surface. Somebody scanning invoice history for the odd
 * total wants to look INTO a row and carry on scanning — and navigating away
 * costs them the period, the filters, the sort and their place in 2,000 rows,
 * all to read one sale. So the record comes to the report.
 *
 * ── THE RECORD IS THE SAME ONE ────────────────────────────────────────────
 *
 * `SaleRecord` is the component the /sales/[id] page renders and the invoicing
 * screen shows the moment an invoice posts. Using it a third time here means
 * three surfaces that can never disagree about what a sale says. It was built
 * for exactly this — see its own note on being a plain, serialisable shape.
 *
 * What this does NOT bring across is the invoicing dialog's FOOTER: Cancel sale
 * and Credit sale live in InvoiceEditor, not in SaleRecord. That is the right
 * split here — a report is for reading, and a destructive action reached from a
 * row of a 2,000-row grid is a misclick waiting to happen. Open takes anybody
 * who needs to act there.
 *
 * A signed cash-up needs none of that reasoning: `DeclarationModal` already
 * renders itself read-only when the count it fetches is finalised.
 */
export function DocumentCell({
  kind,
  id,
  label,
}: {
  kind: DocumentLinkKind
  /** The record's id, from the row's sidecar key. */
  id: number
  /** What the cell shows — the document number, or the shift's id. */
  label: string
}) {
  const [open, setOpen] = useState(false)

  return (
    <>
      {/* `numeric` matches how the same value renders as plain text, so making
          a column clickable does not also change its typeface. */}
      <TextLinkButton onClick={() => setOpen(true)} className="numeric">
        {label}
      </TextLinkButton>

      {/* Mounted only once asked for — see ViewDeclarationButton, which makes
          the same call for the same reason: one closed dialog per row of a long
          report is a fetch per row of a list that is mostly scrolled past. */}
      {open &&
        (kind === 'sale' ? (
          <SaleDialog id={id} label={label} onClose={() => setOpen(false)} />
        ) : (
          <DeclarationModal
            open
            shiftId={id}
            /* A signed record needs no owner default, and this shift's till is
               not this machine's — the back office has no till at all. */
            terminalId={null}
            /* No outbox in the back office. */
            pendingSales={0}
            onClose={() => setOpen(false)}
            /* It is already signed; nothing here can finalize it again. */
            onFinalized={() => setOpen(false)}
          />
        ))}
    </>
  )
}

/**
 * The sale, fetched on open.
 *
 * Its own component so the fetch begins when the dialog mounts rather than on
 * every render of a cell that has never been clicked.
 */
function SaleDialog({
  id,
  label,
  onClose,
}: {
  id: number
  label: string
  onClose: () => void
}) {
  const [record, setRecord] = useState<SaleRecordSnapshot | null>(null)
  const [failed, setFailed] = useState(false)
  /* No toast: a failure here has a place to be SAID, in the dialog the reader
     just opened, and a toast would put the explanation somewhere other than
     where they are looking. */
  const [, startTransition] = useTransition()

  /* Fetched once, on mount — this component only exists because somebody
     clicked, so there is no "should we fetch yet" question to answer.

     In an EFFECT and not a useState initialiser: an initialiser runs during
     render, and starting a transition there is a state update inside a render,
     which React refuses ("Cannot call startTransition while rendering") and
     which left the dialog permanently empty. */
  useEffect(() => {
    let live = true
    startTransition(async () => {
      const result = await reportSaleRecordAction(id)
      if (!live) return
      if (!result) setFailed(true)
      else setRecord(result)
    })
    /* The dialog can be closed before the read lands — this component unmounts
       with it, and setting state afterwards is a leak. */
    return () => {
      live = false
    }
  }, [id, startTransition])

  return (
    <Modal
      open
      onClose={onClose}
      title={record?.documentNumber ?? label}
      description={record ? `${record.docLabel} · ${record.documentDate}` : undefined}
      /* Matches the invoicing dialog: SaleRecord is a three-column layout and
         is cramped at anything narrower. */
      size="xl"
      footer={
        <>
          {/* The way OUT of the dialog and into the sale's own screen, where
              crediting and cancelling live. A report does not carry those. */}
          {record && (
            <Button
              variant="ghost"
              onClick={() => window.open(`/sales/${id}`, '_blank', 'noopener')}
            >
              <Icons.FolderOpen size={16} />
              Open
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      {failed ? (
        /* Said plainly rather than as an empty panel. The commonest cause is
           not an error at all: a reader whose role stops at reports.view may
           read the figure and not the sale behind it. */
        <p className="text-sm text-muted">
          This sale could not be opened. It may have been deleted, or your role may not include
          reading individual sales.
        </p>
      ) : record ? (
        /* linkCredits={false}: a credit note's own record is another dialog
           away, and a link inside a dialog that navigates the page underneath
           it is how a reader loses their report. */
        <SaleRecord sale={record} linkCredits={false} />
      ) : (
        /* Shaped roughly like the record that is coming — a block of lines
           beside a stack of totals — so the dialog does not jump when it
           lands. */
        <div className="flex flex-col gap-4 md:flex-row">
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
          <div className="flex w-full flex-col gap-2 md:w-72">
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        </div>
      )}
    </Modal>
  )
}
