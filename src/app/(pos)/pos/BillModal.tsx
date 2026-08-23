'use client'

import { Modal, Button, Icons, Skeleton } from '@/components/ui'
import { BillSlip } from '@/components/pos/BillSlip'
import type { BillData } from '@/lib/billData'

/**
 * The pro-forma bill, on the till.
 *
 * ── WHY THIS DOES NOT NAVIGATE TO THE BACK OFFICE ─────────────────────────
 *
 * Printing a bill used to open /sales/[id]/bill in a new tab — an `(app)` route,
 * so it arrived wearing the whole back office: sidebar, topbar, store switcher.
 * A waiter asking for a bill mid-service got the office, and the till they were
 * standing at was now behind a second tab with a half-scanned basket in it.
 *
 * The same argument `ReprintModal` records, and the one `DeclarationModal`
 * states as the rule: the POS is one screen that never navigates, because
 * sending a cashier away abandons whatever is on the till.
 *
 * ── WHY THE SLIP IS RENDERED HERE RATHER THAN LINKED ──────────────────────
 *
 * `BillSlip` is a plain component over `BillData` with no server imports — the
 * same object the thermal renderer takes — so showing the bill costs one action
 * returning data, and the paper and the screen cannot disagree about what is on
 * the tab. See `billDataAction`.
 *
 * ── WHY PRINTING IS THE BRIDGE, THEN THE ROUTE ────────────────────────────
 *
 * `window.print()` is deliberately NOT offered. This dialog is a native
 * `<dialog>` in the top layer and the `(pos)` layout carries no print
 * stylesheet, so printing from here would put the whole till on paper. A till
 * with a thermal printer prints through the bridge; one without falls back to
 * the print route, which lives in the bare `(print)` group and is the only
 * place laid out for paper.
 */
export function BillModal({
  open,
  bill,
  loading,
  printing,
  onClose,
  onPrint,
}: {
  open: boolean
  /** Null while the tab is still being fetched, or if it could not be read. */
  bill: BillData | null
  loading: boolean
  printing: boolean
  onClose: () => void
  /** Prints it. The shell owns the bridge-or-route decision. */
  onPrint: (bill: BillData) => void
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="The bill"
      description="A pro-forma for the table. Nothing has been paid yet."
      size="md"
      titleMedia={
        <span className="flex size-8 items-center justify-center rounded-pill bg-brand-soft text-brand">
          <Icons.Receipt size={18} />
        </span>
      }
      footer={
        <>
          <Button variant="secondary" size="touch" onClick={onClose}>
            Close
          </Button>
          <Button
            variant="primary"
            size="touch"
            disabled={!bill || loading || printing}
            onClick={() => bill && onPrint(bill)}
          >
            <Icons.Printer size={18} />
            {printing ? 'Printing…' : 'Print'}
          </Button>
        </>
      }
    >
      {loading || !bill ? (
        /* The slip's own shape, not a spinner: the dialog is already the right
           size for a bill, so filling it keeps the Print button from jumping
           down the screen the moment the data lands. */
        <div className="flex flex-col gap-2">
          <Skeleton className="h-16 w-full rounded-card" />
          <Skeleton className="h-10 w-full rounded-card" />
          <Skeleton className="h-40 w-full rounded-card" />
        </div>
      ) : (
        <BillSlip bill={bill} />
      )}
    </Modal>
  )
}
